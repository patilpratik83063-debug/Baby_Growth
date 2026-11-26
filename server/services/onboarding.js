// Business analysis + guest and authenticated onboarding.
// Guest contract recovered with REA from the reference bundle:
//   POST /guest-onboarding/start {url}                 -> { data: session }
//   GET  /guest-onboarding/session        (x-guest-id) -> { data: session }
//   PUT  /guest-onboarding/draft {section,value,completesStep}
//   POST /guest-onboarding/set-email {email, skipPassword}
//   GET  /guest-onboarding/check-website-dns ?url
//   POST /guest-onboarding/detect-platform {url}
//   GET  /guest-onboarding/business-info ?language
//   GET  /guest-onboarding/organic-competitors ?description&industry&audience&language&locations
//   GET  /guest-onboarding/brand-colors
//   POST /guest-onboarding/claim {guestId}
// Draft sections: market{selectedLanguage,englishType,targetLocations}, business{description,targetAudience,industry,...},
//                 brand{brandColor,brandSecondaryColor,exampleArticleUrl,heroImageStyle,sitemapUrl}, competitors{urls}
import { z } from "zod";
import { one, all, run, uid, now, parse, websiteDto, logActivity } from "../db.js";
import { HttpError, bad, notFound, str, strArr } from "../http.js";
import { requireOrigin, safeFetch, tryFetch, extract, detectPlatformFromHtml, extractBrandColors, checkDns, readSitemap, hostOf, normalizeUrlToOrigin } from "../crawl.js";
import { generateJson, askWithWebSearch, MODELS } from "../llm.js";
import { createAccount, sendEmail, orgForUser } from "./auth.js";
import { enqueue } from "./jobs.js";

const SECTIONS = ["market", "business", "brand", "competitors", "voice"];

/* ---------------- business analysis ---------------- */
const BusinessSchema = z.object({
  brandName: z.string(),
  description: z.string(),
  industry: z.string(),
  targetAudience: z.array(z.string()),
  mainServices: z.array(z.string()),
  suggestedLocations: z.array(z.string()),
  voice: z.array(z.string()),
});

async function readSite(origin) {
  const home = await safeFetch(origin + "/");
  if (home.status >= 400) throw new HttpError(422, `The website returned HTTP ${home.status}.`, "SITE_ERROR");
  const x = extract(home.text);
  const about = x.links.map((l) => { try { return new URL(l, home.url).toString(); } catch { return null; } })
    .filter((l) => l && hostOf(l) === hostOf(home.url) && /about|company|who-we-are|services|product/i.test(l)).slice(0, 2);
  const extra = (await Promise.all(about.map((u) => tryFetch(u)))).filter(Boolean).map((r) => extract(r.text).text.slice(0, 3000));
  return { home, x, corpus: [x.title, x.description, x.h1s.join(" | "), x.h2s.slice(0, 12).join(" | "), x.text.slice(0, 6000), ...extra].join("\n\n") };
}

export async function analyzeBusiness(origin, language = "en") {
  const { home, x, corpus } = await readSite(origin);
  const result = await generateJson({
    system: "You analyze company websites for an SEO and AI-search growth platform. Be specific and factual; use only what the site supports.",
    prompt: `Website: ${home.url}\nWrite all values in language code "${language}".\n\nSite content:\n${corpus}\n\nReturn the brand name, a 2-3 sentence description of what the business offers, its industry, 2-5 target audience segments, 3-8 main products or services, 0-5 target locations (countries or cities, empty if global), and 3 adjectives describing its tone of voice.`,
    schema: BusinessSchema, model: MODELS.research,
    mock: () => ({
      brandName: x.ogSite || (x.title.split(/\s[|\-–—:·]\s/)[0] || hostOf(home.url)).trim(),
      description: x.description || x.ogDesc || x.h1s[0] || `${hostOf(home.url)} website.`,
      industry: "General business",
      targetAudience: ["Small businesses", "Consumers"],
      mainServices: (x.h2s.length ? x.h2s : ["Core service"]).slice(0, 5),
      suggestedLocations: [],
      voice: ["Professional", "Friendly", "Clear"],
    }),
  });
  const colors = extractBrandColors(home.text);
  const platform = detectPlatformFromHtml(home.text, home.headers);
  return { ...result, ...colors, platform: platform.platform, finalUrl: new URL(home.url).origin, lang: x.lang };
}

