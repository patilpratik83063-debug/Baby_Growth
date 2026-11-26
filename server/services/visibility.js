// AI visibility tracking (GEO): run buyer-style prompts through AI search, record brand mentions, rank, competitors and sources.
// Reference endpoints: /llm-visibility/prompts[/:promptId], /prompt-allowance, /top-sources, /brands-mentioned,
// /overall-insights, /history; public audit: /public-llm-visibility/start, /get-data, /email.
// Engines (via OpenRouter, each with live web search): ChatGPT, Claude, Gemini, Perplexity.
import { z } from "zod";
import { one, all, run, uid, now, parse, logActivity } from "../db.js";
import { bad, notFound, str, HttpError } from "../http.js";
import { askWithWebSearch, generateJson, seeded, ENGINES } from "../llm.js";
import { hostOf, requireOrigin } from "../crawl.js";
import { analyzeBusiness } from "./onboarding.js";
import { enqueue } from "./jobs.js";
import { planLimits } from "./billing.js";

export { ENGINES };
const engineLabel = (k) => ENGINES[k]?.label || k;

const AnalysisSchema = z.object({
  brands: z.array(z.object({ name: z.string(), domain: z.string() })),
  targetMentioned: z.boolean(),
  targetPosition: z.number().int(),
});

async function analyzeAnswer({ answer, sources, brand, domain, competitors }) {
  return generateJson({
    system: "You analyze AI assistant answers for brand visibility. Extract every company/brand the answer recommends or mentions, in order of first appearance.",
    prompt: `Target brand: ${brand} (${domain})\nKnown competitors: ${competitors.join(", ") || "unknown"}\n\nAnswer:\n${answer}\n\nCited sources:\n${sources.map((s) => s.url).join("\n")}\n\nReturn the brands in order (name and domain if known, else empty string), whether the target brand is mentioned, and its 1-based position among the brands (0 if not mentioned).`,
    schema: AnalysisSchema,
    mock: () => {
      const rnd = seeded(answer + brand);
      const mentioned = rnd() > 0.45;
      const list = competitors.slice(0, 3).map((c) => ({ name: c, domain: c }));
      if (mentioned) list.splice(Math.floor(rnd() * (list.length + 1)), 0, { name: brand, domain });
      return { brands: list, targetMentioned: mentioned, targetPosition: mentioned ? list.findIndex((b) => b.name === brand) + 1 : 0 };
    },
  });
}

const mentionsBrand = (text, brand, domain) => { const t = text.toLowerCase(); return t.includes(domain) || (brand.length > 2 && t.includes(brand.toLowerCase())); };

/** Ask one engine; never throws (a failing engine is recorded as an error, the others still run). */
async function askEngine(engine, prompt, { brand, domain, competitors }) {
  try {
    return await askWithWebSearch({
      prompt, model: ENGINES[engine].model, maxResults: 3,
      system: "Answer the user's question helpfully using current web information. When recommending products, services or companies, name them.",
      mock: () => {
        const rnd = seeded(engine + prompt + domain);
        const names = [...competitors.slice(0, 2)];
        if (rnd() > 0.35) names.splice(Math.floor(rnd() * (names.length + 1)), 0, brand);
        return { answer: `For "${prompt}", ${engineLabel(engine)} suggests: ${names.join(", ") || "several providers"}. Compare pricing, reviews and support before choosing.`,
          sources: [{ url: `https://${domain}/`, title: brand }, ...competitors.slice(0, 2).map((c) => ({ url: `https://${c}/`, title: c }))] };
      },
    });
  } catch (e) {
    return { answer: "", sources: [], error: e.message };
  }
}

