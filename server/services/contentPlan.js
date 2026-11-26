// Content plan: keyword-led monthly plan generated from the business profile and competitors.
// Reference endpoints: GET /content-plan, /organization/content-strategy-preview.
import { z } from "zod";
import { one, all, run, uid, now, parse, logActivity } from "../db.js";
import { bad, notFound, str, strArr } from "../http.js";
import { generateJson, seeded, MODELS } from "../llm.js";
import { hostOf } from "../crawl.js";
import { enqueue } from "./jobs.js";

const ARTICLE_TYPES = ["how-to", "listicle", "comparison", "guide", "glossary", "business-page", "research"];
const PlanSchema = z.object({
  items: z.array(z.object({
    title: z.string(),
    keyword: z.string(),
    searchIntent: z.enum(["informational", "commercial", "transactional", "navigational"]),
    articleType: z.enum(ARTICLE_TYPES),
    secondaryKeywords: z.array(z.string()),
  })),
});

const planDto = (r) => ({
  id: r.id, scheduledFor: r.scheduled_for, title: r.title, keyword: r.keyword, searchIntent: r.search_intent,
  articleType: r.article_type, secondaryKeywords: parse(r.secondary_keywords, []), status: r.status, articleId: r.article_id,
});

async function ideate(website, count) {
  const p = parse(website.profile, {});
  const existing = all("SELECT title FROM content_plan WHERE website_id = ? ORDER BY created_at DESC LIMIT 120", website.id).map((r) => r.title);
  const pages = (p.knownPages || []).slice(0, 80).map((u) => { try { return new URL(u).pathname; } catch { return u; } });
  const competitors = parse(website.competitors, []);
  const lang = p.selectedLanguage || "en";
  const { items } = await generateJson({
    system: "You are a senior SEO and generative-engine-optimization strategist. You plan articles that win Google rankings and get cited by AI assistants (ChatGPT, Claude, Gemini, Perplexity). Favor specific, answerable topics with clear search intent over generic ones.",
    prompt: `Plan ${count} new articles for ${website.url}.
Brand: ${p.brandName || hostOf(website.url)}
What they offer: ${p.description || "unknown"}
Industry: ${p.industry || "unknown"}
Audience: ${(p.targetAudience || []).join("; ") || "unknown"}
Products/services: ${(p.mainServices || []).join("; ") || "unknown"}
Locations: ${(p.targetLocations || []).join(", ") || "global"}
Competitors: ${competitors.map(hostOf).join(", ") || "unknown"}
Write titles and keywords in language "${lang}"${p.englishType ? ` (${p.englishType} English)` : ""}.

Mix intents: mostly informational and commercial, a few comparison/listicle pieces against competitors' topics, and at least one business page per 10 articles.
Each item: title (compelling, under 70 chars), primary keyword (2-5 words, realistic search query), search intent, article type, 3-6 secondary keywords.
Do not repeat these existing titles:\n${existing.join("\n") || "(none)"}
Existing site pages (avoid cannibalizing):\n${pages.join("\n") || "(unknown)"}`,
    schema: PlanSchema, model: MODELS.research,
    mock: () => {
      const rnd = seeded(website.url + existing.length);
      const topics = (p.mainServices?.length ? p.mainServices : [p.industry || "your industry"]);
      const patterns = [
        ["How to choose the right {t}", "how to choose {t}", "how-to", "informational"],
        ["{t}: a complete guide for 2026", "{t} guide", "guide", "informational"],
        ["Best {t} options compared", "best {t}", "comparison", "commercial"],
        ["10 {t} mistakes to avoid", "{t} mistakes", "listicle", "informational"],
        ["What is {t}? Definition and examples", "what is {t}", "glossary", "informational"],
        ["{t} pricing explained", "{t} pricing", "business-page", "commercial"],
        ["{t} statistics and trends", "{t} statistics", "research", "informational"],
      ];
      return { items: Array.from({ length: count }, (_, i) => {
        const t = topics[Math.floor(rnd() * topics.length)].toLowerCase();
        const [title, kw, type, intent] = patterns[(i + existing.length) % patterns.length];
        return { title: title.replace("{t}", t).replace(/^./, (c) => c.toUpperCase()) + (i >= patterns.length ? ` (${i + 1})` : ""), keyword: kw.replace("{t}", t), searchIntent: intent, articleType: type, secondaryKeywords: [`${t} tips`, `${t} cost`, `${t} near me`] };
      }) };
    },
  });
  return items;
}