/* ---------------- organic competitors (grounded with web search) ---------------- */
const CompetitorSchema = z.object({ competitors: z.array(z.object({ domain: z.string(), name: z.string(), reason: z.string() })) });

export async function findCompetitors({ origin, description, industry, audience = [], language = "en", locations = [] }) {
  const ownHost = origin ? hostOf(origin) : "";
  const brief = `Business: ${description}\nIndustry: ${industry || "unknown"}\nAudience: ${audience.join("; ") || "unknown"}\nLocations: ${locations.join(", ") || "global"}\nLanguage: ${language}`;
  const search = await askWithWebSearch({
    prompt: `Find the websites that compete with this business for the same customers in organic search (Google and AI answers). Prefer direct competitors over directories, marketplaces and media.\n\n${brief}\n\nList 6-10 competitor websites with their domain.`,
    mock: () => ({ answer: "", sources: [] }),
  });
  const result = await generateJson({
    system: "You extract competitor websites. Only return real company domains (no Wikipedia, YouTube, Reddit, review sites, directories or marketplaces).",
    prompt: `${brief}\n\nResearch notes:\n${search.answer}\n\nSources:\n${search.sources.map((s) => s.url).join("\n")}\n\nReturn up to 8 competitor domains (bare domain like example.com), excluding ${ownHost || "the business itself"}.`,
    schema: CompetitorSchema, model: MODELS.research,
    mock: () => ({ competitors: [] }),
  });
  const seen = new Set([ownHost]);
  const out = [];
  for (const c of result.competitors) {
    const host = hostOf(normalizeUrlToOrigin(c.domain));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ url: "https://" + host, name: c.name, reason: c.reason });
  }
  return out.slice(0, 8);
}

/* ---------------- guest sessions ---------------- */
const guestDto = (g) => ({
  id: g.id, guestId: g.id, websiteUrl: g.website_url, email: g.email, draft: parse(g.draft, {}),
  lastCompletedOnboardingStep: g.last_step, localeSuggestion: parse(g.business_info, {})?.lang || null, claimed: !!g.claimed_by,
});
function guestFromReq(ctx) {
  const id = str(ctx.req.headers["x-guest-id"] || ctx.query.guestId, 64);
  const g = id && one("SELECT * FROM guest_sessions WHERE id = ?", id);
  if (!g) throw new HttpError(404, "This onboarding session has expired. Please start again.", "GUEST_DRAFT_GONE");
  return g;
}

export async function guestStart(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const dns = await checkDns(origin);
  if (!dns.valid) throw bad(dns.reason || "That website could not be reached.", "WEBSITE_UNREACHABLE");
  const id = uid();
  run("INSERT INTO guest_sessions (id, website_url, draft, created_at) VALUES (?,?,?,?)", id, origin, JSON.stringify({ utm: ctx.body.utm || null }), now());
  // warm the business analysis in the background
  enqueue("guest.analyze", { guestId: id, origin, language: "en" });
  return { data: guestDto(one("SELECT * FROM guest_sessions WHERE id = ?", id)) };
}
export const guestSession = (ctx) => ({ data: guestDto(guestFromReq(ctx)) });

export function guestDraft(ctx) {
  const g = guestFromReq(ctx);
  const section = str(ctx.body.section, 30);
  if (!SECTIONS.includes(section)) throw bad("Unknown draft section.");
  const value = ctx.body.value && typeof ctx.body.value === "object" ? ctx.body.value : {};
  const draft = parse(g.draft, {});
  draft[section] = { ...(draft[section] || {}), ...value };
  const step = ctx.body.completesStep === false ? g.last_step : Math.max(g.last_step, SECTIONS.indexOf(section) + 1);
  run("UPDATE guest_sessions SET draft = ?, last_step = ? WHERE id = ?", JSON.stringify(draft).slice(0, 64 * 1024), step, g.id);
  return { data: guestDto(one("SELECT * FROM guest_sessions WHERE id = ?", g.id)) };
}

