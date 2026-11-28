// Plans, limits and Stripe billing (REST API, no SDK).
// Prices observed on the reference: Grow $99/mo, Scale $399/mo, 3-day trial.
// Reference endpoints: /subscriptions/create-customer-checkout, /create-portal-session, /get-org-website-subscription,
// /cancel-subscription, /invoices.
import { createHmac, timingSafeEqual } from "node:crypto";
import { one, run, now } from "../db.js";
import { HttpError, bad } from "../http.js";
import { PUBLIC_BASE_URL } from "./publishing.js";

export const PLANS = {
  trial: { name: "Trial", price: 0, websites: 1, articlesPerMonth: 3, prompts: 8 },
  grow: { name: "Grow", price: 99, websites: 1, articlesPerMonth: 30, prompts: 10 },
  scale: { name: "Scale", price: 399, websites: 5, articlesPerMonth: 150, prompts: 50 },
};

export function subscriptionFor(orgId) {
  const s = one("SELECT * FROM subscriptions WHERE org_id = ?", orgId);
  if (!s) return { plan: "trial", status: "none", active: false };
  const trialing = s.status === "trialing" && s.trial_ends_at && new Date(s.trial_ends_at) > new Date();
  const active = s.status === "active" || trialing;
  return { plan: s.plan, status: trialing ? "trialing" : s.status === "trialing" ? "trial_ended" : s.status, active, trialEndsAt: s.trial_ends_at, currentPeriodEnd: s.current_period_end, hasBilling: !!s.stripe_customer };
}
export function planLimits(orgId) {
  const s = subscriptionFor(orgId);
  return s.status === "active" ? PLANS[s.plan] || PLANS.grow : PLANS.trial;
}
export function articlesThisMonth(orgId) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  return one("SELECT COUNT(*) n FROM articles a JOIN websites w ON w.id = a.website_id WHERE w.org_id = ? AND a.created_at >= ?", orgId, start.toISOString()).n;
}

/* ---------------- Stripe REST ---------------- */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === "object") form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, body) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "Billing is not configured (set STRIPE_SECRET_KEY).", "BILLING_NOT_CONFIGURED");
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: body ? form(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new HttpError(502, data?.error?.message || "Stripe request failed.", "STRIPE_ERROR");
  return data;
}

/* ---------------- API ---------------- */
export function getSubscription(ctx) {
  const s = subscriptionFor(ctx.org.id);
  const limits = planLimits(ctx.org.id);
  return { data: { ...s, limits, usage: { articlesThisMonth: articlesThisMonth(ctx.org.id) }, plans: PLANS } };
}

export async function createCheckout(ctx) {
  const plan = ctx.body.plan === "scale" ? "scale" : "grow";
  const price = plan === "scale" ? process.env.STRIPE_PRICE_SCALE : process.env.STRIPE_PRICE_GROW;
  if (!price) throw new HttpError(503, `Set STRIPE_PRICE_${plan.toUpperCase()} to the Stripe price ID.`, "BILLING_NOT_CONFIGURED");
  let sub = one("SELECT * FROM subscriptions WHERE org_id = ?", ctx.org.id);
  let customer = sub?.stripe_customer;
  if (!customer) {
    customer = (await stripe("POST", "/customers", { email: ctx.user.email, metadata: { org_id: ctx.org.id } })).id;
    run("INSERT INTO subscriptions (org_id, plan, status, stripe_customer, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET stripe_customer = excluded.stripe_customer, updated_at = excluded.updated_at",
      ctx.org.id, plan, sub?.status || "incomplete", customer, now());
  }
  const session = await stripe("POST", "/checkout/sessions", {
    mode: "subscription", customer, client_reference_id: ctx.org.id,
    line_items: { 0: { price, quantity: 1 } },
    subscription_data: { metadata: { org_id: ctx.org.id, plan } },
    success_url: `${PUBLIC_BASE_URL()}/app.html#billing?checkout=success`, cancel_url: `${PUBLIC_BASE_URL()}/app.html#billing?checkout=cancelled`,
    allow_promotion_codes: "true",
  });
  return { data: { url: session.url } };
}

export async function createPortal(ctx) {
  const sub = one("SELECT stripe_customer FROM subscriptions WHERE org_id = ?", ctx.org.id);
  if (!sub?.stripe_customer) throw bad("No billing account yet. Choose a plan first.");
  const s = await stripe("POST", "/billing_portal/sessions", { customer: sub.stripe_customer, return_url: `${PUBLIC_BASE_URL()}/app.html#billing` });
  return { data: { url: s.url } };
}

export async function cancelSubscription(ctx) {
  const sub = one("SELECT * FROM subscriptions WHERE org_id = ?", ctx.org.id);
  if (!sub?.stripe_subscription) { run("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE org_id = ?", now(), ctx.org.id); return { data: { ok: true } }; }
  await stripe("POST", `/subscriptions/${sub.stripe_subscription}`, { cancel_at_period_end: "true" });
  return { data: { ok: true, cancelAtPeriodEnd: true } };
}

export async function invoices(ctx) {
  const sub = one("SELECT stripe_customer FROM subscriptions WHERE org_id = ?", ctx.org.id);
  if (!sub?.stripe_customer || !process.env.STRIPE_SECRET_KEY) return { data: [] };
  const list = await stripe("GET", `/invoices?customer=${encodeURIComponent(sub.stripe_customer)}&limit=24`);
  return { data: list.data.map((i) => ({ id: i.id, number: i.number, total: i.total / 100, currency: i.currency, status: i.status, createdAt: new Date(i.created * 1000).toISOString(), pdf: i.invoice_pdf, url: i.hosted_invoice_url })) };
}

/** Stripe webhook: verify signature (t + v1 HMAC-SHA256 over "t.rawBody"), then sync subscription state. */
export function stripeWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, "Webhook secret not configured.");
  const parts = Object.fromEntries(String(signatureHeader || "").split(",").map((kv) => kv.split("=")));
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const given = Buffer.from(parts.v1 || "", "hex"), exp = Buffer.from(expected, "hex");
  if (!parts.t || given.length !== exp.length || !timingSafeEqual(given, exp) || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) throw new HttpError(400, "Invalid signature.");
  const event = JSON.parse(rawBody);
  const obj = event.data?.object || {};
  if (event.type?.startsWith("customer.subscription.")) {
    const orgId = obj.metadata?.org_id || one("SELECT org_id FROM subscriptions WHERE stripe_customer = ?", obj.customer)?.org_id;
    if (orgId) {
      const priceId = obj.items?.data?.[0]?.price?.id;
      const plan = obj.metadata?.plan || (priceId === process.env.STRIPE_PRICE_SCALE ? "scale" : "grow");
      run("INSERT INTO subscriptions (org_id, plan, status, stripe_customer, stripe_subscription, current_period_end, updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, stripe_customer = excluded.stripe_customer, stripe_subscription = excluded.stripe_subscription, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at",
        orgId, plan, event.type === "customer.subscription.deleted" ? "canceled" : obj.status, obj.customer, obj.id,
        obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null, now());
    }
  }
  return { received: true };
}
