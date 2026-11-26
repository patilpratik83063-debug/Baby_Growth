// SSRF-safe website fetching and HTML fact extraction.
import dns from "node:dns/promises";
import net from "node:net";
import { HttpError } from "./http.js";

const UA = "GeoGrowthBot/2.0 (+https://localhost/bot)";
const FETCH_TIMEOUT = 12_000;

export function normalizeUrlToOrigin(raw) {
  let v = String(raw || "").trim().toLowerCase();
  if (!v) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = "https://" + v;
  try { const u = new URL(v); return (u.protocol === "http:" || u.protocol === "https:") ? u.origin : ""; } catch { return ""; }
}
export const isValidHost = (h) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(h);
export function requireOrigin(raw) {
  const o = normalizeUrlToOrigin(raw);
  if (!o || !isValidHost(new URL(o).hostname)) throw new HttpError(400, "Please enter a valid website URL.", "INVALID_URL");
  return o;
}
export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}
export async function assertPublic(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "Only http(s) URLs are supported.");
  if (u.port && !["80", "443"].includes(u.port)) throw new HttpError(400, "Only standard web ports are allowed.");
  if (!isValidHost(u.hostname)) throw new HttpError(400, "Enter a public website domain.");
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new HttpError(422, "That domain could not be found.", "DNS_NOT_FOUND"); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, "That address is not a public website.");
}

export async function checkDns(raw) {
  const origin = requireOrigin(raw);
  try { await assertPublic(origin); return { valid: true, url: origin }; }
  catch (e) { return { valid: false, url: origin, reason: e.message }; }
}

