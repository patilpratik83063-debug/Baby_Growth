// SQLite persistence via Node's built-in node:sqlite (no native deps).
// Data model follows the reference's org-website shape recovered with REA:
// selectedLanguage, englishType, targetLocations, brandName, description, industry,
// targetAudience[], mainServices[], brandColor, brandSecondaryColor, exampleArticleUrl,
// heroImageStyle, sitemapUrl, competitors.urls, lastCompletedOnboardingStep, onboardingStatus.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "geogrowth.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT,
  email_verified INTEGER DEFAULT 0, deleted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sign_in_codes (
  email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
  api_key_hash TEXT, api_key_hint TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS websites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '{}', competitors TEXT NOT NULL DEFAULT '[]',
  platform TEXT, onboarding_status TEXT NOT NULL DEFAULT 'not_started', last_step INTEGER DEFAULT 0,
  autopilot INTEGER NOT NULL DEFAULT 1, articles_per_week INTEGER NOT NULL DEFAULT 3,
  in_backlink_pool INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guest_sessions (
  id TEXT PRIMARY KEY, website_url TEXT, draft TEXT NOT NULL DEFAULT '{}', email TEXT,
  last_step INTEGER DEFAULT 0, business_info TEXT, claimed_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS content_plan (
  id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL, title TEXT NOT NULL, keyword TEXT NOT NULL, search_intent TEXT,
  article_type TEXT, secondary_keywords TEXT DEFAULT '[]', status TEXT NOT NULL DEFAULT 'planned',
  article_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  plan_id TEXT, title TEXT NOT NULL, slug TEXT NOT NULL, meta_description TEXT, keyword TEXT,
  markdown TEXT, html TEXT, faq TEXT DEFAULT '[]', json_ld TEXT, word_count INTEGER DEFAULT 0,
  checks TEXT DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft', published_url TEXT, published_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backlinks (
  id TEXT PRIMARY KEY, source_website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  source_article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  target_website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  target_url TEXT NOT NULL, anchor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visibility_prompts (
  id TEXT PRIMARY KEY, website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS visibility_runs (
  id TEXT PRIMARY KEY, prompt_id TEXT REFERENCES visibility_prompts(id) ON DELETE CASCADE,
  website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE, engine TEXT NOT NULL,
  answer TEXT, mentioned INTEGER NOT NULL DEFAULT 0, position INTEGER, brands TEXT DEFAULT '[]',
  sources TEXT DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geo_audits (
  id TEXT PRIMARY KEY, website_id TEXT, url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
  result TEXT, error TEXT, email TEXT, share_token TEXT UNIQUE, is_public INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_visibility_audits (
  id TEXT PRIMARY KEY, website_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'processing',
  result TEXT, error TEXT, email TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, website_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT,
  run_after INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, website_id TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, plan TEXT NOT NULL,
  status TEXT NOT NULL, stripe_customer TEXT, stripe_subscription TEXT, trial_ends_at TEXT,
  current_period_end TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_articles_site ON articles(website_id, created_at);
CREATE INDEX IF NOT EXISTS idx_plan_site ON content_plan(website_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_runs_site ON visibility_runs(website_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_site ON activities(website_id, created_at);
`);

/* ---------------- additive migrations (idempotent) ---------------- */
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn("visibility_prompts", "kind", "TEXT NOT NULL DEFAULT 'discovery'"); // discovery | brand
addColumn("visibility_runs", "error", "TEXT");
addColumn("users", "username", "TEXT"); // login ID (case-insensitive), email also works
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(lower(username)) WHERE username IS NOT NULL");
// Empty answers were once recorded as "not mentioned" (false zeros). They are failed calls: drop them.
db.exec("DELETE FROM visibility_runs WHERE answer IS NULL OR trim(answer) = ''");

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const parse = (v, fallback) => { if (v == null) return fallback; try { return JSON.parse(v); } catch { return fallback; } };

export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

export function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

export function logActivity(websiteId, type, message) {
  run("INSERT INTO activities (id, website_id, type, message, created_at) VALUES (?,?,?,?,?)", uid(), websiteId, type, message, now());
}

/* Website row <-> API shape */
export function websiteDto(w) {
  if (!w) return null;
  const p = parse(w.profile, {});
  return {
    id: w.id, url: w.url, platform: w.platform,
    onboardingStatus: w.onboarding_status, lastCompletedOnboardingStep: w.last_step,
    autopilot: !!w.autopilot, articlesPerWeek: w.articles_per_week, inBacklinkPool: !!w.in_backlink_pool,
    brandName: p.brandName ?? null, description: p.description ?? null, industry: p.industry ?? null,
    targetAudience: p.targetAudience ?? [], mainServices: p.mainServices ?? [],
    selectedLanguage: p.selectedLanguage ?? "en", englishType: p.englishType ?? "",
    targetLocations: p.targetLocations ?? [], brandColor: p.brandColor ?? "", brandSecondaryColor: p.brandSecondaryColor ?? null,
    exampleArticleUrl: p.exampleArticleUrl ?? null, heroImageStyle: p.heroImageStyle ?? null, sitemapUrl: p.sitemapUrl ?? null,
    voice: p.voice ?? [], competitors: parse(w.competitors, []), createdAt: w.created_at,
  };
}
