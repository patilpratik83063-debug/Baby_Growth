// Auth: login ID (username or email) + password, cookie sessions, org API keys.
// Endpoints: /auth/sign-up, /auth/sign-in, /auth/logout, /auth/change-password, /auth/config, /users/me.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
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

export const userDto = (u) => u && ({ id: u.id, username: u.username || null, email: u.email, name: u.name, createdAt: u.created_at });

const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const findByLogin = (id) => {
  const v = str(id, 200);
  if (!v) return null;
  return one("SELECT * FROM users WHERE deleted_at IS NULL AND (lower(username) = lower(?) OR email = lower(?))", v, v);
};

/**
 * Create or claim the owner login from ADMIN_USERNAME / ADMIN_PASSWORD (set in .env on the server).
 * - If a user with that username exists: nothing changes (so passwords changed in the app are kept),
 *   unless ADMIN_RESET_PASSWORD=1.
 * - Else the oldest existing account (which owns the existing data) gets this username and password.
 * - Else a new account is created.
 */
export function bootstrapAdmin() {
  const username = str(process.env.ADMIN_USERNAME, 40), password = String(process.env.ADMIN_PASSWORD || "");
  if (!username) return;
  if (!USERNAME_RE.test(username)) return console.error("[auth] ADMIN_USERNAME must be 3-40 letters, digits, . _ or -");
  if (password.length < 8) return console.error("[auth] ADMIN_PASSWORD must be at least 8 characters");
  const existing = one("SELECT * FROM users WHERE lower(username) = lower(?)", username);
  if (existing) {
    if (/^(1|true)$/i.test(process.env.ADMIN_RESET_PASSWORD || "")) { run("UPDATE users SET password_hash = ?, deleted_at = NULL WHERE id = ?", hashPassword(password), existing.id); console.log(`[auth] password reset for "${username}"`); }
    return;
  }
  const oldest = one("SELECT u.* FROM users u JOIN org_members m ON m.user_id = u.id AND m.role = 'owner' WHERE u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1");
  if (oldest) {
    run("UPDATE users SET username = ?, password_hash = ? WHERE id = ?", username, hashPassword(password), oldest.id);
    console.log(`[auth] login "${username}" assigned to the existing account ${oldest.email}`);
  } else {
    const { user } = createAccount({ email: `${username.toLowerCase()}@localhost.local`, password, name: username });
    run("UPDATE users SET username = ? WHERE id = ?", username, user.id);
    console.log(`[auth] created owner login "${username}"`);
  }
}

/** Owner creates a teammate login (no email needed). */
export function addMember(ctx) {
  const username = str(ctx.body.username, 40);
  if (!USERNAME_RE.test(username)) throw bad("Login ID must be 3-40 letters, digits, dots, dashes or underscores.");
  checkPassword(ctx.body.password);
  if (one("SELECT 1 FROM users WHERE lower(username) = lower(?)", username)) throw new HttpError(409, "That login ID is taken.");
  const id = uid();
  run("INSERT INTO users (id, email, username, name, password_hash, created_at) VALUES (?,?,?,?,?,?)", id, `${username.toLowerCase()}.${id.slice(0, 6)}@localhost.local`, username, username, hashPassword(ctx.body.password), now());
  run("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)", ctx.org.id, id, "member");
  return { data: { ok: true, username } };
}

/** Sign-ups are open unless ALLOW_SIGNUP=0 (personal deployments: create your account, then close it). */
export const signupsOpen = () => !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_SIGNUP ?? "1").trim());
export function assertSignupsOpen() {
  if (!signupsOpen()) throw new HttpError(403, "New sign-ups are closed on this server.", "SIGNUP_CLOSED");
}

/** Create user + organization + owner membership. */
export function createAccount({ email, password, name }) {
  return tx(() => {
    if (one("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "An account with this email already exists. Please sign in.", "EMAIL_TAKEN");
    const userId = uid(), orgId = uid(), t = now();
    run("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", userId, email, name || email.split("@")[0], hashPassword(password), t);
    run("INSERT INTO organizations (id, name, owner_id, created_at) VALUES (?,?,?,?)", orgId, (name || email.split("@")[0]) + "'s team", userId, t);
    run("INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)", orgId, userId, "owner");
    return { user: one("SELECT * FROM users WHERE id = ?", userId), orgId };
  });
}

export function orgForUser(userId) {
  return one("SELECT o.*, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at LIMIT 1", userId);
}

/* ---------------- handlers ---------------- */
export { normEmail, checkPassword, createSession };

export function signUp(ctx) {
  assertSignupsOpen();
  const email = normEmail(ctx.body.email);
  checkPassword(ctx.body.password);
  const { user } = createAccount({ email, password: ctx.body.password, name: str(ctx.body.name, 80) });
  createSession(ctx.res, user.id);
  return { data: { user: userDto(user) } };
}

export function signIn(ctx) {
  const user = findByLogin(ctx.body.id ?? ctx.body.username ?? ctx.body.email);
  if (!user || !verifyPassword(String(ctx.body.password || ""), user.password_hash)) throw unauthorized("Incorrect ID or password.");
  createSession(ctx.res, user.id);
  return { data: { user: userDto(user) } };
}

export const authConfig = () => ({ data: { signupsOpen: signupsOpen() } });

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
  // sign out every other session of this user
  const current = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
  run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", u.id, current ? sha(current) : "");
  return { data: { ok: true } };
}

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