/** Spread N items across upcoming days according to articles_per_week. */
function schedule(website, n) {
  const perWeek = Math.max(1, website.articles_per_week || 3);
  const gapDays = 7 / perWeek;
  const last = one("SELECT MAX(scheduled_for) d FROM content_plan WHERE website_id = ? AND status != 'skipped'", website.id)?.d;
  const start = Math.max(Date.now() + 864e5, last ? new Date(last).getTime() + gapDays * 864e5 : 0);
  return Array.from({ length: n }, (_, i) => new Date(start + Math.round(i * gapDays) * 864e5).toISOString().slice(0, 10));
}

export async function generatePlan(websiteId, { days = 30 } = {}) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  if (!w) throw notFound("Website not found.");
  const count = Math.min(40, Math.max(3, Math.round(((w.articles_per_week || 3) * days) / 7)));
  const items = await ideate(w, count);
  const dates = schedule(w, items.length);
  const t = now();
  items.forEach((it, i) => run(
    "INSERT INTO content_plan (id, website_id, scheduled_for, title, keyword, search_intent, article_type, secondary_keywords, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    uid(), websiteId, dates[i], it.title.slice(0, 200), it.keyword.slice(0, 120), it.searchIntent, it.articleType, JSON.stringify(it.secondaryKeywords.slice(0, 8)), t,
  ));
  logActivity(websiteId, "content_plan", `Planned ${items.length} new articles.`);
  return { created: items.length };
}

/* ---------------- API ---------------- */
export function getPlan(ctx) {
  const from = str(ctx.query.from, 10), to = str(ctx.query.to, 10);
  const rows = all(`SELECT * FROM content_plan WHERE website_id = ? AND status != 'skipped' ${from ? "AND scheduled_for >= ?" : ""} ${to ? "AND scheduled_for <= ?" : ""} ORDER BY scheduled_for LIMIT 300`,
    ctx.website.id, ...[from, to].filter(Boolean));
  return { data: rows.map(planDto) };
}

export function regeneratePlan(ctx) {
  const days = Math.min(90, Math.max(7, parseInt(ctx.body.days, 10) || 30));
  return { data: enqueue("content_plan.generate", { days }, { websiteId: ctx.website.id }) };
}

function planItem(ctx) {
  const r = one("SELECT * FROM content_plan WHERE id = ? AND website_id = ?", ctx.params.id, ctx.website.id);
  if (!r) throw notFound("Plan item not found.");
  return r;
}

export function updatePlanItem(ctx) {
  const r = planItem(ctx);
  if (r.status !== "planned") throw bad("Only planned items can be edited.");
  const date = str(ctx.body.scheduledFor, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad("Invalid date.");
  run("UPDATE content_plan SET title = ?, keyword = ?, scheduled_for = ?, article_type = ?, secondary_keywords = ? WHERE id = ?",
    str(ctx.body.title, 200) || r.title, str(ctx.body.keyword, 120) || r.keyword, date || r.scheduled_for,
    ARTICLE_TYPES.includes(ctx.body.articleType) ? ctx.body.articleType : r.article_type,
    "secondaryKeywords" in ctx.body ? JSON.stringify(strArr(ctx.body.secondaryKeywords, 8, 80)) : r.secondary_keywords, r.id);
  return { data: planDto(one("SELECT * FROM content_plan WHERE id = ?", r.id)) };
}

export function skipPlanItem(ctx) {
  const r = planItem(ctx);
  run("UPDATE content_plan SET status = 'skipped' WHERE id = ?", r.id);
  return { data: { ok: true } };
}

export function addPlanItem(ctx) {
  const title = str(ctx.body.title, 200), keyword = str(ctx.body.keyword, 120);
  if (!title || !keyword) throw bad("Title and keyword are required.");
  const id = uid();
  run("INSERT INTO content_plan (id, website_id, scheduled_for, title, keyword, search_intent, article_type, secondary_keywords, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, ctx.website.id, str(ctx.body.scheduledFor, 10) || schedule(ctx.website, 1)[0], title, keyword, "informational",
    ARTICLE_TYPES.includes(ctx.body.articleType) ? ctx.body.articleType : "guide", JSON.stringify(strArr(ctx.body.secondaryKeywords, 8, 80)), now());
  return { data: planDto(one("SELECT * FROM content_plan WHERE id = ?", id)) };
}

export function generateNow(ctx) {
  const r = planItem(ctx);
  if (!["planned", "failed"].includes(r.status)) throw bad("This article is already generated or in progress.");
  run("UPDATE content_plan SET status = 'generating' WHERE id = ?", r.id);
  return { data: enqueue("article.generate", { planId: r.id }, { websiteId: ctx.website.id }) };
}

export async function strategyPreview(ctx) {
  const items = await ideate(ctx.website, 6);
  return { data: items };
}

export const jobGeneratePlan = (payload, websiteId) => generatePlan(websiteId, payload);
