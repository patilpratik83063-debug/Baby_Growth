// Auth: email+password, email sign-in codes, cookie sessions, org API keys.
// Mirrors reference endpoints /auth/sign-up, /auth/sign-in, /auth/sign-in-link,
// /auth/verify-sign-in-code, /auth/logout, /auth/change-password, /auth/reset-password-request, /users/me.
import { scryptSync, randomBytes, timingSafeEqual, createHash, randomInt } from "node:crypto";
import { one, run, all, uid, now, tx } from "../db.js";
import { HttpError, bad, unauthorized, cookie, str, parseCookies } from "../http.js";

const SESSION_COOKIE = "gg_session";
const SESSION_DAYS = 30;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
function verifyPassword(pw, stored) {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const a = Buffer.from(hash, "hex"), b = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}
const normEmail = (e) => { const v = str(e, 200).toLowerCase(); if (!EMAIL_RE.test(v)) throw bad("Please enter a valid email.", "INVALID_EMAIL"); return v; };
const checkPassword = (pw) => { if (typeof pw !== "string" || pw.length < 8) throw bad("Password must be at least 8 characters.", "WEAK_PASSWORD"); };

/* ---------------- email (outbox + optional Resend) ---------------- */
export async function sendEmail(to, subject, body) {
  run("INSERT INTO outbox (id, to_email, subject, body, created_at) VALUES (?,?,?,?,?)", uid(), to, subject, body, now());
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text: body }),
      });
    } catch (e) { console.error("[email] send failed:", e.message); }
  } else {
    console.log(`[email] to=${to} subject="${subject}"\n${body}\n`);
  }
}

/* ---------------- sessions ---------------- */
function createSession(res, userId) {
  const token = randomBytes(32).toString("base64url");
  run("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)", sha(token), userId, Date.now() + SESSION_DAYS * 864e5, now());
  res.setHeader("set-cookie", cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }));
  return token;
}

/** Resolve the caller from session cookie, Bearer token, or org API key. */
export function authenticate(req) {
  const bearer = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer || parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const s = one("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?", sha(token));
    if (s && s.expires_at > Date.now()) {
      const user = one("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL", s.user_id);
      if (user) return { user, via: "session" };
    }
  }
  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    const org = one("SELECT * FROM organizations WHERE api_key_hash = ?", sha(String(apiKey)));
    if (org) return { user: one("SELECT * FROM users WHERE id = ?", org.owner_id), via: "api_key", orgId: org.id };
  }
  return null;
}

export const userDto = (u) => u && ({ id: u.id, email: u.email, name: u.name, emailVerified: !!u.email_verified, createdAt: u.created_at });