export async function guestBusinessInfo(ctx) {
  const g = guestFromReq(ctx);
  const language = str(ctx.query.language, 10) || "en";
  let info = parse(g.business_info, null);
  if (!info || info.language !== language) {
    info = { ...(await analyzeBusiness(g.website_url, language)), language };
    run("UPDATE guest_sessions SET business_info = ? WHERE id = ?", JSON.stringify(info), g.id);
  }
  return { data: info };
}

export async function guestCompetitors(ctx) {
  const g = guestFromReq(ctx);
  const q = ctx.query;
  const list = await findCompetitors({
    origin: g.website_url, description: str(q.description, 1000) || parse(g.business_info, {})?.description || "",
    industry: str(q.industry, 100), audience: str(q.audience, 500).split(";").map((s) => s.trim()).filter(Boolean),
    language: str(q.language, 10) || "en", locations: str(q.locations, 300).split(",").map((s) => s.trim()).filter(Boolean),
  });
  return { data: list };
}

export async function guestBrandColors(ctx) {
  const g = guestFromReq(ctx);
  const info = parse(g.business_info, null);
  if (info?.brandColor !== undefined) return { data: { brandColor: info.brandColor, brandSecondaryColor: info.brandSecondaryColor, candidates: info.candidates || [] } };
  const home = await safeFetch(g.website_url + "/");
  return { data: extractBrandColors(home.text) };
}

export const checkWebsiteDns = (ctx) => checkDns(ctx.query.url);

export async function detectPlatform(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const home = await safeFetch(origin + "/");
  return { data: detectPlatformFromHtml(home.text, home.headers) };
}

