// Dashboard overview + autopilot scheduler.
// Reference endpoints: /overview/agent-activities, /overview/setup-checklist, /overview/milestones,
// /organization/get-org-website-stats.
import { one, all, run, parse } from "../db.js";
import { enqueueOnce } from "./jobs.js";
import { subscriptionFor, planLimits, articlesThisMonth } from "./billing.js";

export function agentActivities(ctx) {
  const rows = all("SELECT type, message, created_at FROM activities WHERE website_id = ? ORDER BY created_at DESC LIMIT 50", ctx.website.id);
  return { data: rows.map((r) => ({ type: r.type, message: r.message, createdAt: r.created_at })) };
}

export function setupChecklist(ctx) {
  const w = ctx.website, p = parse(w.profile, {});
  const has = (sql, ...a) => !!one(sql, ...a);
  const items = [
    { id: "website", label: "Add your website", done: true },
    { id: "business", label: "Complete your business profile", done: !!(p.description && p.industry && (p.targetAudience || []).length) },
    { id: "competitors", label: "Add competitors", done: parse(w.competitors, []).length > 0 },
    { id: "integration", label: "Connect publishing (WordPress, webhook or hosted blog)", done: has("SELECT 1 FROM integrations WHERE website_id = ? AND status = 'active'", w.id) },
    { id: "plan", label: "Review your content plan", done: has("SELECT 1 FROM content_plan WHERE website_id = ?", w.id) },
    { id: "first_article", label: "Get your first article", done: has("SELECT 1 FROM articles WHERE website_id = ?", w.id) },
    { id: "first_publish", label: "Publish your first article", done: has("SELECT 1 FROM articles WHERE website_id = ? AND status = 'published'", w.id) },
    { id: "visibility", label: "Track AI search prompts", done: has("SELECT 1 FROM visibility_prompts WHERE website_id = ?", w.id) },
    { id: "audit", label: "Run a GEO audit", done: has("SELECT 1 FROM geo_audits WHERE website_id = ? AND status = 'completed'", w.id) },
  ];
  return { data: { items, completed: items.filter((i) => i.done).length, total: items.length } };
}

export function websiteStats(ctx) {
  const id = ctx.website.id;
  const c = (sql, ...a) => one(sql, ...a).n;
  const audit = one("SELECT result FROM geo_audits WHERE website_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1", id);
  const vis = one("SELECT COUNT(*) n, SUM(mentioned) m FROM visibility_runs WHERE website_id = ? AND created_at >= ?", id, new Date(Date.now() - 30 * 864e5).toISOString());
  return { data: {
    articles: c("SELECT COUNT(*) n FROM articles WHERE website_id = ?", id),
    published: c("SELECT COUNT(*) n FROM articles WHERE website_id = ? AND status = 'published'", id),
    planned: c("SELECT COUNT(*) n FROM content_plan WHERE website_id = ? AND status = 'planned'", id),
    backlinksReceived: c("SELECT COUNT(*) n FROM backlinks WHERE target_website_id = ?", id),
    backlinksLive: c("SELECT COUNT(*) n FROM backlinks WHERE target_website_id = ? AND status = 'live'", id),
    geoScore: audit ? parse(audit.result, {}).score : null,
    aiMentionRate: vis.n ? Math.round((vis.m / vis.n) * 100) : null,
    subscription: subscriptionFor(ctx.org.id),
    usage: { articlesThisMonth: articlesThisMonth(ctx.org.id), articlesPerMonth: planLimits(ctx.org.id).articlesPerMonth },
  } };
}

export function milestones(ctx) {
  const id = ctx.website.id;
  const published = one("SELECT COUNT(*) n FROM articles WHERE website_id = ? AND status = 'published'", id).n;
  const links = one("SELECT COUNT(*) n FROM backlinks WHERE target_website_id = ? AND status = 'live'", id).n;
  const mentions = one("SELECT SUM(mentioned) m FROM visibility_runs WHERE website_id = ?", id).m || 0;
  const list = [
    { id: "published_1", label: "First article published", reached: published >= 1 },
    { id: "published_10", label: "10 articles published", reached: published >= 10 },
    { id: "published_50", label: "50 articles published", reached: published >= 50 },
    { id: "backlink_1", label: "First backlink earned", reached: links >= 1 },
    { id: "backlink_10", label: "10 backlinks earned", reached: links >= 10 },
    { id: "ai_mention_1", label: "First AI search mention", reached: mentions >= 1 },
  ];
  return { data: list };
}

/* ---------------- autopilot ----------------
   Every minute: for each onboarded website on an active plan with autopilot on,
   - keep >= 14 days of content planned,
   - generate due articles (scheduled_for <= today) within the monthly article quota,
   - re-check AI visibility weekly and the GEO audit monthly. */
export function autopilotTick() {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const sites = all("SELECT * FROM websites WHERE onboarding_status = 'completed' AND autopilot = 1");
  for (const w of sites) {
    const sub = subscriptionFor(w.org_id);
    if (!sub.active) continue;
    const furthest = one("SELECT MAX(scheduled_for) d FROM content_plan WHERE website_id = ? AND status != 'skipped'", w.id).d;
    if (!furthest || furthest < horizon) enqueueOnce("content_plan.generate", { days: 30 }, { websiteId: w.id });

    let remaining = planLimits(w.org_id).articlesPerMonth - articlesThisMonth(w.org_id);
    const due = all("SELECT id FROM content_plan WHERE website_id = ? AND status = 'planned' AND scheduled_for <= ? ORDER BY scheduled_for LIMIT 3", w.id, today);
    for (const item of due) {
      if (remaining-- <= 0) break;
      run("UPDATE content_plan SET status = 'generating' WHERE id = ? AND status = 'planned'", item.id);
      enqueueOnce("article.generate", { planId: item.id }, { websiteId: w.id });
    }

    const lastRun = one("SELECT MAX(created_at) t FROM visibility_runs WHERE website_id = ?", w.id).t;
    if (!lastRun || Date.now() - new Date(lastRun).getTime() > 7 * 864e5) enqueueOnce("visibility.run", {}, { websiteId: w.id });
    const lastAudit = one("SELECT MAX(created_at) t FROM geo_audits WHERE website_id = ?", w.id).t;
    if (!lastAudit || Date.now() - new Date(lastAudit).getTime() > 30 * 864e5) enqueueOnce("geo_audit.run", {}, { websiteId: w.id });
  }
}

export function startAutopilot() {
  const t = setInterval(() => { try { autopilotTick(); } catch (e) { console.error("[autopilot]", e.message); } }, Number(process.env.AUTOPILOT_INTERVAL_MS || 60_000));
  t.unref?.();
  setTimeout(() => { try { autopilotTick(); } catch (e) { console.error("[autopilot]", e.message); } }, 3000).unref?.();
}
