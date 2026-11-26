// Minimal HTTP toolkit: router with :params, JSON bodies, cookies, errors, rate limits.
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (msg, code) => new HttpError(400, msg, code);
export const unauthorized = (msg = "Please sign in.") => new HttpError(401, msg, "UNAUTHORIZED");
export const forbidden = (msg = "You don't have access to this.") => new HttpError(403, msg, "FORBIDDEN");
export const notFound = (msg = "Not found.") => new HttpError(404, msg, "NOT_FOUND");

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    routes.push({ method, re, keys, handlers });
  };
  return {
    get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), delete: add("DELETE"),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
}

export async function readBody(req, limit = 512 * 1024) {
  if (req.method === "GET" || req.method === "HEAD") return {};
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, "Request body too large."); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw bad("Invalid JSON body."); }
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge, httpOnly = true } = {}) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly ? "; HttpOnly" : ""}${secure}${maxAge != null ? `; Max-Age=${maxAge}` : ""}`;
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

export function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); throw new HttpError(429, "Too many requests. Please try again in a minute.", "RATE_LIMITED"); }
    arr.push(t); hits.set(key, arr);
    if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
  };
}

export const str = (v, n = 500) => String(v ?? "").trim().slice(0, n);
export const strArr = (v, max = 20, n = 200) => (Array.isArray(v) ? v : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);