async function runPrompt({ websiteId, promptId, prompt, brand, domain, competitors }) {
  const engines = Object.keys(ENGINES);
  const answers = await Promise.all(engines.map((engine) => askEngine(engine, prompt, { brand, domain, competitors })));
  const results = [];
  for (let i = 0; i < engines.length; i++) {
    const engine = engines[i], res = answers[i];
    if (res.error) { console.error(`[visibility] ${engine}: ${res.error}`); results.push({ engine, error: res.error }); continue; }
    const a = await analyzeAnswer({ answer: res.answer, sources: res.sources, brand, domain, competitors });
    const mentioned = a.targetMentioned || mentionsBrand(res.answer, brand, domain);
    run("INSERT INTO visibility_runs (id, prompt_id, website_id, engine, answer, mentioned, position, brands, sources, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      uid(), promptId, websiteId, engine, res.answer.slice(0, 20000), mentioned ? 1 : 0, mentioned ? (a.targetPosition || null) : null, JSON.stringify(a.brands.slice(0, 20)), JSON.stringify(res.sources.slice(0, 30)), now());
    results.push({ engine, mentioned, position: a.targetPosition || null });
  }
  if (results.every((r) => r.error)) throw new HttpError(502, "All AI engines failed: " + results[0].error, "AI_ERROR");
  return results.filter((r) => !r.error);
}

function siteContext(website) {
  const p = parse(website.profile, {});
  return { brand: p.brandName || hostOf(website.url), domain: hostOf(website.url), competitors: parse(website.competitors, []).map(hostOf).filter(Boolean) };
}

const PromptsSchema = z.object({ prompts: z.array(z.string()) });
async function suggestPrompts(profile, url, n = 8) {
  const { prompts } = await generateJson({
    system: "You write the questions real buyers type into ChatGPT, Claude, Gemini and Perplexity when looking for a product or service. Never include the brand name.",
    prompt: `Business: ${profile.description || url}\nIndustry: ${profile.industry || ""}\nServices: ${(profile.mainServices || []).join("; ")}\nAudience: ${(profile.targetAudience || []).join("; ")}\nLocations: ${(profile.targetLocations || []).join(", ") || "global"}\nLanguage: ${profile.selectedLanguage || "en"}\n\nWrite ${n} distinct, natural prompts (recommendation, comparison, "best X for Y", and problem-led questions).`,
    schema: PromptsSchema,
    mock: () => ({ prompts: (profile.mainServices?.length ? profile.mainServices : [profile.industry || "service"]).slice(0, n).map((s) => `What is the best ${String(s).toLowerCase()} provider?`) }),
  });
  return prompts.map((p) => p.trim()).filter(Boolean).slice(0, n);
}

/* ---------------- API ---------------- */
const promptDto = (p) => {
  const lastAt = one("SELECT MAX(created_at) t FROM visibility_runs WHERE prompt_id = ?", p.id).t;
  // latest batch = runs within 15 minutes of the newest run (one per engine)
  const batch = lastAt ? all("SELECT engine, mentioned, position FROM visibility_runs WHERE prompt_id = ? AND created_at >= ?", p.id, new Date(new Date(lastAt).getTime() - 15 * 60e3).toISOString()) : [];
  const latest = new Map(); for (const r of batch) latest.set(r.engine, r);
  const engines = [...latest.entries()].map(([engine, r]) => ({ engine, label: engineLabel(engine), mentioned: !!r.mentioned, position: r.position }));
  const stats = one("SELECT COUNT(*) n, SUM(mentioned) m FROM visibility_runs WHERE prompt_id = ?", p.id);
  const positions = engines.filter((e) => e.mentioned && e.position).map((e) => e.position);
  return { id: p.id, prompt: p.prompt, active: !!p.active, createdAt: p.created_at, lastRunAt: lastAt || null,
    lastMentioned: engines.length ? engines.some((e) => e.mentioned) : null, lastPosition: positions.length ? Math.min(...positions) : null,
    mentionedBy: engines.filter((e) => e.mentioned).length, enginesChecked: engines.length, engines,
    mentionRate: stats.n ? Math.round((stats.m / stats.n) * 100) : null };
};

export function allowance(ctx) {
  const used = one("SELECT COUNT(*) n FROM visibility_prompts WHERE website_id = ?", ctx.website.id).n;
  const limit = planLimits(ctx.org.id).prompts;
  return { data: { limit, used, remaining: Math.max(0, limit - used) } };
}
export const listPrompts = (ctx) => ({ data: all("SELECT * FROM visibility_prompts WHERE website_id = ? ORDER BY created_at", ctx.website.id).map(promptDto) });

export function createPrompt(ctx) {
  const prompt = str(ctx.body.prompt, 400);
  if (prompt.length < 8) throw bad("Write a full question (at least 8 characters).");
  if (allowance(ctx).data.remaining <= 0) throw new HttpError(402, "You've reached your plan's prompt limit.", "PROMPT_LIMIT");
  const id = uid();
  run("INSERT INTO visibility_prompts (id, website_id, prompt, created_at) VALUES (?,?,?,?)", id, ctx.website.id, prompt, now());
  enqueue("visibility.run", { promptIds: [id] }, { websiteId: ctx.website.id });
  return { data: promptDto(one("SELECT * FROM visibility_prompts WHERE id = ?", id)) };
}
function ownedPrompt(ctx) {
  const p = one("SELECT * FROM visibility_prompts WHERE id = ? AND website_id = ?", ctx.params.promptId, ctx.website.id);
  if (!p) throw notFound("Prompt not found.");
  return p;
}
export function getPrompt(ctx) {
  const p = ownedPrompt(ctx);
  const runs = all("SELECT engine, answer, mentioned, position, brands, sources, created_at FROM visibility_runs WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 20", p.id)
    .map((r) => ({ ...r, mentioned: !!r.mentioned, brands: parse(r.brands, []), sources: parse(r.sources, []) }));
  return { data: { ...promptDto(p), runs } };
}
export function updatePrompt(ctx) {
  const p = ownedPrompt(ctx);
  run("UPDATE visibility_prompts SET prompt = ?, active = ? WHERE id = ?", str(ctx.body.prompt, 400) || p.prompt, "active" in ctx.body ? (ctx.body.active ? 1 : 0) : p.active, p.id);
  return { data: promptDto(one("SELECT * FROM visibility_prompts WHERE id = ?", p.id)) };
}
export function deletePrompt(ctx) {
  run("DELETE FROM visibility_prompts WHERE id = ?", ownedPrompt(ctx).id);
  return { data: { ok: true } };
}
export const runNow = (ctx) => ({ data: enqueue("visibility.run", {}, { websiteId: ctx.website.id }) });

const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
export function overallInsights(ctx) {
  const days = Math.min(365, parseInt(ctx.query.days, 10) || 30);
  const r = one("SELECT COUNT(*) n, SUM(mentioned) m, AVG(position) pos FROM visibility_runs WHERE website_id = ? AND created_at >= ?", ctx.website.id, since(days));
  const prev = one("SELECT COUNT(*) n, SUM(mentioned) m FROM visibility_runs WHERE website_id = ? AND created_at >= ? AND created_at < ?", ctx.website.id, since(days * 2), since(days));
  const { brand } = siteContext(ctx.website);
  const brands = brandCounts(ctx.website.id, days);
  const totalMentions = brands.reduce((s, b) => s + b.mentions, 0);
  const own = brands.find((b) => b.isYou)?.mentions || 0;
  const rate = r.n ? Math.round((r.m / r.n) * 100) : 0;
  const byEngine = Object.keys(ENGINES).map((engine) => {
    const e = one("SELECT COUNT(*) n, SUM(mentioned) m, AVG(position) pos FROM visibility_runs WHERE website_id = ? AND engine = ? AND created_at >= ?", ctx.website.id, engine, since(days));
    return { engine, label: engineLabel(engine), runs: e.n, mentionRate: e.n ? Math.round((e.m / e.n) * 100) : null, averagePosition: e.pos ? Math.round(e.pos * 10) / 10 : null };
  });
  return { data: { brand, runs: r.n, mentionRate: rate, previousMentionRate: prev.n ? Math.round((prev.m / prev.n) * 100) : null, averagePosition: r.pos ? Math.round(r.pos * 10) / 10 : null, shareOfVoice: totalMentions ? Math.round((own / totalMentions) * 100) : 0, engines: Object.values(ENGINES).map((e) => e.label), byEngine } };
}
function brandCounts(websiteId, days) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  const { brand, domain } = siteContext(w);
  const counts = new Map();
  for (const r of all("SELECT brands FROM visibility_runs WHERE website_id = ? AND created_at >= ?", websiteId, since(days))) {
    for (const b of parse(r.brands, [])) {
      const key = (hostOf(b.domain ? "https://" + b.domain.replace(/^https?:\/\//, "") : "") || b.name).toLowerCase();
      const cur = counts.get(key) || { name: b.name, domain: b.domain || null, mentions: 0 };
      cur.mentions++; counts.set(key, cur);
    }
  }
  return [...counts.values()].map((b) => ({ ...b, isYou: (b.domain && hostOf("https://" + String(b.domain).replace(/^https?:\/\//, "")) === domain) || b.name.toLowerCase() === brand.toLowerCase() }))
    .sort((a, b) => b.mentions - a.mentions).slice(0, 25);
}
export const brandsMentioned = (ctx) => ({ data: brandCounts(ctx.website.id, Math.min(365, parseInt(ctx.query.days, 10) || 30)) });

export function topSources(ctx) {
  const counts = new Map();
  for (const r of all("SELECT sources FROM visibility_runs WHERE website_id = ? AND created_at >= ?", ctx.website.id, since(30))) {
    for (const s of parse(r.sources, [])) { const d = hostOf(s.url); if (!d) continue; const c = counts.get(d) || { domain: d, citations: 0, exampleUrl: s.url }; c.citations++; counts.set(d, c); }
  }
  return { data: [...counts.values()].sort((a, b) => b.citations - a.citations).slice(0, 25) };
}
export function history(ctx) {
  const rows = all("SELECT substr(created_at,1,10) day, COUNT(*) n, SUM(mentioned) m, AVG(position) pos FROM visibility_runs WHERE website_id = ? AND created_at >= ? GROUP BY day ORDER BY day", ctx.website.id, since(Math.min(365, parseInt(ctx.query.days, 10) || 90)));
  return { data: rows.map((r) => ({ date: r.day, runs: r.n, mentionRate: Math.round((r.m / r.n) * 100), averagePosition: r.pos ? Math.round(r.pos * 10) / 10 : null })) };
}

/* ---------------- jobs ---------------- */
export async function jobSeed(_p, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  if (one("SELECT 1 FROM visibility_prompts WHERE website_id = ? LIMIT 1", websiteId)) return { skipped: true };
  const prompts = await suggestPrompts(parse(w.profile, {}), w.url, Math.min(8, planLimits(w.org_id).prompts));
  for (const p of prompts) run("INSERT INTO visibility_prompts (id, website_id, prompt, created_at) VALUES (?,?,?,?)", uid(), websiteId, p, now());
  enqueue("visibility.run", {}, { websiteId });
  return { prompts: prompts.length };
}
export async function jobRun({ promptIds }, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  const ctx = siteContext(w);
  const prompts = promptIds?.length
    ? all(`SELECT * FROM visibility_prompts WHERE website_id = ? AND id IN (${promptIds.map(() => "?").join(",")})`, websiteId, ...promptIds)
    : all("SELECT * FROM visibility_prompts WHERE website_id = ? AND active = 1", websiteId);
  let mentioned = 0, total = 0;
  for (const p of prompts) for (const r of await runPrompt({ websiteId, promptId: p.id, prompt: p.prompt, ...ctx })) { total++; if (r.mentioned) mentioned++; }
  if (total) logActivity(websiteId, "visibility", `Checked ${prompts.length} AI search prompts: mentioned in ${mentioned} of ${total} answers.`);
  return { total, mentioned };
}

/* ---------------- public AI search audit (lead magnet) ---------------- */
export async function publicStart(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const recent = one("SELECT * FROM public_visibility_audits WHERE website_url = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1", origin, since(1));
  if (recent && recent.status !== "failed") return { data: { websiteUrl: origin, id: recent.id, status: recent.status } };
  const id = uid();
  run("INSERT INTO public_visibility_audits (id, website_url, created_at) VALUES (?,?,?)", id, origin, now());
  enqueue("public_visibility.run", { auditId: id });
  return { data: { websiteUrl: origin, id, status: "processing" } };
}
export function publicData(ctx) {
  const origin = requireOrigin(ctx.query.websiteUrl);
  const a = one("SELECT * FROM public_visibility_audits WHERE website_url = ? ORDER BY created_at DESC LIMIT 1", origin);
  if (!a) throw notFound("No audit found for this website.");
  return { id: a.id, websiteUrl: a.website_url, status: a.status, isCompleted: a.status === "completed", error: a.error, ...(parse(a.result, {}) || {}) };
}
export function publicEmail(ctx) {
  const origin = requireOrigin(ctx.body.websiteUrl);
  const email = str(ctx.body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad("Please enter a valid email.");
  run("UPDATE public_visibility_audits SET email = ? WHERE id = (SELECT id FROM public_visibility_audits WHERE website_url = ? ORDER BY created_at DESC LIMIT 1)", email, origin);
  run("INSERT INTO form_submissions (id, kind, payload, created_at) VALUES (?,?,?,?)", uid(), "ai_search_audit", JSON.stringify({ email, websiteUrl: origin, utm: ctx.body.utm || null }), now());
  return { data: { ok: true } };
}
export async function jobPublic({ auditId }) {
  const a = one("SELECT * FROM public_visibility_audits WHERE id = ?", auditId);
  try {
    const info = await analyzeBusiness(a.website_url, "en");
    const prompts = await suggestPrompts(info, a.website_url, 3);
    const domain = hostOf(a.website_url), brand = info.brandName || domain;
    const results = [];
    for (const prompt of prompts) {
      const engines = Object.keys(ENGINES);
      const answers = await Promise.all(engines.map((engine) => askEngine(engine, prompt, { brand, domain, competitors: [] })));
      for (let i = 0; i < engines.length; i++) {
        const res = answers[i];
        if (res.error) continue;
        const an = await analyzeAnswer({ answer: res.answer, sources: res.sources, brand, domain, competitors: [] });
        const mentioned = an.targetMentioned || mentionsBrand(res.answer, brand, domain);
        results.push({ prompt, engine: engineLabel(engines[i]), mentioned, position: mentioned ? an.targetPosition || null : null,
          competitors: an.brands.filter((b) => b.name.toLowerCase() !== brand.toLowerCase()).slice(0, 5).map((b) => b.name), sources: res.sources.slice(0, 5) });
      }
    }
    if (!results.length) throw new HttpError(502, "All AI engines failed.", "AI_ERROR");
    const score = Math.round((results.filter((r) => r.mentioned).length / results.length) * 100);
    const byEngine = Object.values(ENGINES).map((e) => { const rs = results.filter((r) => r.engine === e.label); return { engine: e.label, checked: rs.length, mentioned: rs.filter((r) => r.mentioned).length }; });
    run("UPDATE public_visibility_audits SET status = 'completed', result = ? WHERE id = ?", JSON.stringify({ brand, score, engines: Object.values(ENGINES).map((e) => e.label), byEngine, results }), auditId);
    return { score };
  } catch (e) {
    run("UPDATE public_visibility_audits SET status = 'failed', error = ? WHERE id = ?", e.message, auditId);
    throw e;
  }
}
