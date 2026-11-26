// Free SEO tools (public). Reference endpoints under /seotools/*.
import { requireOrigin, safeFetch, tryFetch, extract, robotsBlocks, readSitemap, hostOf } from "../crawl.js";
import { bad, str } from "../http.js";

function requireUrl(raw) {
  const v = String(raw || "").trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : "https://" + v); } catch { throw bad("Please enter a valid URL."); }
  requireOrigin(u.origin);
  return u.toString();
}
async function page(raw) {
  const url = requireUrl(raw);
  const r = await safeFetch(url);
  return { url: r.url, status: r.status, x: extract(r.text), html: r.text };
}

export async function robotsTxtChecker(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const r = await tryFetch(origin + "/robots.txt", { maxBytes: 512 * 1024 });
  const exists = !!r && r.status < 400 && !/<html/i.test(r.text);
  const txt = exists ? r.text : "";
  const bots = ["Googlebot", "Bingbot", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "CCBot"];
  return { data: { url: origin + "/robots.txt", exists, content: txt.slice(0, 20000), sitemaps: [...txt.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]), bots: bots.map((b) => ({ bot: b, allowed: !robotsBlocks(txt, b) })) } };
}

export async function sitemapChecker(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const sm = await readSitemap(origin, 1000);
  return { data: { found: !!sm.sitemapUrl, sitemapUrl: sm.sitemapUrl, urlCount: sm.urls.length, sample: sm.urls.slice(0, 25) } };
}

export async function h1Checker(ctx) {
  const { url, x } = await page(ctx.body.url);
  const issues = [];
  if (!x.h1s.length) issues.push("No H1 found.");
  if (x.h1s.length > 1) issues.push(`${x.h1s.length} H1 tags found; use one.`);
  if (x.h1s[0] && x.h1s[0].length > 70) issues.push("H1 is longer than 70 characters.");
  return { data: { url, h1s: x.h1s, h2Count: x.h2s.length, issues, pass: !issues.length } };
}

export async function metaDescriptionChecker(ctx) {
  const { url, x } = await page(ctx.body.url);
  const len = x.description.length;
  const issues = [];
  if (!len) issues.push("Missing meta description.");
  else if (len < 70) issues.push("Too short (under 70 characters).");
  else if (len > 165) issues.push("Too long (over 165 characters); it may be truncated.");
  return { data: { url, title: x.title, metaDescription: x.description, length: len, issues, pass: !issues.length } };
}

export async function canonicalChecker(ctx) {
  const { url, x } = await page(ctx.body.url);
  let selfReferencing = false;
  try { selfReferencing = !!x.canonical && new URL(x.canonical, url).toString().replace(/\/$/, "") === url.replace(/\/$/, ""); } catch { /* ignore */ }
  return { data: { url, canonical: x.canonical || null, present: !!x.canonical, selfReferencing } };
}

export async function openGraphChecker(ctx) {
  const { url, x } = await page(ctx.body.url);
  return { data: { url, ogTitle: x.ogTitle, ogDescription: x.ogDesc, ogImage: x.ogImage, ogSiteName: x.ogSite, complete: !!(x.ogTitle && x.ogDesc && x.ogImage) } };
}

function validateLlms(text) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  if (!/^#\s+\S/.test(lines.find((l) => l.trim()) || "")) issues.push("Must start with an H1 title (# Name).");
  if (!lines.some((l) => /^>\s+\S/.test(l))) issues.push("Add a > blockquote summary under the title.");
  const links = [...text.matchAll(/^\s*-\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gm)];
  if (!links.length) issues.push("Add sections (## ...) with - [Title](url): description links.");
  return { valid: !issues.length, issues, sections: (text.match(/^##\s+.+$/gm) || []).map((s) => s.slice(3)), linkCount: links.length };
}
export async function llmsTxtValidator(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const r = await tryFetch(origin + "/llms.txt", { maxBytes: 512 * 1024 });
  if (!r || r.status >= 400 || /<html/i.test(r.text)) return { data: { found: false, valid: false, issues: ["No /llms.txt found."] } };
  return { data: { found: true, ...validateLlms(r.text) } };
}
export const llmsTxtValidatorText = (ctx) => ({ data: validateLlms(str(ctx.body.text, 200000)) });

export async function llmsTxtGenerator(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const home = await safeFetch(origin + "/");
  const x = extract(home.text);
  const sm = await readSitemap(origin, 60);
  const pages = await Promise.all(sm.urls.slice(0, 25).map(async (u) => { const r = await tryFetch(u, { maxBytes: 512 * 1024 }); if (!r || r.status >= 400) return null; const e = extract(r.text); return { url: u, title: e.title || u, desc: e.description }; }));
  const name = x.ogSite || x.title.split(/\s[|\-–—:·]\s/)[0] || hostOf(origin);
  const body = `# ${name}\n\n> ${x.description || x.ogDesc || "Website of " + name}\n\n## Pages\n\n${pages.filter(Boolean).map((p) => `- [${p.title}](${p.url})${p.desc ? `: ${p.desc}` : ""}`).join("\n") || `- [Home](${origin}/)`}\n`;
  return { data: { content: body } };
}

export async function keywordDensityChecker(ctx) {
  const { url, x } = await page(ctx.body.url);
  return { data: { url, ...density(x.text) } };
}
export const keywordDensityText = (ctx) => ({ data: density(str(ctx.body.text, 200000)) });
const STOP = new Set("the and for are but not you with this that from have has was were will your our they their them what when where which who how can all any also into more most other some such than then there these those very just about over only own same so too out off one two been being does did doing would should could a an of to in on at by is it be as or if we he she his her its i me my".split(" "));
function density(text) {
  const words = text.toLowerCase().split(/[^a-z0-9À-ɏ']+/).filter((w) => w.length > 2 && !STOP.has(w));
  const counts = new Map();
  for (let i = 0; i < words.length; i++) {
    for (const n of [1, 2, 3]) {
      if (i + n > words.length) continue;
      const k = words.slice(i, i + n).join(" ");
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const total = words.length || 1;
  const top = (n) => [...counts].filter(([k]) => k.split(" ").length === n).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, c]) => ({ keyword: k, count: c, density: Math.round((c / total) * 10000) / 100 }));
  return { totalWords: words.length, single: top(1), twoWord: top(2), threeWord: top(3) };
}

export async function seoCompetitorAnalysis(ctx) {
  const urls = (Array.isArray(ctx.body.urls) ? ctx.body.urls : [ctx.body.url, ctx.body.competitorUrl]).filter(Boolean).slice(0, 4);
  if (urls.length < 2) throw bad("Provide your URL and at least one competitor URL.");
  const rows = await Promise.all(urls.map(async (u) => {
    try { const { url, x } = await page(u); return { url, title: x.title, metaDescription: x.description, h1: x.h1s[0] || null, words: x.words, headings: x.headings, schemaTypes: x.ldTypes, hasFaqSchema: x.ldTypes.some((t) => /FAQPage/i.test(t)) }; }
    catch (e) { return { url: u, error: e.message }; }
  }));
  return { data: rows };
}
