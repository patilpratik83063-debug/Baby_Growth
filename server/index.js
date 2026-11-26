// GeoGrowth API server. Routes mirror the reference API map recovered with REA
// (ENDPOINTS constant in the reference bundle), mounted under /api.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { one, run, uid, now, all } from "./db.js";
import { createRouter, readBody, json, HttpError, unauthorized, forbidden, notFound, limiter, str } from "./http.js";
import { isMock, MODELS, ENGINES, spend } from "./llm.js";
import * as auth from "./services/auth.js";
import * as onboarding from "./services/onboarding.js";
import * as plan from "./services/contentPlan.js";
import * as articles from "./services/articles.js";
import * as publishing from "./services/publishing.js";
import * as backlinks from "./services/backlinks.js";
import * as visibility from "./services/visibility.js";
import * as geo from "./services/geoAudit.js";
import * as seotools from "./services/seotools.js";
import * as overview from "./services/overview.js";
import * as billing from "./services/billing.js";
import { registerJob, startWorker, listJobs, deleteJobs } from "./services/jobs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT) || 3000;

/* ---------------- jobs ---------------- */
registerJob("guest.analyze", onboarding.jobGuestAnalyze);
registerJob("site.analyze", onboarding.jobSiteAnalyze);
registerJob("site.sitemap", onboarding.jobSiteSitemap);
registerJob("content_plan.generate", plan.jobGeneratePlan);
registerJob("article.generate", articles.jobGenerateArticle);
registerJob("article.generate:failed", articles.onGenerateFailed);
registerJob("article.publish", publishing.jobPublish);
registerJob("geo_audit.run", geo.jobRun);
registerJob("visibility.seed", visibility.jobSeed);
registerJob("visibility.run", visibility.jobRun);
registerJob("public_visibility.run", visibility.jobPublic);

/* ---------------- middleware ---------------- */
const publicLimit = limiter(20, 60_000);
const authLimit = limiter(10, 60_000);
const heavyLimit = limiter(6, 60_000);
const pollLimit = limiter(90, 60_000); // status polling (reference polls every 5s)

const user = (ctx) => {
  const a = auth.authenticate(ctx.req);
  if (!a) throw unauthorized();
  ctx.user = a.user;
  ctx.org = a.orgId ? one("SELECT * FROM organizations WHERE id = ?", a.orgId) : auth.orgForUser(a.user.id);
  if (!ctx.org) throw forbidden("No organization found for this account.");
};
const website = (ctx) => {
  user(ctx);
  const wanted = str(ctx.req.headers["x-website-id"] || ctx.query.websiteId, 64);
  ctx.website = wanted
    ? one("SELECT * FROM websites WHERE id = ? AND org_id = ?", wanted, ctx.org.id)
    : one("SELECT * FROM websites WHERE org_id = ? ORDER BY created_at LIMIT 1", ctx.org.id);
  if (!ctx.website) throw notFound("No website selected. Add a website first.");
};
const ownerOnly = (ctx) => { user(ctx); const m = one("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?", ctx.org.id, ctx.user.id); if (m?.role !== "owner") throw forbidden("Only the organization owner can do this."); };
const pub = (ctx) => publicLimit(ctx.ip);
const authRate = (ctx) => authLimit(ctx.ip);
const heavy = (ctx) => heavyLimit(ctx.ip);
const poll = (ctx) => pollLimit(ctx.ip);

/* ---------------- routes ---------------- */
const r = createRouter();

// AUTH
r.post("/auth/sign-up", authRate, auth.signUp);
r.post("/auth/sign-in", authRate, auth.signIn);
r.get("/auth/sign-in-methods", authRate, auth.signInMethods);
r.post("/auth/sign-in-link", authRate, auth.signInLink);
r.post("/auth/verify-sign-in-code", authRate, auth.verifySignInCode);
r.post("/auth/reset-password-request", authRate, auth.resetPasswordRequest);
r.post("/auth/change-password", user, auth.changePassword);
r.post("/auth/logout", auth.logout);

