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

/* ---------------- brand matching ----------------
   "SuperYou by Ranveer Singh" must match "SuperYou", "Super You", "superyou.in" and "SUPERYOU". */
const squash = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ऀ-ॿ]+/g, "");
export function brandAliases(brand, domain) {
  const set = new Set();
  const add = (s) => { const q = squash(s); if (q.length >= 3) set.add(q); };
  add(brand);
  add(String(brand || "").split(/\s+(?:by|from|-|–|—|\||:|·)\s+/i)[0]);       // "SuperYou by Ranveer Singh" -> "SuperYou"
  add(String(brand || "").replace(/\b(inc|llc|ltd|pvt|private|limited|co|company|corp|gmbh)\b\.?/gi, ""));
  if (domain) { add(domain); add(domain.split(".")[0]); }                      // "superyou.in", "superyou"
  return [...set];
}
const isGenericAlias = (a) => a.length < 4 || ["shop", "store", "online", "official", "home", "best", "app"].includes(a);
export function textMentions(text, aliases) {
  const t = squash(text);
  return aliases.some((a) => !isGenericAlias(a) && t.includes(a));
}
const sameBrand = (name, domain, aliases) => textMentions(name, aliases) || (!!domain && textMentions(domain, aliases));

async function analyzeAnswer({ answer, sources, brand, domain, competitors, aliases }) {
  const result = await generateJson({
    system: "You analyze AI assistant answers for brand visibility. List the companies, brands or products the answer recommends or names as options, in order of first appearance. Exclude retailers and marketplaces (Amazon, Flipkart, Walmart, quick-commerce apps), publications, review sites, forums and social networks unless they are themselves the product being recommended.",
    prompt: `Target brand: ${brand} (${domain}; also written as: ${aliases.join(", ")})\nKnown competitors: ${competitors.join(", ") || "unknown"}\n\nAnswer:\n${answer.slice(0, 12000)}\n\nCited sources:\n${sources.map((s) => s.url).join("\n")}\n\nReturn the brands in order (name, and domain if known else empty string), whether the target brand is mentioned (any spelling), and its 1-based position in your list (0 if not mentioned).`,
    schema: AnalysisSchema,
    mock: () => {
      const rnd = seeded(answer + brand);
      const named = textMentions(answer, aliases);
      const list = competitors.slice(0, 3).map((c) => ({ name: c, domain: c }));
      if (named) list.splice(Math.floor(rnd() * (list.length + 1)), 0, { name: brand, domain });
      return { brands: list, targetMentioned: named, targetPosition: named ? list.findIndex((b) => b.name === brand) + 1 : 0 };
    },
  });
  // Ground truth over the model: the brand counts as mentioned if the answer text names it.
  const mentioned = result.targetMentioned || textMentions(answer, aliases);
  let position = result.targetPosition || 0;
  const idx = result.brands.findIndex((b) => sameBrand(b.name, b.domain, aliases));
  if (idx >= 0) position = idx + 1;
  if (mentioned && idx < 0) { result.brands.push({ name: brand, domain }); position = position || result.brands.length; }
  return { brands: result.brands, mentioned, position: mentioned ? position || null : null };
}

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

