// AI layer over OpenRouter (one key, every model).
// - JSON tasks: response_format json_schema (strict) generated from zod, validated with zod, one repair retry
// - Long-form text: writer model
// - AI-search answers: web plugin {id:"web"} with a cheap search backend (Parallel "fast", $0.001/search);
//   Perplexity models search natively. Citations read from message.annotations[].url_citation
// Set GEO_LLM=mock (or leave OPENROUTER_API_KEY unset) to run offline with deterministic output.
// Defaults are budget models; set GEO_MODEL_* / GEO_ENGINE_* in .env to upgrade any job.
import { z } from "zod";
import { HttpError } from "./http.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const env = (k, d) => process.env[k] || d;

export const MODELS = {
  writer: env("GEO_MODEL_WRITER", "anthropic/claude-haiku-5.5"),
  fast: env("GEO_MODEL_FAST", "anthropic/claude-haiku-5.5"),
  research: env("GEO_MODEL_RESEARCH", "anthropic/claude-haiku-5.5"),
};
/** AI-search engines tracked for visibility. Each answers with live web search. */
export const ENGINES = {
  chatgpt: { label: "ChatGPT", model: env("GEO_ENGINE_CHATGPT", "openai/gpt-5-nano") },
  claude: { label: "Claude", model: env("GEO_ENGINE_CLAUDE", "anthropic/claude-haiku-5.5") },
  gemini: { label: "Gemini", model: env("GEO_ENGINE_GEMINI", "google/gemini-2.5-flash-lite") },
  perplexity: { label: "Perplexity", model: env("GEO_ENGINE_PERPLEXITY", "perplexity/sonar") },
};
const SEARCH_ENGINE = env("GEO_SEARCH_ENGINE", "parallel"); // parallel | exa | native | firecrawl | perplexity
const SEARCH_MODE = env("GEO_SEARCH_MODE", SEARCH_ENGINE === "parallel" ? "fast" : "");

/** Running AI spend (USD, from OpenRouter usage.cost) since the server started. */
export const spend = { totalUsd: 0, calls: 0, byModel: {} };
function track(model, usage) {
  const c = Number(usage?.cost) || 0;
  spend.totalUsd += c; spend.calls++;
  const m = (spend.byModel[model] ||= { usd: 0, calls: 0 }); m.usd += c; m.calls++;
}
export const MODEL = MODELS.writer;

export function isMock() {
  if (process.env.GEO_LLM === "mock" || process.argv.includes("--mock")) return true;
  return !process.env.OPENROUTER_API_KEY;
}

/* ---------------- transport ---------------- */
const TRANSIENT = new Set(["AI_UNREACHABLE", "AI_RATE_LIMITED", "AI_ERROR", "AI_EMPTY"]);
/** Retries transient failures (network, 429, 5xx, empty answers) with backoff: 2s, 6s. */
async function chat(opts) {
  for (let attempt = 0; ; attempt++) {
    try { return await chatOnce(opts); }
    catch (e) {
      if (attempt >= 2 || !TRANSIENT.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 3 ** attempt));
    }
  }
}
async function chatOnce({ model, messages, maxTokens = 8000, responseFormat, plugins, requireParameters = false, timeoutMs = 240_000 }) {
  const body = { model, messages, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;
  if (plugins) body.plugins = plugins;
  if (requireParameters) body.provider = { require_parameters: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST", signal: ctrl.signal,
      headers: {
        authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": env("PUBLIC_BASE_URL", "http://localhost:3000"),
        "X-OpenRouter-Title": "GeoGrowth",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new HttpError(503, e.name === "AbortError" ? "The AI took too long to respond. Retrying shortly." : "Could not reach the AI provider.", "AI_UNREACHABLE");
  } finally { clearTimeout(timer); }

  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    if (res.status === 401) throw new HttpError(503, "AI is not configured: the OpenRouter key was rejected.", "AI_NOT_CONFIGURED");
    if (res.status === 402) throw new HttpError(402, "OpenRouter credits are exhausted. Add credits or raise the key limit.", "AI_NO_CREDITS");
    if (res.status === 429) throw new HttpError(429, "The AI provider is rate limiting requests. Retrying shortly.", "AI_RATE_LIMITED");
    if (res.status === 400) throw new HttpError(502, `The AI request was rejected (${model}): ${msg}`, "AI_BAD_REQUEST");
    throw new HttpError(502, `AI provider error ${res.status} (${model}): ${msg}`, "AI_ERROR");
  }
  const choice = data?.choices?.[0];
  if (!choice) throw new HttpError(502, `The AI returned no answer (${model}).`, "AI_EMPTY");
  if (choice.error) throw new HttpError(502, `AI error (${model}): ${choice.error.message || "unknown"}`, "AI_ERROR");
  if (choice.finish_reason === "content_filter") throw new HttpError(422, "The AI declined this request.", "AI_REFUSED");
  track(model, data.usage);
  return { content: typeof choice.message?.content === "string" ? choice.message.content : "", annotations: choice.message?.annotations || [], finish: choice.finish_reason, usage: data.usage };
}

/* ---------------- JSON schema from zod (strict-mode friendly) ---------------- */
function strictify(node) {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) if (k !== "$schema") out[k] = strictify(v);
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}
const jsonSchemaOf = (schema) => strictify(z.toJSONSchema(schema));

function extractJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/), end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch { /* fall through */ } }
  return undefined;
}

/** Structured JSON output validated against a zod schema. */
export async function generateJson({ system, prompt, schema, maxTokens = 8000, model = MODELS.fast, mock }) {
  if (isMock()) return schema.parse(await mock());
  const jsonSchema = jsonSchemaOf(schema);
  const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
  let r = await chat({ model, messages, maxTokens, requireParameters: true, responseFormat: { type: "json_schema", json_schema: { name: "result", strict: true, schema: jsonSchema } } });
  let parsed = schema.safeParse(extractJson(r.content));
  if (!parsed.success) {
    // one repair attempt: show the schema and the invalid output
    r = await chat({ model, maxTokens, messages: [...messages, { role: "assistant", content: r.content || "(empty)" }, { role: "user", content: `That was not valid. Reply with only JSON matching this JSON Schema:\n${JSON.stringify(jsonSchema)}` }] });
    parsed = schema.safeParse(extractJson(r.content));
  }
  if (!parsed.success) throw new HttpError(502, "The AI returned an unexpected format. Please retry.", "AI_PARSE_FAILED");
  return parsed.data;
}

/** Long-form text (articles). */
export async function generateText({ system, prompt, maxTokens = 16000, model = MODELS.writer, mock }) {
  if (isMock()) return await mock();
  const r = await chat({ model, maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] });
  if (r.finish === "length") throw new HttpError(502, "The AI response was cut off. Please retry.", "AI_TRUNCATED");
  if (!r.content.trim()) throw new HttpError(502, "The AI returned an empty response.", "AI_EMPTY");
  return r.content;
}

/** Ask like an AI-search user, with live web search. Returns { answer, sources[] }. */
export async function askWithWebSearch({ prompt, system, model = MODELS.research, maxResults = 5, mock }) {
  if (isMock()) return await mock();
  const messages = system ? [{ role: "system", content: system }, { role: "user", content: prompt }] : [{ role: "user", content: prompt }];
  // Perplexity models search natively (no plugin needed). Others use the configured backend;
  // "native" is not used by default: it is costly and did not fire for Anthropic models via OpenRouter.
  const plugins = model.startsWith("perplexity/") ? undefined
    : [{ id: "web", max_results: maxResults, ...(SEARCH_ENGINE !== "native" ? { engine: SEARCH_ENGINE } : {}), ...(SEARCH_MODE ? { mode: SEARCH_MODE } : {}) }];
  const r = await chat({ model, messages, maxTokens: 3000, plugins });
  const sources = new Map();
  for (const a of r.annotations) {
    const c = a?.url_citation;
    if (a?.type !== "url_citation" || !c?.url) continue;
    let url = c.url, title = c.title || c.url;
    // Gemini grounding returns redirect URLs; its title carries the real domain.
    if (/vertexaisearch\.cloud\.google\.com/.test(url) && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) url = "https://" + title.toLowerCase() + "/";
    if (!sources.has(url)) sources.set(url, title);
  }
  for (const m of r.content.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (!sources.has(m[1])) sources.set(m[1], m[1]);
  return { answer: r.content.trim(), sources: [...sources].map(([url, title]) => ({ url, title })) };
}

/* Deterministic helper for mock mode */
export function seeded(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}