/** Fetch a public URL, re-validating every redirect hop. */
export async function safeFetch(url, { maxBytes = 2 * 1024 * 1024, redirects = 4, method = "GET" } = {}) {
  let current = url;
  for (let hop = 0; hop <= redirects; hop++) {
    await assertPublic(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    let res;
    const t0 = Date.now();
    try {
      res = await fetch(current, { method, redirect: "manual", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5" } });
    } catch (e) {
      clearTimeout(timer);
      throw new HttpError(422, e.name === "AbortError" ? "The website took too long to respond." : "Could not connect to that website.", "FETCH_FAILED");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      current = new URL(res.headers.get("location"), current).toString();
      continue;
    }
    const parts = []; let total = 0;
    if (res.body && method !== "HEAD") {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { ctrl.abort(); break; }
        parts.push(Buffer.from(value));
      }
    }
    clearTimeout(timer);
    return { status: res.status, url: current, headers: res.headers, text: Buffer.concat(parts).toString("utf8"), ms: Date.now() - t0 };
  }
  throw new HttpError(422, "Too many redirects.");
}

export const tryFetch = (url, opts) => safeFetch(url, opts).catch(() => null);

/* ---------------- HTML extraction ---------------- */
export const decode = (s) => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
function metaContent(html, attr, name) {
  const tag = html.match(new RegExp(`<meta[^>]+${attr}\\s*=\\s*["']${name}["'][^>]*>`, "i"));
  if (!tag) return "";
  const c = tag[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? decode(c[1]) : "";
}
export function extract(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description = metaContent(html, "name", "description");
  const ogTitle = metaContent(html, "property", "og:title");
  const ogDesc = metaContent(html, "property", "og:description");
  const ogSite = metaContent(html, "property", "og:site_name");
  const ogImage = metaContent(html, "property", "og:image");
  const themeColor = metaContent(html, "name", "theme-color");
  const h1s = [...html.matchAll(/<h1[\s>][\s\S]*?<\/h1>/gi)].map((m) => decode(m[0].replace(/<[^>]+>/g, " "))).filter(Boolean);
  const h2s = [...html.matchAll(/<h2[\s>][\s\S]*?<\/h2>/gi)].map((m) => decode(m[0].replace(/<[^>]+>/g, " "))).filter(Boolean);
  const lang = (html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  const canonicalTag = html.match(/<link[^>]+rel\s*=\s*["']canonical["'][^>]*>/i);
  const canonical = canonicalTag ? ((canonicalTag[0].match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || "") : "";
  const viewport = /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html);
  const robotsMeta = metaContent(html, "name", "robots");
  const ldBlocks = [...html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const ldTypes = new Set();
  for (const b of ldBlocks) {
    try {
      const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === "object") { const t = n["@type"]; (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => ldTypes.add(String(x))); Object.values(n).forEach(walk); } };
      walk(JSON.parse(b));
    } catch { /* invalid block */ }
  }
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " "));
  const words = text ? text.split(" ").length : 0;
  const headings = (html.match(/<h[23][\s>]/gi) || []).length;
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imgsNoAlt = imgs.filter((t) => !/\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
  return { title, description, ogTitle, ogDesc, ogSite, ogImage, themeColor, h1s, h2s, lang, canonical, viewport, robotsMeta, ldBlocks: ldBlocks.length, ldTypes: [...ldTypes], text, words, headings, imgs: imgs.length, imgsNoAlt, links };
}

/* ---------------- Platform detection ---------------- */
export function detectPlatformFromHtml(html, headers) {
  const h = (k) => (headers?.get?.(k) || "").toLowerCase();
  const gen = (html.match(/<meta[^>]+name\s*=\s*["']generator["'][^>]+content\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
  const checks = [
    ["wordpress", /wp-content\/|wp-includes\/|wp-json/i.test(html) || /wordpress/i.test(gen)],
    ["shopify", /cdn\.shopify\.com|Shopify\.theme/i.test(html) || h("x-shopid") !== ""],
    ["wix", /static\.wixstatic\.com|wix\.com/i.test(html) || /wix/i.test(gen)],
    ["webflow", /webflow\.(js|com)|data-wf-page/i.test(html) || /webflow/i.test(gen)],
    ["squarespace", /squarespace(-cdn)?\.com/i.test(html)],
    ["framer", /framerusercontent\.com|framer\.(com|website)/i.test(html)],
    ["ghost", /ghost\.(io|org)|content="Ghost/i.test(html) || /ghost/i.test(gen)],
    ["hubspot", /js\.hs-scripts\.com|hubspot/i.test(html)],
    ["nextjs", /\/_next\/static\//.test(html) || h("x-powered-by").includes("next.js")],
  ];
  const hit = checks.find(([, ok]) => ok);
  return { platform: hit ? hit[0] : "custom", generator: gen || null };
}

/* ---------------- Brand colours ---------------- */
export function extractBrandColors(html) {
  const counts = new Map();
  const add = (c, w = 1) => {
    c = c.toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(c)) c = "#" + [...c.slice(1)].map((x) => x + x).join("");
    if (!/^#[0-9a-f]{6}$/.test(c)) return;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 28) return; // skip greys / black / white
    counts.set(c, (counts.get(c) || 0) + w);
  };
  const theme = (html.match(/<meta[^>]+name\s*=\s*["']theme-color["'][^>]+content\s*=\s*["'](#[0-9a-f]{3,6})["']/i) || [])[1];
  if (theme) add(theme, 50);
  for (const m of html.matchAll(/--[a-z0-9-]*(?:primary|brand|accent|main)[a-z0-9-]*\s*:\s*(#[0-9a-f]{3,6})\b/gi)) add(m[1], 10);
  for (const m of html.matchAll(/(?:background(?:-color)?|color|fill|border-color)\s*:\s*(#[0-9a-f]{3,6})\b/gi)) add(m[1], 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return { brandColor: ranked[0] || null, brandSecondaryColor: ranked[1] || null, candidates: ranked.slice(0, 6) };
}

/* ---------------- Sitemap ---------------- */
export async function readSitemap(origin, limit = 300) {
  const robots = await tryFetch(origin + "/robots.txt", { maxBytes: 256 * 1024 });
  const declared = robots && robots.status < 400 ? [...robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]) : [];
  const queue = [...new Set([...declared, origin + "/sitemap.xml", origin + "/sitemap_index.xml"])].slice(0, 5);
  const urls = new Set(); const seen = new Set(); let sitemapUrl = null;
  while (queue.length && urls.size < limit && seen.size < 12) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    const r = await tryFetch(sm, { maxBytes: 4 * 1024 * 1024 });
    if (!r || r.status >= 400 || !/<(urlset|sitemapindex)/i.test(r.text)) continue;
    sitemapUrl ||= sm;
    const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
    if (/<sitemapindex/i.test(r.text)) queue.push(...locs.slice(0, 8));
    else for (const l of locs) { if (hostOf(l) === hostOf(origin)) urls.add(l); if (urls.size >= limit) break; }
  }
  return { sitemapUrl, urls: [...urls] };
}

/** robots.txt: is a user agent disallowed from "/"? */
export function robotsBlocks(robots, agent) {
  const groups = []; let cur = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && (k === "disallow" || k === "allow")) cur.rules.push([k, v]);
  }
  const pick = groups.find((g) => g.agents.includes(agent.toLowerCase())) || groups.find((g) => g.agents.includes("*"));
  if (!pick) return false;
  return !pick.rules.some(([k, v]) => k === "allow" && v === "/") && pick.rules.some(([k, v]) => k === "disallow" && v === "/");
}
