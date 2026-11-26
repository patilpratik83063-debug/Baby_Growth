// GEO audit: AI-search readiness checks for a site, stored and shareable.
// Reference endpoints: /geo-audit/start, /geo-audit/data, /geo-audit/share-link,
// /geo-audit/public/start, /geo-audit/public/get-data, /geo-audit/public/:auditId/email, /geo-audit/public/share/:shareToken.
import { randomBytes } from "node:crypto";
import { one, run, uid, now, parse, logActivity } from "../db.js";
import { HttpError, bad, notFound, str } from "../http.js";
import { safeFetch, tryFetch, extract, robotsBlocks, requireOrigin } from "../crawl.js";
import { enqueue } from "./jobs.js";

const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"];

export async function runAudit(origin) {
  const home = await safeFetch(origin + "/");
  if (home.status >= 400) throw new HttpError(422, `The website returned HTTP ${home.status}.`);
  const finalOrigin = new URL(home.url).origin;
  const [robots, llms, sitemap] = await Promise.all([
    tryFetch(finalOrigin + "/robots.txt", { maxBytes: 256 * 1024 }),
    tryFetch(finalOrigin + "/llms.txt", { maxBytes: 256 * 1024 }),
    tryFetch(finalOrigin + "/sitemap.xml", { maxBytes: 512 * 1024 }),
  ]);
  const x = extract(home.text);
  const robotsOk = robots && robots.status < 400 && !/<html/i.test(robots.text);
  const robotsTxt = robotsOk ? robots.text : "";
  const blocked = AI_BOTS.filter((b) => robotsBlocks(robotsTxt, b));
  const hasSitemap = (sitemap && sitemap.status < 400 && /<(urlset|sitemapindex)/i.test(sitemap.text)) || /^\s*sitemap\s*:/im.test(robotsTxt);
  const hasLlms = !!(llms && llms.status < 400 && llms.text.trim().length > 20 && !/<html/i.test(llms.text));
  const noindex = /noindex/i.test(x.robotsMeta);
  const fix = (s) => s;
  const checks = [
    { id: "https", category: "technical", w: 8, label: "Served over HTTPS", pass: home.url.startsWith("https://"), detail: home.url.startsWith("https://") ? "Secure connection." : "Serve the site over HTTPS.", fix: fix("Enable HTTPS and redirect http to https.") },
    { id: "indexable", category: "technical", w: 10, label: "Homepage is indexable", pass: !noindex, detail: noindex ? "The homepage has a noindex robots meta tag." : "No noindex directive.", fix: "Remove noindex from the homepage robots meta tag." },
    { id: "ai_crawlers", category: "ai_access", w: 12, label: "AI crawlers allowed in robots.txt", pass: blocked.length === 0, detail: blocked.length ? `Blocked: ${blocked.join(", ")}.` : robotsOk ? "AI crawlers can access the site." : "No robots.txt found; crawlers are allowed by default.", fix: "Allow GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and Google-Extended in robots.txt." },
    { id: "llms_txt", category: "ai_access", w: 8, label: "llms.txt published", pass: hasLlms, detail: hasLlms ? "Found /llms.txt." : "No /llms.txt file.", fix: "Publish /llms.txt describing your key pages (use the llms.txt generator)." },
    { id: "sitemap", category: "technical", w: 8, label: "XML sitemap", pass: !!hasSitemap, detail: hasSitemap ? "Sitemap found." : "No sitemap.xml or Sitemap line in robots.txt.", fix: "Publish /sitemap.xml and reference it in robots.txt." },
    { id: "title", category: "on_page", w: 6, label: "Page title", pass: x.title.length >= 15 && x.title.length <= 65, detail: x.title ? `"${x.title.slice(0, 80)}" (${x.title.length} chars).` : "Missing <title>.", fix: "Write a 15-65 character title with your main topic and brand." },
    { id: "meta_description", category: "on_page", w: 6, label: "Meta description", pass: x.description.length >= 70 && x.description.length <= 165, detail: x.description ? `${x.description.length} characters.` : "Missing.", fix: "Write a 70-165 character description that answers what you offer." },
    { id: "h1", category: "on_page", w: 5, label: "Single clear H1", pass: x.h1s.length === 1, detail: x.h1s.length === 1 ? `"${x.h1s[0].slice(0, 80)}"` : `${x.h1s.length} H1 headings found.`, fix: "Use exactly one H1 that states what you do." },
    { id: "json_ld", category: "structured_data", w: 10, label: "Structured data (JSON-LD)", pass: x.ldBlocks > 0, detail: x.ldTypes.length ? `Types: ${x.ldTypes.slice(0, 8).join(", ")}.` : "No JSON-LD found.", fix: "Add JSON-LD (use the schema generator)." },
    { id: "entity_schema", category: "structured_data", w: 6, label: "Organization / product schema", pass: x.ldTypes.some((t) => /Organization|LocalBusiness|Corporation|Store|Product|SoftwareApplication|Service/i.test(t)), detail: "Entity schema helps AI identify your brand.", fix: "Add Organization or LocalBusiness schema with name, url, logo and sameAs." },
    { id: "faq_schema", category: "structured_data", w: 5, label: "FAQ schema", pass: x.ldTypes.some((t) => /FAQPage|QAPage/i.test(t)), detail: "FAQ markup gets you quoted in answer engines.", fix: "Add an FAQ section with FAQPage schema." },
    { id: "open_graph", category: "on_page", w: 4, label: "Open Graph tags", pass: !!(x.ogTitle && x.ogDesc), detail: x.ogTitle && x.ogDesc ? "og:title and og:description set." : "Missing og:title or og:description.", fix: "Add og:title, og:description and og:image." },
    { id: "canonical", category: "technical", w: 3, label: "Canonical URL", pass: !!x.canonical, detail: x.canonical || "No rel=canonical.", fix: "Add a rel=canonical link." },
    { id: "lang", category: "technical", w: 2, label: "Language declared", pass: !!x.lang, detail: x.lang ? `lang="${x.lang}"` : "No lang attribute.", fix: "Add lang to <html>." },
    { id: "viewport", category: "technical", w: 2, label: "Mobile viewport", pass: x.viewport, detail: x.viewport ? "Present." : "Missing.", fix: "Add a viewport meta tag." },
    { id: "content_depth", category: "content", w: 6, label: "Server-rendered content", pass: x.words >= 300, detail: `${x.words.toLocaleString()} words in the HTML${x.words < 300 ? " (thin, or rendered only by JavaScript, which many AI crawlers don't run)" : ""}.`, fix: "Render key content server-side and add substantive copy." },
    { id: "structure", category: "content", w: 4, label: "Answer-friendly structure", pass: x.headings >= 3, detail: `${x.headings} H2/H3 subheadings.`, fix: "Break content into question-led H2/H3 sections." },
    { id: "alt_text", category: "content", w: 2, label: "Image alt text", pass: x.imgs === 0 || x.imgsNoAlt / x.imgs <= 0.2, detail: x.imgs ? `${x.imgs - x.imgsNoAlt}/${x.imgs} images have alt text.` : "No images.", fix: "Add descriptive alt text to images." },
    { id: "speed", category: "technical", w: 3, label: "Fast response", pass: home.ms < 1500, detail: `Responded in ${home.ms} ms.`, fix: "Improve server response time (caching, CDN)." },
  ];
  const total = checks.reduce((s, c) => s + c.w, 0);
  const got = checks.reduce((s, c) => s + (c.pass ? c.w : 0), 0);
  const categories = {};
  for (const c of checks) { const k = c.category; categories[k] ||= { passed: 0, total: 0 }; categories[k].total++; if (c.pass) categories[k].passed++; }
  return {
    url: finalOrigin, score: Math.round((got / total) * 100), passed: checks.filter((c) => c.pass).length, total: checks.length, fetchMs: home.ms, categories,
    checks: checks.sort((a, b) => (a.pass === b.pass ? b.w - a.w : a.pass ? 1 : -1)).map(({ w, ...c }) => ({ ...c, weight: w })),
  };
}