/** Guest provides email: create a passwordless account, claim the draft, email a sign-in code. */
export async function guestSetEmail(ctx) {
  const g = guestFromReq(ctx);
  const email = str(ctx.body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad("Please enter a valid email.");
  run("UPDATE guest_sessions SET email = ? WHERE id = ?", email, g.id);
  const existing = one("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", email);
  if (existing) {
    const org = orgForUser(existing.id);
    if (org && one("SELECT 1 FROM websites WHERE org_id = ? LIMIT 1", org.id)) {
      throw new HttpError(409, "This email already has an account with websites. Sign in to add this website.", "GUEST_ACCOUNT_HAS_WEBSITES");
    }
    throw new HttpError(409, "This email already has an account. Please sign in to continue.", "EMAIL_TAKEN");
  }
  const { user, orgId } = createAccount({ email, password: null });
  const website = claimDraft(g, orgId);
  const { signInLink } = await import("./auth.js");
  await signInLink({ ...ctx, body: { email } });
  return { data: { userId: user.id, websiteId: website.id, nextStep: "verify-code" } };
}

export function guestClaim(ctx) {
  const g = one("SELECT * FROM guest_sessions WHERE id = ?", str(ctx.body.guestId, 64));
  if (!g) throw new HttpError(404, "This onboarding session has expired.", "GUEST_DRAFT_GONE");
  if (g.claimed_by && g.claimed_by !== ctx.org.id) throw new HttpError(409, "This onboarding session was already used.", "GUEST_ALREADY_CLAIMED");
  return { data: websiteDto(claimDraft(g, ctx.org.id)) };
}

function claimDraft(g, orgId) {
  const existing = g.claimed_by && one("SELECT * FROM websites WHERE org_id = ? AND url = ?", orgId, g.website_url);
  if (existing) return existing;
  const d = parse(g.draft, {});
  const info = parse(g.business_info, {}) || {};
  const profile = {
    brandName: d.business?.brandName ?? info.brandName ?? null,
    description: d.business?.description ?? info.description ?? null,
    industry: d.business?.industry ?? info.industry ?? null,
    targetAudience: d.business?.targetAudience ?? info.targetAudience ?? [],
    mainServices: d.business?.mainServices ?? info.mainServices ?? [],
    selectedLanguage: d.market?.selectedLanguage ?? "en", englishType: d.market?.englishType ?? "",
    targetLocations: d.market?.targetLocations ?? info.suggestedLocations ?? [],
    brandColor: d.brand?.brandColor ?? info.brandColor ?? "", brandSecondaryColor: d.brand?.brandSecondaryColor ?? info.brandSecondaryColor ?? null,
    exampleArticleUrl: d.brand?.exampleArticleUrl ?? null, heroImageStyle: d.brand?.heroImageStyle ?? null, sitemapUrl: d.brand?.sitemapUrl ?? null,
    voice: d.voice?.tones ?? info.voice ?? [],
  };
  const id = uid();
  run("INSERT INTO websites (id, org_id, url, profile, competitors, platform, onboarding_status, last_step, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, orgId, g.website_url, JSON.stringify(profile), JSON.stringify((d.competitors?.urls || []).slice(0, 10)), info.platform || null, "in_progress", g.last_step, now());
  run("UPDATE guest_sessions SET claimed_by = ? WHERE id = ?", orgId, g.id);
  logActivity(id, "onboarding", `Website ${hostOf(g.website_url)} added.`);
  return one("SELECT * FROM websites WHERE id = ?", id);
}

/* ---------------- authenticated website management ---------------- */
export const getOrgWebsites = (ctx) => ({ data: all("SELECT * FROM websites WHERE org_id = ? ORDER BY created_at", ctx.org.id).map(websiteDto) });
export const getOrgWebsite = (ctx) => ({ data: websiteDto(ctx.website) });

export async function createOrgWebsite(ctx) {
  const origin = requireOrigin(ctx.body.url);
  const dns = await checkDns(origin);
  if (!dns.valid) throw bad(dns.reason || "That website could not be reached.");
  if (one("SELECT 1 FROM websites WHERE org_id = ? AND url = ?", ctx.org.id, origin)) throw new HttpError(409, "This website is already in your account.");
  const id = uid();
  run("INSERT INTO websites (id, org_id, url, created_at) VALUES (?,?,?,?)", id, ctx.org.id, origin, now());
  enqueue("site.analyze", { language: "en" }, { websiteId: id });
  logActivity(id, "onboarding", `Website ${hostOf(origin)} added.`);
  return { data: websiteDto(one("SELECT * FROM websites WHERE id = ?", id)) };
}

const PROFILE_KEYS = ["brandName", "description", "industry", "targetAudience", "mainServices", "selectedLanguage", "englishType", "targetLocations", "brandColor", "brandSecondaryColor", "exampleArticleUrl", "heroImageStyle", "sitemapUrl", "voice"];
const ARRAY_KEYS = new Set(["targetAudience", "mainServices", "targetLocations", "voice"]);

export function updateOrgWebsite(ctx) {
  const w = ctx.website;
  const profile = parse(w.profile, {});
  for (const k of PROFILE_KEYS) if (k in ctx.body) profile[k] = ARRAY_KEYS.has(k) ? strArr(ctx.body[k]) : (ctx.body[k] == null ? null : str(ctx.body[k], k === "description" ? 2000 : 300));
  const sets = { profile: JSON.stringify(profile) };
  if ("competitors" in ctx.body) sets.competitors = JSON.stringify(strArr(ctx.body.competitors, 10).map(normalizeUrlToOrigin).filter(Boolean));
  if ("autopilot" in ctx.body) sets.autopilot = ctx.body.autopilot ? 1 : 0;
  if ("articlesPerWeek" in ctx.body) sets.articles_per_week = Math.max(0, Math.min(21, parseInt(ctx.body.articlesPerWeek, 10) || 0));
  if ("inBacklinkPool" in ctx.body) sets.in_backlink_pool = ctx.body.inBacklinkPool ? 1 : 0;
  const keys = Object.keys(sets);
  run(`UPDATE websites SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => sets[k]), w.id);
  return { data: websiteDto(one("SELECT * FROM websites WHERE id = ?", w.id)) };
}

export const getBusinessProfile = (ctx) => ({ data: websiteDto(ctx.website) });

export async function runBrandAnalysis(ctx) {
  const job = enqueue("site.analyze", { language: parse(ctx.website.profile, {}).selectedLanguage || "en", overwrite: !!ctx.body.overwrite }, { websiteId: ctx.website.id });
  return { data: { jobId: job.id, status: "queued" } };
}

export async function generateDescriptionFromUrl(ctx) {
  const info = await analyzeBusiness(requireOrigin(ctx.body.url), str(ctx.body.language, 10) || "en");
  return { data: { description: info.description, industry: info.industry, brandName: info.brandName } };
}

export async function detectBrandColors(ctx) {
  const home = await safeFetch((ctx.body.url ? requireOrigin(ctx.body.url) : ctx.website.url) + "/");
  return { data: extractBrandColors(home.text) };
}

export async function getOrganicCompetitors(ctx) {
  const p = parse(ctx.website.profile, {});
  return { data: await findCompetitors({ origin: ctx.website.url, description: p.description || "", industry: p.industry, audience: p.targetAudience || [], language: p.selectedLanguage, locations: p.targetLocations || [] }) };
}

/** Finish onboarding: kick off the agent (plan, audit, visibility baseline). */
export function startOnboarding(ctx) {
  const w = ctx.website;
  run("UPDATE websites SET onboarding_status = 'completed' WHERE id = ?", w.id);
  const jobs = [
    enqueue("site.sitemap", {}, { websiteId: w.id }),
    enqueue("content_plan.generate", { days: 30 }, { websiteId: w.id }),
    enqueue("geo_audit.run", {}, { websiteId: w.id }),
    enqueue("visibility.seed", {}, { websiteId: w.id }),
  ];
  logActivity(w.id, "onboarding", "Onboarding completed. Your growth agent is building a content plan.");
  return { data: { status: "completed", jobs: jobs.map((j) => j.id) } };
}

export function onboardingStatus(ctx) {
  const pending = one("SELECT COUNT(*) c FROM jobs WHERE website_id = ? AND status IN ('queued','running')", ctx.website.id).c;
  return { data: { onboardingStatus: ctx.website.onboarding_status, pendingJobs: pending, contentPlanReady: !!one("SELECT 1 FROM content_plan WHERE website_id = ? LIMIT 1", ctx.website.id) } };
}

/* job handlers */
export async function jobGuestAnalyze({ guestId, origin, language }) {
  const info = { ...(await analyzeBusiness(origin, language)), language };
  run("UPDATE guest_sessions SET business_info = ? WHERE id = ? AND business_info IS NULL", JSON.stringify(info), guestId);
  return { ok: true };
}
export async function jobSiteAnalyze({ language = "en", overwrite = false }, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  if (!w) return { skipped: true };
  const info = await analyzeBusiness(w.url, language);
  const profile = parse(w.profile, {});
  const merged = { ...profile };
  for (const [k, v] of Object.entries({ brandName: info.brandName, description: info.description, industry: info.industry, targetAudience: info.targetAudience, mainServices: info.mainServices, targetLocations: info.suggestedLocations, voice: info.voice, brandColor: info.brandColor, brandSecondaryColor: info.brandSecondaryColor })) {
    const empty = merged[k] == null || merged[k] === "" || (Array.isArray(merged[k]) && !merged[k].length);
    if (overwrite || empty) merged[k] = v;
  }
  merged.selectedLanguage ||= language;
  run("UPDATE websites SET profile = ?, platform = COALESCE(platform, ?) WHERE id = ?", JSON.stringify(merged), info.platform, websiteId);
  logActivity(websiteId, "analysis", "Brand analysis updated from your website.");
  return { ok: true };
}
export async function jobSiteSitemap(_p, websiteId) {
  const w = one("SELECT * FROM websites WHERE id = ?", websiteId);
  const sm = await readSitemap(w.url, 500);
  const profile = parse(w.profile, {});
  profile.sitemapUrl ||= sm.sitemapUrl;
  profile.knownPages = sm.urls.slice(0, 500);
  run("UPDATE websites SET profile = ? WHERE id = ?", JSON.stringify(profile), websiteId);
  return { pages: sm.urls.length };
}

export { sendEmail };
