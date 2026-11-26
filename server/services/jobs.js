// Durable job queue (SQLite) + worker + autopilot scheduler.
// Reference equivalents: /async-jobs, /task-queue, agent activities.
import { one, all, run, uid, now, parse } from "../db.js";

const handlers = new Map();
export const registerJob = (type, fn) => handlers.set(type, fn);

export function enqueue(type, payload = {}, { websiteId = null, delayMs = 0 } = {}) {
  const id = uid(), t = now();
  run("INSERT INTO jobs (id, type, website_id, payload, run_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    id, type, websiteId, JSON.stringify(payload), Date.now() + delayMs, t, t);
  kick();
  return { id, type, status: "queued" };
}

/** Avoid duplicate pending work of the same kind for a website. */
export function enqueueOnce(type, payload, opts = {}) {
  const pending = one("SELECT id FROM jobs WHERE type = ? AND website_id IS ? AND status IN ('queued','running') AND payload = ?", type, opts.websiteId ?? null, JSON.stringify(payload));
  return pending ? { id: pending.id, type, status: "queued" } : enqueue(type, payload, opts);
}

const CONCURRENCY = Number(process.env.JOB_CONCURRENCY || 3);
const MAX_ATTEMPTS = 3;
let active = 0, timer = null;

function claim() {
  const job = one("SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY run_after LIMIT 1", Date.now());
  if (!job) return null;
  const r = run("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'", now(), job.id);
  return r.changes ? { ...job, attempts: job.attempts + 1 } : null;
}

async function execute(job) {
  const fn = handlers.get(job.type);
  try {
    if (!fn) throw new Error(`No handler for job type ${job.type}`);
    const result = await fn(parse(job.payload, {}), job.website_id, job);
    run("UPDATE jobs SET status = 'done', result = ?, error = NULL, updated_at = ? WHERE id = ?", JSON.stringify(result ?? null), now(), job.id);
  } catch (e) {
    const retryable = job.attempts < MAX_ATTEMPTS && e.status !== 400 && e.status !== 404 && e.code !== "AI_REFUSED";
    const backoff = 30_000 * 2 ** (job.attempts - 1);
    run("UPDATE jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?",
      retryable ? "queued" : "failed", String(e.message || e).slice(0, 1000), Date.now() + backoff, now(), job.id);
    if (!retryable) console.error(`[job ${job.type}] failed:`, e.message);
    const onFail = handlers.get(job.type + ":failed");
    if (!retryable && onFail) await Promise.resolve(onFail(parse(job.payload, {}), job.website_id, e)).catch(() => {});
  }
}

function pump() {
  while (active < CONCURRENCY) {
    const job = claim();
    if (!job) return;
    active++;
    execute(job).finally(() => { active--; pump(); });
  }
}
export function kick() { setImmediate(pump); }

export function startWorker() {
  // recover jobs left running by a crashed process
  run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", now());
  timer = setInterval(pump, 2000);
  timer.unref?.();
  pump();
}

/* ---------------- API ---------------- */
export function listJobs(ctx) {
  const rows = all("SELECT id, type, status, attempts, error, created_at, updated_at FROM jobs WHERE website_id = ? ORDER BY created_at DESC LIMIT 50", ctx.website.id);
  return { data: rows };
}
export function deleteJobs(ctx) {
  const r = run("DELETE FROM jobs WHERE website_id = ? AND status IN ('done','failed')", ctx.website.id);
  return { data: { deleted: r.changes } };
}