/** Create user + organization + owner membership + trial subscription. */
export function createAccount({ email, password, name }) {
  return tx(() => {
    if (one("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "An account with this email already exists. Please sign in.", "EMAIL_TAKEN");
    const userId = uid(), orgId = uid(), t = now();
    run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", userId, email, name || email.split("@")[0], password ? hashPassword(password) : null, t);
    run("INSERT INTO organizations (id, name, owner_id, created_at) VALUES (?,?,?,?)", orgId, (name || email.split("@")[0]) + "'s team", userId, t);
    run("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)", orgId, userId, "owner");
    const trialEnds = new Date(Date.now() + 3 * 864e5).toISOString();
    run("INSERT INTO subscriptions (org_id, plan, status, trial_ends_at, updated_at) VALUES (?,?,?,?,?)", orgId, "grow", "trialing", trialEnds, t);
    return { user: one("SELECT * FROM users WHERE id = ?", userId), orgId };
  });
}

export function orgForUser(userId) {
  return one("SELECT o.*, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at LIMIT 1", userId);
}

/* ---------------- handlers ---------------- */
export async function signUp(ctx) {
  const email = normEmail(ctx.body.email);
  checkPassword(ctx.body.password);
  const { user } = createAccount({ email, password: ctx.body.password, name: str(ctx.body.name, 80) });
  createSession(ctx.res, user.id);
  await sendEmail(email, "Welcome to GeoGrowth", "Your account is ready. Your 3-day trial has started.");
  return { data: { user: userDto(user) } };
}

export function signIn(ctx) {
  const email = normEmail(ctx.body.email);
  const user = one("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL", email);
  if (!user || !verifyPassword(String(ctx.body.password || ""), user.password_hash)) throw unauthorized("Incorrect email or password.");
  createSession(ctx.res, user.id);
  return { data: { user: userDto(user) } };
}

export function signInMethods(ctx) {
  const email = normEmail(ctx.query.email);
  const user = one("SELECT password_hash FROM users WHERE email = ? AND deleted_at IS NULL", email);
  return { data: { exists: !!user, password: !!user?.password_hash, code: true } };
}

/** Sends a 6-digit sign-in code (reference: SIGN_IN_LINK + VERIFY_SIGN_IN_CODE). */
export async function signInLink(ctx) {
  const email = normEmail(ctx.body.email);
  const user = one("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL", email);
  if (user) {
    const code = String(randomInt(0, 1e6)).padStart(6, "0");
    run("INSERT OR REPLACE INTO sign_in_codes (email, code_hash, expires_at, attempts) VALUES (?,?,?,0)", email, sha(code), Date.now() + 10 * 60e3);
    await sendEmail(email, "Your GeoGrowth sign-in code", `Your sign-in code is ${code}. It expires in 10 minutes.`);
  }
  return { data: { sent: true } }; // same response whether or not the account exists
}

export function verifySignInCode(ctx) {
  const email = normEmail(ctx.body.email);
  const row = one("SELECT * FROM sign_in_codes WHERE email = ?", email);
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, "This code has expired. Request a new one.", "SIGN_IN_LINK_EXPIRED");
  if (row.attempts >= 5) throw new HttpError(429, "Too many attempts. Request a new code.", "SIGN_IN_CODE_ATTEMPTS_EXCEEDED");
  if (sha(str(ctx.body.code, 10)) !== row.code_hash) {
    run("UPDATE sign_in_codes SET attempts = attempts + 1 WHERE email = ?", email);
    throw new HttpError(400, "That code is not correct.", "SIGN_IN_CODE_INVALID");
  }
  run("DELETE FROM sign_in_codes WHERE email = ?", email);
  const user = one("SELECT * FROM users WHERE email = ?", email);
  run("UPDATE users SET email_verified = 1 WHERE id = ?", user.id);
  createSession(ctx.res, user.id);
  return { data: { user: userDto(user) } };
}

export function logout(ctx) {
  const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha(token));
  ctx.res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
  return { data: { ok: true } };
}

export function changePassword(ctx) {
  const u = ctx.user;
  if (u.password_hash && !verifyPassword(String(ctx.body.currentPassword || ""), u.password_hash)) throw bad("Current password is incorrect.");
  checkPassword(ctx.body.newPassword);
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(ctx.body.newPassword), u.id);
  return { data: { ok: true } };
}

export const resetPasswordRequest = (ctx) => signInLink(ctx);

export function getMe(ctx) {
  const org = orgForUser(ctx.user.id);
  return { data: { ...userDto(ctx.user), organizationId: org?.id, role: org?.role } };
}
export function updateMe(ctx) {
  const name = str(ctx.body.name, 80);
  if (name) run("UPDATE users SET name = ? WHERE id = ?", name, ctx.user.id);
  return getMe({ ...ctx, user: one("SELECT * FROM users WHERE id = ?", ctx.user.id) });
}
export function deleteMe(ctx) {
  run("UPDATE users SET deleted_at = ? WHERE id = ?", now(), ctx.user.id);
  run("DELETE FROM sessions WHERE user_id = ?", ctx.user.id);
  ctx.res.setHeader("set-cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
  return { data: { ok: true } };
}

/* ---------------- org API key ---------------- */
export function generateApiKey(ctx) {
  const key = "gg_" + randomBytes(24).toString("base64url");
  run("UPDATE organizations SET api_key_hash = ?, api_key_hint = ? WHERE id = ?", sha(key), key.slice(-4), ctx.org.id);
  return { data: { apiKey: key } }; // shown once
}
export function deleteApiKey(ctx) {
  run("UPDATE organizations SET api_key_hash = NULL, api_key_hint = NULL WHERE id = ?", ctx.org.id);
  return { data: { ok: true } };
}

export const listOutbox = (email) => all("SELECT subject, body, created_at FROM outbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 10", email);