// USERS
r.get("/users/me", user, auth.getMe);
r.put("/users/me", user, auth.updateMe);
r.delete("/users/me", user, auth.deleteMe);

// ORGANIZATION
r.get("/organization", user, (ctx) => ({ data: { id: ctx.org.id, name: ctx.org.name, role: ctx.org.role, apiKeyHint: ctx.org.api_key_hint,
  members: all("SELECT u.id, u.email, u.name, m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?", ctx.org.id) } }));
r.put("/organization/update", ownerOnly, (ctx) => { const name = str(ctx.body.name, 80); if (name) run("UPDATE organizations SET name = ? WHERE id = ?", name, ctx.org.id); return { data: { ok: true } }; });
r.post("/organization/invite-member", ownerOnly, async (ctx) => {
  const email = str(ctx.body.email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, "Please enter a valid email.");
  let u = one("SELECT * FROM users WHERE email = ?", email);
  if (!u) { const id = uid(); run("INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)", id, email, email.split("@")[0], now()); u = { id }; }
  run("INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?,?,?)", ctx.org.id, u.id, "member");
  await auth.sendEmail(email, `You're invited to ${ctx.org.name} on GeoGrowth`, "Sign in with this email to join the team.");
  return { data: { ok: true } };
});
r.delete("/organization/remove-member/:userId", ownerOnly, (ctx) => { if (ctx.params.userId === ctx.user.id) throw new HttpError(400, "You can't remove yourself."); run("DELETE FROM org_members WHERE org_id = ? AND user_id = ?", ctx.org.id, ctx.params.userId); return { data: { ok: true } }; });
r.get("/organization/get-org-websites", user, onboarding.getOrgWebsites);
r.get("/organization/get-org-website", website, onboarding.getOrgWebsite);
r.post("/organization/create-org-website", user, heavy, onboarding.createOrgWebsite);
r.post("/organization/add-org-website", user, heavy, onboarding.createOrgWebsite);
r.put("/organization/update-org-website", website, onboarding.updateOrgWebsite);
r.get("/organization/get-org-website-stats", website, overview.websiteStats);
r.get("/organization/check-website-dns", user, onboarding.checkWebsiteDns);
r.post("/onboarding/start", website, onboarding.startOnboarding);
r.get("/onboarding/status", website, onboarding.onboardingStatus);
r.post("/organization/generate-api-key", ownerOnly, auth.generateApiKey);
r.delete("/organization/api-key", ownerOnly, auth.deleteApiKey);
r.post("/organization/generate-description-from-url", user, heavy, onboarding.generateDescriptionFromUrl);
r.post("/organization/detect-brand-colors", website, onboarding.detectBrandColors);
r.post("/organization/run-brand-analysis", website, onboarding.runBrandAnalysis);
r.get("/organization/content-strategy-preview", website, heavy, plan.strategyPreview);
r.get("/organization/business-profile", website, onboarding.getBusinessProfile);
r.put("/organization/business-profile", website, onboarding.updateOrgWebsite);
r.get("/organization/get-organic-competitors", website, heavy, onboarding.getOrganicCompetitors);

// GUEST ONBOARDING (public, x-guest-id)
r.post("/guest-onboarding/start", pub, onboarding.guestStart);
r.get("/guest-onboarding/session", onboarding.guestSession);
r.put("/guest-onboarding/draft", onboarding.guestDraft);
r.post("/guest-onboarding/set-email", authRate, onboarding.guestSetEmail);
r.get("/guest-onboarding/check-website-dns", pub, onboarding.checkWebsiteDns);
r.post("/guest-onboarding/detect-platform", pub, onboarding.detectPlatform);
r.get("/guest-onboarding/business-info", heavy, onboarding.guestBusinessInfo);
r.get("/guest-onboarding/organic-competitors", heavy, onboarding.guestCompetitors);
r.get("/guest-onboarding/brand-colors", pub, onboarding.guestBrandColors);
r.post("/guest-onboarding/claim", user, onboarding.guestClaim);