const dto = (a) => ({ id: a.id, url: a.url, status: a.status, isCompleted: a.status === "completed", error: a.error, createdAt: a.created_at, shareToken: a.share_token, ...(parse(a.result, {}) || {}) });

/* authenticated */
export function start(ctx) {
  const id = uid();
  run("INSERT INTO geo_audits (id, website_id, url, created_at) VALUES (?,?,?,?)", id, ctx.website.id, ctx.website.url, now());
  enqueue("geo_audit.run", { auditId: id }, { websiteId: ctx.website.id });
  return { data: { id, status: "processing" } };
}
export function data(ctx) {
  const a = one("SELECT * FROM geo_audits WHERE website_id = ? ORDER BY created_at DESC LIMIT 1", ctx.website.id);
  return { data: a ? dto(a) : null };
}
export function shareLink(ctx) {
  const a = one("SELECT * FROM geo_audits WHERE website_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1", ctx.website.id);
  if (!a) throw notFound("Run an audit first.");
  const token = a.share_token || randomBytes(12).toString("base64url");
  run("UPDATE geo_audits SET share_token = ? WHERE id = ?", token, a.id);
  return { data: { shareToken: token, url: `/geo-audit/share/${token}` } };
}

/* public */
export function publicStart(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const id = uid();
  run("INSERT INTO geo_audits (id, url, is_public, created_at) VALUES (?,?,1,?)", id, origin, now());
  enqueue("geo_audit.run", { auditId: id });
  return { data: { id, status: "processing", url: origin } };
}
export function publicData(ctx) {
  const id = str(ctx.query.auditId || ctx.query.id, 64);
  const a = id ? one("SELECT * FROM geo_audits WHERE id = ? AND is_public = 1", id) : one("SELECT * FROM geo_audits WHERE url = ? AND is_public = 1 ORDER BY created_at DESC LIMIT 1", requireOrigin(ctx.query.url));
  if (!a) throw notFound("Audit not found.");
  return { data: dto(a) };
}
export function publicEmail(ctx) {
  const email = str(ctx.body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad("Please enter a valid email.");
  const r = run("UPDATE geo_audits SET email = ? WHERE id = ? AND is_public = 1", email, ctx.params.auditId);
  if (!r.changes) throw notFound("Audit not found.");
  run("INSERT INTO form_submissions (id, kind, payload, created_at) VALUES (?,?,?,?)", uid(), "geo_audit", JSON.stringify({ email, auditId: ctx.params.auditId }), now());
  return { data: { ok: true } };
}
export function publicShare(ctx) {
  const a = one("SELECT * FROM geo_audits WHERE share_token = ?", ctx.params.shareToken);
  if (!a) throw notFound("This shared audit is no longer available.");
  const d = dto(a); delete d.shareToken;
  return { data: d };
}

/** Instant audit used by the landing page (no queue). */
export async function instant(ctx) {
  return await runAudit(requireOrigin(ctx.body.url));
}

export async function jobRun({ auditId }, websiteId) {
  let a = auditId && one("SELECT * FROM geo_audits WHERE id = ?", auditId);
  if (!a && websiteId) {
    const w = one("SELECT url FROM websites WHERE id = ?", websiteId);
    const id = uid(); run("INSERT INTO geo_audits (id, website_id, url, created_at) VALUES (?,?,?,?)", id, websiteId, w.url, now());
    a = one("SELECT * FROM geo_audits WHERE id = ?", id);
  }
  try {
    const result = await runAudit(a.url);
    run("UPDATE geo_audits SET status = 'completed', result = ? WHERE id = ?", JSON.stringify(result), a.id);
    if (a.website_id) logActivity(a.website_id, "geo_audit", `GEO audit finished: score ${result.score}/100, ${result.total - result.passed} issues to fix.`);
    return { score: result.score };
  } catch (e) {
    run("UPDATE geo_audits SET status = 'failed', error = ? WHERE id = ?", e.message, a.id);
    throw e;
  }
}
