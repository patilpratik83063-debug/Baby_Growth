// Backlink exchange network: every customer site in the pool can receive contextual links
// from other customers' articles, matched by topical relevance.
// Reference endpoints: /backlinks, /backlinks/exchange-pool, /backlinks/credit-slots-availability.
// Guardrails: no reciprocal A<->B links within 90 days, max links received per site per month,
// never link between sites of the same organization.
import { one, all, run, uid, now, parse } from "../db.js";
import { hostOf } from "../crawl.js";

const MAX_RECEIVED_PER_MONTH = Number(process.env.BACKLINKS_PER_MONTH || 8);
const tokens = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter((w) => w.length > 3));
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

export function selectPartner(website, keyword) {
  const me = parse(website.profile, {});
  const myTokens = tokens([keyword, me.industry, me.description, ...(me.mainServices || [])].join(" "));
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  const quarterAgo = new Date(Date.now() - 90 * 864e5).toISOString();
  const candidates = all(`SELECT w.* FROM websites w WHERE w.in_backlink_pool = 1 AND w.onboarding_status = 'completed' AND w.org_id != ? AND w.id != ?`, website.org_id, website.id);
  let best = null;
  for (const c of candidates) {
    const received = one("SELECT COUNT(*) n FROM backlinks WHERE target_website_id = ? AND created_at >= ?", c.id, monthAgo).n;
    if (received >= MAX_RECEIVED_PER_MONTH) continue;
    const reciprocal = one("SELECT 1 FROM backlinks WHERE source_website_id = ? AND target_website_id = ? AND created_at >= ?", c.id, website.id, quarterAgo);
    if (reciprocal) continue;
    const p = parse(c.profile, {});
    const theirTokens = tokens([p.industry, p.description, ...(p.mainServices || [])].join(" "));
    const relevance = overlap(myTokens, theirTokens) + (p.industry && p.industry === me.industry ? 3 : 0);
    if (relevance < 1) continue;
    const given = one("SELECT COUNT(*) n FROM backlinks WHERE source_website_id = ?", c.id).n;
    const score = relevance * 2 + Math.min(given, 10) * 0.3 - received;
    if (!best || score > best.score) best = { website: c, profile: p, score };
  }
  if (!best) return null;
  // Prefer linking to a relevant published article of the partner, else its homepage.
  const arts = all("SELECT title, keyword, published_url FROM articles WHERE website_id = ? AND status = 'published' AND published_url IS NOT NULL ORDER BY published_at DESC LIMIT 30", best.website.id);
  const art = arts.map((a) => ({ a, s: overlap(myTokens, tokens(a.title + " " + a.keyword)) })).sort((x, y) => y.s - x.s)[0];
  const target = art && art.s > 0 ? { url: art.a.published_url, anchor: art.a.keyword } : { url: best.website.url, anchor: best.profile.brandName || hostOf(best.website.url) };
  return { targetWebsiteId: best.website.id, url: target.url, anchor: target.anchor, brand: best.profile.brandName || hostOf(best.website.url) };
}

export function recordBacklink(sourceWebsiteId, articleId, partner, markdown) {
  if (!partner || !markdown.includes(partner.url)) return null; // only record links actually placed
  const id = uid();
  run("INSERT INTO backlinks (id, source_website_id, source_article_id, target_website_id, target_url, anchor, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    id, sourceWebsiteId, articleId, partner.targetWebsiteId, partner.url, partner.anchor, "pending", now());
  return id;
}

export const markLive = (articleId) => run("UPDATE backlinks SET status = 'live' WHERE source_article_id = ?", articleId);

/* ---------------- API ---------------- */
export function getBacklinks(ctx) {
  const received = all(`SELECT b.*, a.title source_title, a.published_url source_url, w.url source_site FROM backlinks b
    JOIN articles a ON a.id = b.source_article_id JOIN websites w ON w.id = b.source_website_id
    WHERE b.target_website_id = ? ORDER BY b.created_at DESC LIMIT 200`, ctx.website.id);
  const given = all(`SELECT b.*, w.url target_site FROM backlinks b JOIN websites w ON w.id = b.target_website_id
    WHERE b.source_website_id = ? ORDER BY b.created_at DESC LIMIT 200`, ctx.website.id);
  const map = (r) => ({ id: r.id, status: r.status, anchor: r.anchor, targetUrl: r.target_url, sourceUrl: r.source_url || null, sourceTitle: r.source_title || null,
    sourceSite: r.source_site ? hostOf(r.source_site) : null, targetSite: r.target_site ? hostOf(r.target_site) : null, createdAt: r.created_at });
  return { data: { received: received.map(map), given: given.map(map), totals: { received: received.length, live: received.filter((r) => r.status === "live").length, given: given.length } } };
}

export function exchangePool(ctx) {
  const sites = one("SELECT COUNT(*) n FROM websites WHERE in_backlink_pool = 1 AND onboarding_status = 'completed'").n;
  const industries = all("SELECT profile FROM websites WHERE in_backlink_pool = 1 AND onboarding_status = 'completed'").map((r) => parse(r.profile, {}).industry).filter(Boolean);
  const live = one("SELECT COUNT(*) n FROM backlinks WHERE status = 'live'").n;
  return { data: { sites, niches: new Set(industries).size, liveLinks: live, enrolled: !!ctx.website.in_backlink_pool } };
}

export function creditSlots(ctx) {
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
  const used = one("SELECT COUNT(*) n FROM backlinks WHERE target_website_id = ? AND created_at >= ?", ctx.website.id, monthAgo).n;
  return { data: { monthlyLimit: MAX_RECEIVED_PER_MONTH, used, available: Math.max(0, MAX_RECEIVED_PER_MONTH - used) } };
}