// OVERVIEW
r.get("/overview/agent-activities", website, overview.agentActivities);
r.get("/overview/setup-checklist", website, overview.setupChecklist);
r.get("/overview/milestones", website, overview.milestones);

// CONTENT PLAN
r.get("/content-plan", website, plan.getPlan);
r.post("/content-plan/generate", website, plan.regeneratePlan);
r.post("/content-plan", website, plan.addPlanItem);
r.put("/content-plan/:id", website, plan.updatePlanItem);
r.delete("/content-plan/:id", website, plan.skipPlanItem);
r.post("/content-plan/:id/generate", website, plan.generateNow);

// ARTICLES
r.get("/articles", website, articles.listArticles);
r.post("/articles/rewrite-text", website, heavy, articles.rewriteText);
r.get("/articles/:id", website, articles.getArticle);
r.put("/articles/:id", website, articles.updateArticle);
r.delete("/articles/:id", website, articles.deleteArticle);
r.post("/articles/:id/regenerate", website, articles.regenerateArticle);
r.post("/articles/:id/publish", website, publishing.publishNow);
r.get("/articles/:id/export-html", website, articles.exportHtml);

// INTEGRATIONS / PUBLISHING
r.get("/integrations", website, publishing.listIntegrations);
r.post("/integrations", website, publishing.createIntegration);
r.delete("/integrations/:id", website, publishing.deleteIntegration);
r.post("/integrations/detect-platform", user, onboarding.detectPlatform);
r.post("/integrations/published-urls/recheck", website, publishing.recheckPublishedUrls);
r.get("/hosted-blog/config", website, publishing.hostedBlogConfig);

// BACKLINKS
r.get("/backlinks", website, backlinks.getBacklinks);
r.get("/backlinks/exchange-pool", website, backlinks.exchangePool);
r.get("/backlinks/credit-slots-availability", website, backlinks.creditSlots);

// LLM VISIBILITY
r.get("/llm-visibility/prompts", website, visibility.listPrompts);
r.post("/llm-visibility/prompts", website, visibility.createPrompt);
r.get("/llm-visibility/prompt-allowance", website, visibility.allowance);
r.get("/llm-visibility/prompts/:promptId", website, visibility.getPrompt);
r.put("/llm-visibility/prompts/:promptId", website, visibility.updatePrompt);
r.delete("/llm-visibility/prompts/:promptId", website, visibility.deletePrompt);
r.post("/llm-visibility/run", website, visibility.runNow);
r.get("/llm-visibility/top-sources", website, visibility.topSources);
r.get("/llm-visibility/brands-mentioned", website, visibility.brandsMentioned);
r.get("/llm-visibility/overall-insights", website, visibility.overallInsights);
r.get("/llm-visibility/history", website, visibility.history);

// GEO AUDIT
r.post("/geo-audit/start", website, geo.start);
r.get("/geo-audit/data", website, geo.data);
r.post("/geo-audit/share-link", website, geo.shareLink);
r.post("/geo-audit/public/start", heavy, geo.publicStart);
r.get("/geo-audit/public/get-data", poll, geo.publicData);
r.post("/geo-audit/public/:auditId/email", pub, geo.publicEmail);
r.get("/geo-audit/public/share/:shareToken", pub, geo.publicShare);

// PUBLIC LLM VISIBILITY AUDIT
r.post("/public-llm-visibility/start", heavy, visibility.publicStart);
r.get("/public-llm-visibility/get-data", poll, visibility.publicData);
r.post("/public-llm-visibility/email", pub, visibility.publicEmail);

// SUBSCRIPTIONS
r.get("/subscriptions/get-org-website-subscription", user, billing.getSubscription);
r.post("/subscriptions/create-customer-checkout", ownerOnly, billing.createCheckout);
r.post("/subscriptions/create-portal-session", ownerOnly, billing.createPortal);
r.post("/subscriptions/cancel-subscription", ownerOnly, billing.cancelSubscription);
r.get("/subscriptions/invoices", user, billing.invoices);

