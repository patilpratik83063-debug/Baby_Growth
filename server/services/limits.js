// Usage limits for a personal deployment (no billing). Tune with env vars.
import { one } from "../db.js";

const num = (k, d) => Math.max(0, parseInt(process.env[k], 10) || d);
export const LIMITS = {
  websites: num("LIMIT_WEBSITES", 10),
  articlesPerMonth: num("LIMIT_ARTICLES_PER_MONTH", 60), // ~$0.006 each on budget models
  prompts: num("LIMIT_PROMPTS", 20),                     // tracked AI-visibility prompts per website
};

export const planLimits = () => LIMITS;

export function articlesThisMonth(orgId) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  return one("SELECT COUNT(*) n FROM articles a JOIN websites w ON w.id = a.website_id WHERE w.org_id = ? AND a.created_at >= ?", orgId, start.toISOString()).n;
}