async function runPrompt({ websiteId, promptId, prompt, brand, domain, competitors, aliases }) {
  const engines = Object.keys(ENGINES);
  const results = await Promise.all(engines.map(async (engine) => {
    const res = await askEngine(engine, prompt, { brand, domain, competitors });
    if (res.error) { console.error(`[visibility] ${engine}: ${res.error}`); return { engine, error: res.error }; }
    try {
      const a = await analyzeAnswer({ answer: res.answer, sources: res.sources, brand, domain, competitors, aliases });
      run("INSERT INTO visibility_runs (id, prompt_id, website_id, engine, answer, mentioned, position, brands, sources, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        uid(), promptId, websiteId, engine, res.answer.slice(0, 20000), a.mentioned ? 1 : 0, a.position, JSON.stringify(a.brands.slice(0, 20)), JSON.stringify(res.sources.slice(0, 30)), now());
      return { engine, mentioned: a.mentioned, position: a.position };
    } catch (e) { return { engine, error: e.message }; }
  }));
  const ok = results.filter((r) => !r.error);
  if (!ok.length) throw new HttpError(502, "All AI engines failed: " + results[0].error, "AI_ERROR");
  return ok;
}

export function siteContext(website) {
  const p = parse(website.profile, {});
  const brand = p.brandName || hostOf(website.url), domain = hostOf(website.url);
  return { brand, domain, aliases: brandAliases(brand, domain), competitors: parse(website.competitors, []).map(hostOf).filter(Boolean) };
}

/** Run async fn over items with limited concurrency. */
async function pool(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const PromptsSchema = z.object({ prompts: z.array(z.string()) });
async function suggestPrompts(profile, url, n = 8) {
  const locations = (profile.targetLocations || []).join(", ");
  const { prompts } = await generateJson({
    system: "You write the questions real buyers type into ChatGPT, Claude, Gemini and Perplexity when looking for a product or service like this one. Never include the brand name. Questions must be about the business's actual category, not adjacent ones.",
    prompt: `Business: ${profile.description || url}\nIndustry: ${profile.industry || ""}\nProducts/services: ${(profile.mainServices || []).join("; ")}\nAudience: ${(profile.targetAudience || []).join("; ")}\nLocations: ${locations || "global"}\nLanguage: ${profile.selectedLanguage || "en"}\n\nWrite ${n} distinct, natural prompts: "best X for Y", recommendation, comparison and problem-led questions.${locations ? ` Most prompts should name the location (${locations}) the way a local buyer would.` : ""} Prefer specific prompts the business could realistically win over very broad ones.`,
    schema: PromptsSchema,
    mock: () => ({ prompts: (profile.mainServices?.length ? profile.mainServices : [profile.industry || "service"]).slice(0, n).map((s) => `What is the best ${String(s).toLowerCase()} provider?`) }),
  });
  return prompts.map((p) => p.trim()).filter(Boolean).slice(0, n);
}

/** Brand-awareness prompts: does AI know the brand at all, and how does it compare it? */
function brandPrompts(profile, url) {
  const brand = String(profile.brandName || hostOf(url)).split(/\s+(?:by|from)\s+/i)[0];
  const category = (profile.mainServices || [])[0] || profile.industry || "this category";
  return [`What is ${brand} (${hostOf(url)}) and is it any good?`, `${brand} vs alternatives for ${String(category).toLowerCase()}: which should I choose?`];
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
  return { id: p.id, prompt: p.prompt, kind: p.kind || "discovery", active: !!p.active, createdAt: p.created_at, lastRunAt: lastAt || null,
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
  const { aliases } = siteContext(ctx.website);
  const kind = textMentions(prompt, aliases) ? "brand" : "discovery"; // a prompt naming the brand measures awareness, not discovery
  run("INSERT INTO visibility_prompts (id, website_id, prompt, kind, created_at) VALUES (?,?,?,?,?)", id, ctx.website.id, prompt, kind, now());
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
export function runNow(ctx) {
  const pending = one("SELECT id FROM jobs WHERE type = 'visibility.run' AND website_id = ? AND status IN ('queued','running') LIMIT 1", ctx.website.id);
  if (pending) return { data: { id: pending.id, status: "queued", alreadyRunning: true } };
  return { data: enqueue("visibility.run", {}, { websiteId: ctx.website.id }) };
}

const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
// Mention rate = discovery prompts only (unbranded buyer questions). Brand prompts measure awareness separately.
const KIND_JOIN = "FROM visibility_runs r JOIN visibility_prompts p ON p.id = r.prompt_id";
const rate = (n, m) => (n ? Math.round((m / n) * 100) : null);

export function overallInsights(ctx) {
  const days = Math.min(365, parseInt(ctx.query.days, 10) || 30);
  const id = ctx.website.id;
  const d = one(`SELECT COUNT(*) n, SUM(r.mentioned) m, AVG(r.position) pos ${KIND_JOIN} WHERE r.website_id = ? AND p.kind = 'discovery' AND r.created_at >= ?`, id, since(days));
  const prev = one(`SELECT COUNT(*) n, SUM(r.mentioned) m ${KIND_JOIN} WHERE r.website_id = ? AND p.kind = 'discovery' AND r.created_at >= ? AND r.created_at < ?`, id, since(days * 2), since(days));
  const b = one(`SELECT COUNT(*) n, SUM(r.mentioned) m ${KIND_JOIN} WHERE r.website_id = ? AND p.kind = 'brand' AND r.created_at >= ?`, id, since(days));
  const all30 = one("SELECT COUNT(*) n FROM visibility_runs WHERE website_id = ? AND created_at >= ?", id, since(days)).n;
  const { brand } = siteContext(ctx.website);
  const brands = brandCounts(id, days, "discovery");
  const totalMentions = brands.reduce((s, x) => s + x.mentions, 0);
  const own = brands.filter((x) => x.isYou).reduce((s, x) => s + x.mentions, 0);
  const byEngine = Object.keys(ENGINES).map((engine) => {
    const e = one(`SELECT COUNT(*) n, SUM(r.mentioned) m, AVG(r.position) pos ${KIND_JOIN} WHERE r.website_id = ? AND r.engine = ? AND p.kind = 'discovery' AND r.created_at >= ?`, id, engine, since(days));
    return { engine, label: engineLabel(engine), runs: e.n, mentionRate: rate(e.n, e.m), averagePosition: e.pos ? Math.round(e.pos * 10) / 10 : null };
  });
  const pending = !!one("SELECT 1 FROM jobs WHERE type = 'visibility.run' AND website_id = ? AND status IN ('queued','running')", id);
  return { data: {
    brand, runs: all30, discoveryRuns: d.n, mentionRate: rate(d.n, d.m) ?? 0, previousMentionRate: rate(prev.n, prev.m),
    averagePosition: d.pos ? Math.round(d.pos * 10) / 10 : null, shareOfVoice: totalMentions ? Math.round((own / totalMentions) * 100) : 0,
    brandAwareness: rate(b.n, b.m), brandRuns: b.n, engines: Object.values(ENGINES).map((e) => e.label), byEngine,
    topCompetitors: brands.filter((x) => !x.isYou).slice(0, 5), pending,
  } };
}
function brandCounts(websiteId, days, kind) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  const { aliases } = siteContext(w);
  const counts = new Map();
  const rows = kind ? all(`SELECT r.brands ${KIND_JOIN} WHERE r.website_id = ? AND p.kind = ? AND r.created_at >= ?`, websiteId, kind, since(days))
    : all("SELECT brands FROM visibility_runs WHERE website_id = ? AND created_at >= ?", websiteId, since(days));
  for (const r of rows) {
    const seen = new Set(); // count a brand once per answer
    for (const b of parse(r.brands, [])) {
      const isYou = sameBrand(b.name, b.domain, aliases);
      const key = isYou ? "__you" : (hostOf(b.domain ? "https://" + String(b.domain).replace(/^https?:\/\//, "") : "") || squash(b.name));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = counts.get(key) || { name: b.name, domain: b.domain || null, mentions: 0, isYou };
      cur.mentions++; counts.set(key, cur);
    }
  }
  return [...counts.values()].sort((a, b) => b.mentions - a.mentions).slice(0, 25);
}

/** Turn a prompt you're losing into a content-plan topic that targets it. */
const TopicSchema = z.object({ title: z.string(), keyword: z.string(), articleType: z.enum(["how-to", "listicle", "comparison", "guide", "glossary", "business-page", "research"]) });
export async function createContentForPrompt(ctx) {
  const p = ownedPrompt(ctx);
  const prof = parse(ctx.website.profile, {});
  const winners = brandCounts(ctx.website.id, 90).filter((b) => !b.isYou).slice(0, 5).map((b) => b.name);
  const t = await generateJson({
    system: "You are an SEO and GEO strategist. Plan one article that would make AI assistants cite and recommend this brand for the given question.",
    prompt: `Question buyers ask AI: "${p.prompt}"\nBrand: ${prof.brandName || hostOf(ctx.website.url)}\nWhat they offer: ${prof.description || ""}\nCurrently recommended instead: ${winners.join(", ") || "unknown"}\nLanguage: ${prof.selectedLanguage || "en"}\n\nReturn an article title (under 70 chars) that directly answers the question, its primary keyword, and the article type.`,
    schema: TopicSchema,
    mock: () => ({ title: p.prompt.replace(/\?$/, "").slice(0, 68), keyword: p.prompt.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 5).join(" "), articleType: "guide" }),
  });
  const id = uid();
  const date = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  run("INSERT INTO content_plan (id, website_id, scheduled_for, title, keyword, search_intent, article_type, secondary_keywords, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, ctx.website.id, date, t.title.slice(0, 200), t.keyword.slice(0, 120), "commercial", t.articleType, JSON.stringify([p.prompt.slice(0, 120)]), now());
  logActivity(ctx.website.id, "content_plan", `Planned "${t.title}" to win the AI prompt "${p.prompt.slice(0, 80)}".`);
  return { data: { id, title: t.title, keyword: t.keyword, scheduledFor: date } };
}
export const brandsMentioned = (ctx) => ({ data: brandCounts(ctx.website.id, Math.min(365, parseInt(ctx.query.days, 10) || 30), "discovery") });

export function topSources(ctx) {
  const counts = new Map();
  for (const r of all("SELECT sources FROM visibility_runs WHERE website_id = ? AND created_at >= ?", ctx.website.id, since(30))) {
    for (const s of parse(r.sources, [])) { const d = hostOf(s.url); if (!d) continue; const c = counts.get(d) || { domain: d, citations: 0, exampleUrl: s.url }; c.citations++; counts.set(d, c); }
  }
  return { data: [...counts.values()].sort((a, b) => b.citations - a.citations).slice(0, 25) };
}
export function history(ctx) {
  const rows = all(`SELECT substr(r.created_at,1,10) day, COUNT(*) n, SUM(r.mentioned) m, AVG(r.position) pos ${KIND_JOIN} WHERE r.website_id = ? AND p.kind = 'discovery' AND r.created_at >= ? GROUP BY day ORDER BY day`, ctx.website.id, since(Math.min(365, parseInt(ctx.query.days, 10) || 90)));
  return { data: rows.map((r) => ({ date: r.day, runs: r.n, mentionRate: Math.round((r.m / r.n) * 100), averagePosition: r.pos ? Math.round(r.pos * 10) / 10 : null })) };
}

/* ---------------- jobs ---------------- */
export async function jobSeed(_p, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  if (one("SELECT 1 FROM visibility_prompts WHERE website_id = ? LIMIT 1", websiteId)) return { skipped: true };
  const profile = parse(w.profile, {});
  if (!profile.description) return { skipped: true, reason: "no business description yet" }; // don't track prompts for an unknown business
  const limit = planLimits(w.org_id).prompts;
  const branded = brandPrompts(profile, w.url).slice(0, limit >= 6 ? 2 : 1);
  const discovery = await suggestPrompts(profile, w.url, Math.max(3, Math.min(8, limit - branded.length - 2))); // leave room for the user's own prompts
  for (const p of discovery) run("INSERT INTO visibility_prompts (id, website_id, prompt, kind, created_at) VALUES (?,?,?,?,?)", uid(), websiteId, p, "discovery", now());
  for (const p of branded) run("INSERT INTO visibility_prompts (id, website_id, prompt, kind, created_at) VALUES (?,?,?,?,?)", uid(), websiteId, p, "brand", now());
  enqueue("visibility.run", {}, { websiteId });
  return { prompts: discovery.length + branded.length };
}
export async function jobRun({ promptIds }, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  const ctx = siteContext(w);
  const prompts = promptIds?.length
    ? all(`SELECT * FROM visibility_prompts WHERE website_id = ? AND id IN (${promptIds.map(() => "?").join(",")})`, websiteId, ...promptIds)
    : all("SELECT * FROM visibility_prompts WHERE website_id = ? AND active = 1", websiteId);
  let mentioned = 0, total = 0, failed = 0;
  await pool(prompts, 3, async (p) => {
    try { for (const r of await runPrompt({ websiteId, promptId: p.id, prompt: p.prompt, ...ctx })) { total++; if (r.mentioned) mentioned++; } }
    catch (e) { failed++; console.error(`[visibility] prompt failed: ${e.message}`); }
  });
  if (!total && failed) throw new HttpError(502, "AI visibility check failed for every prompt.", "AI_ERROR");
  if (total) logActivity(websiteId, "visibility", `Checked ${prompts.length} AI search prompts: mentioned in ${mentioned} of ${total} answers.`);
  return { total, mentioned, failed };
}

/** Re-score stored answers with alias matching (fixes earlier false negatives like "SuperYou" vs "SuperYou by Ranveer Singh"). */
export function rescoreStoredRuns() {
  let fixed = 0;
  for (const w of all("SELECT * FROM websites")) {
    const { aliases } = siteContext(w);
    for (const r of all("SELECT id, answer, brands FROM visibility_runs WHERE website_id = ? AND mentioned = 0", w.id)) {
      if (!textMentions(r.answer, aliases)) continue;
      const brands = parse(r.brands, []);
      const idx = brands.findIndex((b) => sameBrand(b.name, b.domain, aliases));
      run("UPDATE visibility_runs SET mentioned = 1, position = ? WHERE id = ?", idx >= 0 ? idx + 1 : null, r.id);
      fixed++;
    }
    for (const p of all("SELECT id, prompt FROM visibility_prompts WHERE website_id = ? AND kind = 'discovery'", w.id))
      if (textMentions(p.prompt, aliases)) run("UPDATE visibility_prompts SET kind = 'brand' WHERE id = ?", p.id);
  }
  if (fixed) console.log(`[visibility] re-scored ${fixed} stored answers that named the brand`);
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
    const domain = hostOf(a.website_url), brand = info.brandName || domain, aliases = brandAliases(brand, domain);
    const engines = Object.keys(ENGINES);
    const results = (await pool(prompts.flatMap((prompt) => engines.map((engine) => ({ prompt, engine }))), 6, async ({ prompt, engine }) => {
      const res = await askEngine(engine, prompt, { brand, domain, competitors: [] });
      if (res.error) return null;
      try {
        const an = await analyzeAnswer({ answer: res.answer, sources: res.sources, brand, domain, competitors: [], aliases });
        return { prompt, engine: engineLabel(engine), mentioned: an.mentioned, position: an.position,
          competitors: an.brands.filter((b) => !sameBrand(b.name, b.domain, aliases)).slice(0, 5).map((b) => b.name), sources: res.sources.slice(0, 5) };
      } catch { return null; }
    })).filter(Boolean);
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