// ASYNC JOBS
r.get("/async-jobs", website, listJobs);
r.delete("/async-jobs", website, deleteJobs);

// SEO TOOLS (public)
r.post("/seotools/robots-txt-checker", heavy, seotools.robotsTxtChecker);
r.post("/seotools/sitemap-checker", heavy, seotools.sitemapChecker);
r.post("/seotools/h1-checker", heavy, seotools.h1Checker);
r.post("/seotools/meta-description-checker", heavy, seotools.metaDescriptionChecker);
r.post("/seotools/canonical-checker", heavy, seotools.canonicalChecker);
r.post("/seotools/open-graph-checker", heavy, seotools.openGraphChecker);
r.post("/seotools/llms-txt-validator", heavy, seotools.llmsTxtValidator);
r.post("/seotools/llms-txt-validator/text", pub, seotools.llmsTxtValidatorText);
r.post("/seotools/llms-txt-generator", heavy, seotools.llmsTxtGenerator);
r.post("/seotools/keyword-density-checker", heavy, seotools.keywordDensityChecker);
r.post("/seotools/keyword-density-checker/text", pub, seotools.keywordDensityText);
r.post("/seotools/seo-competitor-analysis", heavy, seotools.seoCompetitorAnalysis);

// MARKETING
r.post("/marketing/save-form-submission", pub, (ctx) => {
  run("INSERT INTO form_submissions (id, kind, payload, created_at) VALUES (?,?,?,?)", uid(), str(ctx.body.kind, 40) || "form", JSON.stringify(ctx.body).slice(0, 10000), now());
  return { data: { ok: true } };
});

// Landing-page instant audit (used by the homepage widget)
r.post("/audit", heavy, geo.instant);
r.get("/health", () => ({ ok: true, llm: isMock() ? "mock" : "openrouter", models: MODELS, engines: Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.model])), spendSinceStartUsd: Math.round(spend.totalUsd * 10000) / 10000, aiCalls: spend.calls }));

/* ---------------- static + special routes ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
async function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) return false;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return false;
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ip = req.socket.remoteAddress || "unknown";
  try {
    if (url.pathname === "/api/stripe/webhook" && req.method === "POST") {
      const chunks = []; for await (const c of req) chunks.push(c);
      return json(res, 200, billing.stripeWebhook(Buffer.concat(chunks).toString("utf8"), req.headers["stripe-signature"]));
    }
    if (url.pathname.startsWith("/api/")) {
      const match = r.match(req.method, url.pathname.slice(4));
      if (!match) return json(res, 404, { message: "Not found.", code: "NOT_FOUND" });
      const ctx = { req, res, ip, params: match.params, query: Object.fromEntries(url.searchParams), body: await readBody(req) };
      let out;
      for (const h of match.handlers) out = await h(ctx);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
      return;
    }
    const cover = url.pathname.match(/^\/media\/covers\/([0-9a-f-]{36})\.svg$/);
    if (cover) {
      const svg = articles.coverSvg(cover[1]);
      if (svg) { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }); return res.end(svg); }
    }
    const blog = url.pathname.match(/^\/blog\/([0-9a-f-]{36})(?:\/([a-z0-9-]+))?\/?$/);
    if (blog && publishing.serveBlog(res, blog[1], blog[2])) return;
    if ((req.method === "GET" || req.method === "HEAD") && await serveStatic(req, res, url.pathname)) return;
    json(res, 404, { message: "Not found." });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { message: status === 500 ? "Something went wrong. Please try again." : e.message, code: e.code || undefined });
  }
});

startWorker();
overview.startAutopilot();
server.listen(PORT, () => console.log(`GeoGrowth running at http://localhost:${PORT}  (AI: ${isMock() ? "mock mode" : "OpenRouter, writer " + MODELS.writer})`));
