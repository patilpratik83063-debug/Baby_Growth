// Publishing integrations: WordPress (REST + application password), signed webhook (any stack), hosted blog.
// Reference endpoints: /integrations, /integrations/detect-platform, /integrations/published-urls/recheck, /hosted-blog/config.
import { createCipheriv, createDecipheriv, randomBytes, createHmac, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { one, all, run, uid, now, parse, logActivity } from "../db.js";
import { HttpError, bad, notFound, str } from "../http.js";
import { assertPublic, hostOf, normalizeUrlToOrigin, tryFetch } from "../crawl.js";
import { esc } from "../markdown.js";
import { articleHtmlDocument } from "./articles.js";
import { markLive } from "./backlinks.js";

/* ---------------- secrets at rest (AES-256-GCM) ---------------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(process.env.DATA_DIR || path.join(here, "..", "..", "data"), "secret.key");
const KEY = (() => {
  if (process.env.SECRET_KEY) return createHash("sha256").update(process.env.SECRET_KEY).digest();
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "hex");
})();
const seal = (obj) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", KEY, iv); const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]); return "v1:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64"); };
const open = (s) => { if (!s?.startsWith("v1:")) return parse(s, {}); const b = Buffer.from(s.slice(3), "base64"); const d = createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")); };

export const PUBLIC_BASE_URL = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
const TYPES = ["wordpress", "webhook", "hosted"];

const integrationDto = (i) => {
  const c = open(i.config);
  const safe = i.type === "wordpress" ? { siteUrl: c.siteUrl, username: c.username, postStatus: c.postStatus } : i.type === "webhook" ? { url: c.url } : { blogUrl: `${PUBLIC_BASE_URL()}/blog/${i.website_id}` };
  return { id: i.id, type: i.type, status: i.status, lastError: i.last_error, config: safe, createdAt: i.created_at };
};

/* ---------------- outbound requests ---------------- */
async function postJson(url, body, headers = {}) {
  await assertPublic(url);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { method: "POST", redirect: "error", signal: ctrl.signal, headers: { "content-type": "application/json", "user-agent": "GeoGrowth/2.0", ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: parse(text, text.slice(0, 500)) };
  } catch (e) {
    throw new HttpError(502, e.name === "AbortError" ? "The destination took too long to respond." : "Could not reach the destination.", "PUBLISH_UNREACHABLE");
  } finally { clearTimeout(t); }
}

async function publishWordPress(cfg, article, doc) {
  const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.applicationPassword}`).toString("base64");
  const r = await postJson(`${cfg.siteUrl}/wp-json/wp/v2/posts`, {
    title: article.title, content: article.html, excerpt: article.meta_description, slug: article.slug, status: cfg.postStatus || "publish",
  }, { authorization: auth });
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "WordPress rejected the credentials. Use an application password for an Editor or Admin user.", "WP_AUTH");
  if (r.status >= 300) throw new HttpError(502, `WordPress returned HTTP ${r.status}: ${r.body?.message || ""}`.trim(), "WP_ERROR");
  return r.body?.link || `${cfg.siteUrl}/?p=${r.body?.id}`;
}

async function publishWebhook(cfg, article, doc, website) {
  const payload = {
    event: "article.published", sentAt: now(),
    website: { id: website.id, url: website.url },
    article: { id: article.id, title: article.title, slug: article.slug, metaDescription: article.meta_description, keyword: article.keyword,
      markdown: article.markdown, html: article.html, faq: parse(article.faq, []), jsonLd: parse(article.json_ld, null), coverImageUrl: `${PUBLIC_BASE_URL()}/media/covers/${article.id}.svg`, fullHtmlDocument: doc },
  };
  const sig = createHmac("sha256", cfg.secret).update(JSON.stringify(payload)).digest("hex");
  const r = await postJson(cfg.url, payload, { "x-geogrowth-signature": `sha256=${sig}` });
  if (r.status >= 300) throw new HttpError(502, `Webhook returned HTTP ${r.status}.`, "WEBHOOK_ERROR");
  return (r.body && typeof r.body === "object" && r.body.url) || null;
}

export async function publishArticle(articleId) {
  const a = one("SELECT * FROM articles WHERE id = ?", articleId);
  if (!a) throw notFound("Article not found.");
  const website = one("SELECT * FROM websites WHERE id = ?", a.website_id);
  const integ = one("SELECT * FROM integrations WHERE website_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", website.id)
    || { type: "hosted", id: null, config: "{}" };
  const doc = articleHtmlDocument(a, website);
  let url;
  try {
    const cfg = open(integ.config);
    if (integ.type === "wordpress") url = await publishWordPress(cfg, a, doc);
    else if (integ.type === "webhook") url = await publishWebhook(cfg, a, doc, website);
    url ||= `${PUBLIC_BASE_URL()}/blog/${website.id}/${a.slug}`;
    if (integ.id) run("UPDATE integrations SET last_error = NULL WHERE id = ?", integ.id);
  } catch (e) {
    if (integ.id) run("UPDATE integrations SET last_error = ? WHERE id = ?", e.message, integ.id);
    logActivity(website.id, "publish_failed", `Could not publish "${a.title}": ${e.message}`);
    throw e;
  }
  const t = now();
  const ld = parse(a.json_ld, {}); if (ld["@graph"]?.[0]) { ld["@graph"][0].mainEntityOfPage = url; ld["@graph"][0].datePublished = t; }
  run("UPDATE articles SET status = 'published', published_url = ?, published_at = ?, json_ld = ?, updated_at = ? WHERE id = ?", url, t, JSON.stringify(ld), t, a.id);
  run("UPDATE content_plan SET status = 'published' WHERE article_id = ?", a.id);
  markLive(a.id);
  logActivity(website.id, "published", `Published "${a.title}".`);
  return { url };
}

/* ---------------- API ---------------- */
export const listIntegrations = (ctx) => ({ data: all("SELECT * FROM integrations WHERE website_id = ? ORDER BY created_at", ctx.website.id).map(integrationDto) });

export async function createIntegration(ctx) {
  const type = str(ctx.body.type, 20);
  if (!TYPES.includes(type)) throw bad("Unsupported integration type.");
  const c = ctx.body.config || {};
  let cfg;
  if (type === "wordpress") {
    const siteUrl = normalizeUrlToOrigin(c.siteUrl);
    if (!siteUrl || !str(c.username) || !str(c.applicationPassword)) throw bad("Site URL, username and application password are required.");
    cfg = { siteUrl, username: str(c.username, 100), applicationPassword: str(c.applicationPassword, 200).replace(/\s+/g, " "), postStatus: c.postStatus === "draft" ? "draft" : "publish" };
    const auth = "Basic " + Buffer.from(`${cfg.username}:${cfg.applicationPassword}`).toString("base64");
    await assertPublic(siteUrl);
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, { headers: { authorization: auth }, redirect: "error" }).catch(() => null);
    if (!res || res.status >= 400) throw bad("Could not verify the WordPress credentials (check the URL and application password).", "WP_AUTH");
  } else if (type === "webhook") {
    let url; try { url = new URL(str(c.url, 500)); } catch { throw bad("Enter a valid webhook URL."); }
    if (url.protocol !== "https:") throw bad("Webhook URL must use https.");
    await assertPublic(url.toString());
    cfg = { url: url.toString(), secret: randomBytes(24).toString("hex") };
  } else cfg = {};
  run("UPDATE integrations SET status = 'inactive' WHERE website_id = ?", ctx.website.id); // one active destination at a time
  const id = uid();
  run("INSERT INTO integrations (id, website_id, type, config, status, created_at) VALUES (?,?,?,?,?,?)", id, ctx.website.id, type, seal(cfg), "active", now());
  run("UPDATE websites SET platform = COALESCE(platform, ?) WHERE id = ?", type, ctx.website.id);
  const dto = integrationDto(one("SELECT * FROM integrations WHERE id = ?", id));
  if (type === "webhook") dto.config.secret = cfg.secret; // shown once, for signature verification
  return { data: dto };
}

export function deleteIntegration(ctx) {
  const r = run("DELETE FROM integrations WHERE id = ? AND website_id = ?", ctx.params.id, ctx.website.id);
  if (!r.changes) throw notFound("Integration not found.");
  return { data: { ok: true } };
}

export async function publishNow(ctx) {
  const a = one("SELECT id FROM articles WHERE id = ? AND website_id = ?", ctx.params.id, ctx.website.id);
  if (!a) throw notFound("Article not found.");
  return { data: await publishArticle(a.id) };
}

export async function recheckPublishedUrls(ctx) {
  const rows = all("SELECT id, published_url FROM articles WHERE website_id = ? AND status = 'published' AND published_url IS NOT NULL LIMIT 50", ctx.website.id);
  const results = [];
  for (const r of rows) {
    if (r.published_url.startsWith(PUBLIC_BASE_URL())) { results.push({ id: r.id, url: r.published_url, ok: true }); continue; }
    const res = await tryFetch(r.published_url, { method: "HEAD" });
    results.push({ id: r.id, url: r.published_url, ok: !!res && res.status < 400, status: res?.status ?? null });
  }
  return { data: results };
}

export const hostedBlogConfig = (ctx) => ({ data: { blogUrl: `${PUBLIC_BASE_URL()}/blog/${ctx.website.id}`, enabled: true } });

/* ---------------- hosted blog pages ---------------- */
function page(website, title, body, extraHead = "") {
  const p = parse(website.profile, {});
  const color = /^#[0-9a-f]{6}$/i.test(p.brandColor || "") ? p.brandColor : "#f25533";
  return `<!doctype html><html lang="${esc(p.selectedLanguage || "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${extraHead}
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#222;max-width:760px;margin:0 auto;padding:32px 20px;line-height:1.7}a{color:${color}}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:32px}header a{font-weight:700;text-decoration:none;color:#111}h1{line-height:1.2}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e5e5;padding:8px;text-align:left}blockquote{border-left:3px solid ${color};margin:0;padding-left:16px;color:#555}img{max-width:100%;border-radius:12px}.card{display:block;padding:18px 0;border-bottom:1px solid #eee;text-decoration:none;color:inherit}.card h2{margin:0 0 4px;font-size:20px;color:#111}.card p{margin:0;color:#666}</style></head>
<body><header><a href="/blog/${website.id}">${esc(p.brandName || hostOf(website.url))} blog</a><a href="${esc(website.url)}">Visit site &rarr;</a></header>${body}</body></html>`;
}

export function serveBlog(res, websiteId, slug) {
  const website = one("SELECT * FROM websites WHERE id = ?", websiteId);
  if (!website) return false;
  if (!slug) {
    const posts = all("SELECT title, slug, meta_description FROM articles WHERE website_id = ? AND status = 'published' ORDER BY published_at DESC LIMIT 100", websiteId);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(website, "Blog", `<h1>Blog</h1>${posts.map((a) => `<a class="card" href="/blog/${websiteId}/${esc(a.slug)}"><h2>${esc(a.title)}</h2><p>${esc(a.meta_description || "")}</p></a>`).join("") || "<p>No posts yet.</p>"}`));
    return true;
  }
  const a = one("SELECT * FROM articles WHERE website_id = ? AND slug = ? AND status = 'published'", websiteId, slug);
  if (!a) return false;
  const head = `<meta name="description" content="${esc(a.meta_description || "")}"><link rel="canonical" href="${esc(a.published_url || "")}">
<meta property="og:title" content="${esc(a.title)}"><meta property="og:image" content="${PUBLIC_BASE_URL()}/media/covers/${a.id}.svg">
<script type="application/ld+json">${(a.json_ld || "{}").replace(/</g, "\\u003c")}</script>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(website, a.title, `<img src="/media/covers/${a.id}.svg" alt="${esc(a.title)}"><article>${a.html}</article>`, head));
  return true;
}

export const jobPublish = ({ articleId }) => publishArticle(articleId);
