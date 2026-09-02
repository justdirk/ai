// dirk.it AI gate — the paywall in front of LibreChat (chat.dirk.it) and the
// app builder (build.dirk.it). No changes to LibreChat itself: the gate talks
// to LibreChat's MongoDB to create users, set weekly credit balances and mint
// set-password links, and it issues a signed cookie for .dirk.it that the
// bolt middleware checks.
//
// Who gets in:
//   1. current course students — a live Stripe subscription carrying the
//      "Dirk It Membership" product, or (if COURSE_ACCESS_TOKEN is set) the
//      course project's dirk-course-access endpoint says {active:true}. Free.
//   2. everyone else — Stripe Checkout, "dirk.it AI" subscription. Cancelling
//      the subscription zeroes the balance and turns auto-refill off.
//
// Flow: dirk.it/chat/ → POST /api/access {email}
//   entitled  → provision + email a one-time sign-in link  → {status:'sent'}
//   otherwise → Stripe Checkout URL                         → {status:'checkout', url}
// The sign-in link hits GET /auth/verify?t=… which sets the .dirk.it cookie and
// forwards to LibreChat (set-password page the first time, login afterwards) or
// to the app builder when the link was requested from there.

import http from "node:http";
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import Stripe from "stripe";
import bcrypt from "bcryptjs";

const env = (k, d) => (process.env[k] ?? d);
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };

const PORT = parseInt(env("PORT", "8080"), 10);
const MONGO_URI = need("MONGO_URI");
const SITE_URL = env("SITE_URL", "https://dirk.it").replace(/\/$/, "");
const CHAT_URL = env("CHAT_URL", "https://chat.dirk.it").replace(/\/$/, "");
const BUILD_URL = env("BUILD_URL", "https://build.dirk.it").replace(/\/$/, "");
const GATE_URL = env("GATE_URL", "https://gate.dirk.it").replace(/\/$/, "");
const COOKIE_DOMAIN = env("COOKIE_DOMAIN", ".dirk.it");
const COOKIE_NAME = env("COOKIE_NAME", "dirkit_ai");
const COOKIE_SECRET = need("COOKIE_SECRET");
const COOKIE_DAYS = parseInt(env("COOKIE_DAYS", "30"), 10);
const WEEKLY_CREDITS = parseInt(env("WEEKLY_CREDITS", "2000000"), 10); // 1,000,000 ≈ $1
const COURSE_ACCESS_URL = env("COURSE_ACCESS_URL", "https://jbbvoajtbgzhxnbcpkcc.supabase.co/functions/v1/dirk-course-access");
const COURSE_ACCESS_TOKEN = env("COURSE_ACCESS_TOKEN", "");
const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "");
const STRIPE_WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET", "");
const STRIPE_PRICE_AI = env("STRIPE_PRICE_AI", "");
const RESEND_API_KEY = env("RESEND_API_KEY", "");
const MAIL_FROM = env("MAIL_FROM", "dirk.it AI <ai@send.dirk.it>");
const MAIL_REPLY_TO = env("MAIL_REPLY_TO", "mail@dirk.it");
const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS", "https://dirk.it,https://www.dirk.it").split(",").map((s) => s.trim());
const PRODUCT_CODE = "dirk_ai_workspace";
// Course purchases carry the recurring "Dirk It Membership" product; a live
// subscription with it makes the buyer a current student (AI included).
const MEMBERSHIP_PRODUCTS = env("MEMBERSHIP_PRODUCTS", "prod_Uu65TBAHuI9huF").split(",").map((s) => s.trim()).filter(Boolean);
const LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const mongo = new MongoClient(MONGO_URI);
await mongo.connect();
const db = mongo.db(); // LibreChat database (from the URI)
const Users = db.collection("users");
const Balances = db.collection("balances");
const Tokens = db.collection("tokens");
const Members = db.collection("aigate_members");
const Links = db.collection("aigate_links");
await Members.createIndex({ email: 1 }, { unique: true });
await Members.createIndex({ stripeSubscriptionId: 1 });
await Links.createIndex({ tokenHash: 1 }, { unique: true });
await Links.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => new Date();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (s) => crypto.createHmac("sha256", COOKIE_SECRET).update(s).digest("base64url");
const normEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;

// ---------- rate limiting (per process; fine for one instance) ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key) || [];
  const fresh = b.filter((x) => t - x < windowMs);
  if (fresh.length >= max) { buckets.set(key, fresh); return true; }
  fresh.push(t); buckets.set(key, fresh); return false;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of buckets) if (!v.some((x) => t - x < 3600e3)) buckets.delete(k); }, 600e3).unref();

// ---------- entitlement ----------
async function courseActive(email) {
  if (!COURSE_ACCESS_TOKEN) return false;
  try {
    const r = await fetch(COURSE_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-course-token": COURSE_ACCESS_TOKEN },
      body: JSON.stringify({ email }),
    });
    if (!r.ok) { log("course-access", r.status); return false; }
    const j = await r.json();
    return j.active === true;
  } catch (e) { log("course-access error", e.message); return false; }
}

async function stripeStudent(email) {
  if (!stripe) return false;
  try {
    const found = await stripe.customers.search({ query: `email:'${email.replace(/'/g, "\\'")}'`, limit: 10 });
    for (const c of found.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 20 });
      for (const sub of subs.data) {
        if (!LIVE_STATUSES.has(sub.status)) continue;
        if (sub.items.data.some((it) => MEMBERSHIP_PRODUCTS.includes(typeof it.price.product === "string" ? it.price.product : it.price.product?.id))) return true;
      }
    }
  } catch (e) { log("stripe student check error", e.message); }
  return false;
}
const isStudent = async (email) => (await courseActive(email)) || (await stripeStudent(email));

async function entitlement(email) {
  const m = await Members.findOne({ email });
  if (m?.active && m.source === "stripe") return { ok: true, source: "stripe", member: m };
  if (await isStudent(email)) {
    await Members.updateOne(
      { email },
      { $set: { active: true, source: "course", lastCheckedAt: now(), updatedAt: now() }, $setOnInsert: { createdAt: now() } },
      { upsert: true },
    );
    return { ok: true, source: "course" };
  }
  if (m?.active && m.source === "course") {
    // course lapsed since last check
    await deactivate(email, "course lapsed");
  }
  return { ok: false };
}

// ---------- LibreChat provisioning ----------
async function provision(email) {
  let user = await Users.findOne({ email });
  if (!user) {
    const doc = {
      name: email.split("@")[0],
      username: "",
      email,
      emailVerified: true,
      password: bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10),
      avatar: null,
      provider: "local",
      role: "USER",
      termsAccepted: false,
      createdAt: now(),
      updatedAt: now(),
    };
    const r = await Users.insertOne(doc);
    user = { ...doc, _id: r.insertedId };
    log("created librechat user", email);
  }
  await Balances.updateOne(
    { user: user._id },
    {
      $set: { autoRefillEnabled: true, refillIntervalValue: 7, refillIntervalUnit: "days", refillAmount: WEEKLY_CREDITS },
      $setOnInsert: { tokenCredits: WEEKLY_CREDITS, lastRefill: now() },
    },
    { upsert: true },
  );
  return user;
}

async function reactivateCredits(userId) {
  await Balances.updateOne({ user: userId }, { $set: { tokenCredits: WEEKLY_CREDITS, lastRefill: now(), autoRefillEnabled: true } });
}

async function deactivate(email, why) {
  const user = await Users.findOne({ email });
  if (user) await Balances.updateOne({ user: user._id }, { $set: { tokenCredits: 0, autoRefillEnabled: false } });
  await Members.updateOne({ email }, { $set: { active: false, deactivatedAt: now(), deactivatedWhy: why, updatedAt: now() } });
  log("deactivated", email, why);
}

// One-time LibreChat set-password link (same shape LibreChat's own reset flow reads).
async function setPasswordLink(user) {
  const raw = crypto.randomBytes(32).toString("hex");
  await Tokens.deleteMany({ userId: user._id, email: null, identifier: null, type: null });
  await Tokens.insertOne({
    userId: user._id,
    token: bcrypt.hashSync(raw, 10),
    createdAt: now(),
    expiresAt: new Date(Date.now() + 24 * 3600e3),
  });
  return `${CHAT_URL}/reset-password?token=${raw}&userId=${user._id}`;
}

// ---------- sign-in links + cookie ----------
async function makeSigninLink(email, next) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await Links.insertOne({ tokenHash: sha256(raw), email, next: next || "chat", createdAt: now(), expiresAt: new Date(Date.now() + 30 * 60e3) });
  return `${GATE_URL}/auth/verify?t=${raw}`;
}

function cookieValue(email) {
  const payload = b64u(JSON.stringify({ e: email, x: Date.now() + COOKIE_DAYS * 86400e3 }));
  return `${payload}.${hmac(payload)}`;
}
export function verifyCookie(v) {
  if (!v || !v.includes(".")) return null;
  const [payload, sig] = v.split(".");
  if (hmac(payload) !== sig) return null;
  try { const j = JSON.parse(Buffer.from(payload, "base64url").toString()); return j.x > Date.now() ? j.e : null; } catch { return null; }
}

// ---------- email ----------
async function sendMail(to, subject, html, text) {
  if (!RESEND_API_KEY) { log("EMAIL NOT CONFIGURED — would send to", to, subject); return false; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], reply_to: MAIL_REPLY_TO, subject, html, text }),
  });
  if (!r.ok) { log("resend failed", r.status, await r.text()); return false; }
  return true;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mailTemplate({ title, intro, cta, url, foot }) {
  const html = `<!doctype html><body style="margin:0;background:#0A0A09;color:#F2EFE9;font-family:Helvetica Neue,Helvetica,Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:40px 24px"><div style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#E0B15C;margin-bottom:18px">dirk.it AI</div><h1 style="font-size:26px;font-weight:500;margin:0 0 14px;line-height:1.2">${esc(title)}</h1><p style="font-size:16px;line-height:1.6;color:#C9C4B9;margin:0 0 26px">${esc(intro)}</p><a href="${url}" style="display:inline-block;background:#E0B15C;color:#0A0A09;font-weight:600;font-size:15px;padding:14px 26px;text-decoration:none;border-radius:2px">${esc(cta)}</a><p style="font-size:13px;line-height:1.6;color:#8A8478;margin:28px 0 0">${esc(foot)}<br>If the button doesn't work, copy this link: <span style="color:#9B958A;word-break:break-all">${esc(url)}</span></p></div></body>`;
  const text = `${title}\n\n${intro}\n\n${cta}: ${url}\n\n${foot}`;
  return { html, text };
}

async function sendSignin(email, next, firstTime) {
  const url = await makeSigninLink(email, next);
  const m = firstTime
    ? mailTemplate({ title: "Your dirk.it AI workspace is ready.", intro: "One click sets your password and opens the workspace: curated frontier models, weekly credits, the app builder — included with your membership.", cta: "Open my workspace", url, foot: "This link works once and expires in 30 minutes. Requested at dirk.it — if that wasn't you, ignore this email." })
    : mailTemplate({ title: "Sign in to dirk.it AI", intro: "Here is your one-time sign-in link.", cta: "Sign in", url, foot: "This link works once and expires in 30 minutes. Requested at dirk.it — if that wasn't you, ignore this email." });
  return sendMail(email, firstTime ? "Your dirk.it AI workspace is ready" : "Your dirk.it AI sign-in link", m.html, m.text);
}

// ---------- Stripe ----------
async function checkoutUrl(email, lang) {
  if (!stripe || !STRIPE_PRICE_AI) throw new Error("stripe not configured");
  const s = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: STRIPE_PRICE_AI, quantity: 1 }],
    customer_email: email,
    allow_promotion_codes: true,
    success_url: `${SITE_URL}/chat/?paid=1`,
    cancel_url: `${SITE_URL}/chat/`,
    locale: ["de", "es", "pt-BR", "it", "en"].includes(lang) ? lang : "auto",
    metadata: { product_code: PRODUCT_CODE, email },
    subscription_data: { metadata: { product_code: PRODUCT_CODE, email } },
  });
  return s.url;
}

async function handleStripe(event) {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (o.metadata?.product_code !== PRODUCT_CODE) {
        // A course purchase? (payment link with the membership product)
        let items = []; try { items = (await stripe.checkout.sessions.listLineItems(o.id, { limit: 10 })).data; } catch (e) { log("listLineItems", e.message); }
        const isCourse = items.some((li) => MEMBERSHIP_PRODUCTS.includes(typeof li.price?.product === "string" ? li.price.product : li.price?.product?.id));
        if (!isCourse) return "ignored";
        const email = normEmail(o.customer_details?.email || o.customer_email);
        if (!email) return "no email";
        const prev = await Members.findOne({ email });
        await Members.updateOne(
          { email },
          { $set: { active: true, source: "course", stripeCustomerId: typeof o.customer === "string" ? o.customer : null, courseSubscriptionId: typeof o.subscription === "string" ? o.subscription : null, lastCheckedAt: now(), updatedAt: now() }, $setOnInsert: { createdAt: now() } },
          { upsert: true },
        );
        const user = await provision(email);
        if (prev && prev.active === false) await reactivateCredits(user._id);
        await sendSignin(email, "chat", !prev?.lcInitialized);
        return "student provisioned";
      }
      const email = normEmail(o.customer_details?.email || o.customer_email || o.metadata?.email);
      if (!email) return "no email";
      const prev = await Members.findOne({ email });
      await Members.updateOne(
        { email },
        { $set: { active: true, source: "stripe", stripeCustomerId: typeof o.customer === "string" ? o.customer : null, stripeSubscriptionId: typeof o.subscription === "string" ? o.subscription : null, updatedAt: now() }, $setOnInsert: { createdAt: now() } },
        { upsert: true },
      );
      const user = await provision(email);
      if (prev && prev.active === false) await reactivateCredits(user._id);
      await sendSignin(email, "chat", !prev?.lcInitialized);
      return "provisioned";
    }
    case "customer.subscription.deleted": {
      const isMembership = o.items?.data?.some((it) => MEMBERSHIP_PRODUCTS.includes(typeof it.price?.product === "string" ? it.price.product : it.price?.product?.id));
      if (o.metadata?.product_code !== PRODUCT_CODE && !isMembership) return "ignored";
      const m = await Members.findOne({ $or: [{ stripeSubscriptionId: o.id }, { courseSubscriptionId: o.id }] });
      if (!m) return "unknown subscription";
      // a student who also pays for AI separately keeps it; otherwise re-evaluate
      if (await entitlement(m.email).then((e) => e.ok && e.source !== m.source)) return "still entitled via other source";
      await deactivate(m.email, "subscription deleted");
      return "deactivated";
    }
    case "customer.subscription.updated": {
      const isMembership = o.items?.data?.some((it) => MEMBERSHIP_PRODUCTS.includes(typeof it.price?.product === "string" ? it.price.product : it.price?.product?.id));
      if (o.metadata?.product_code !== PRODUCT_CODE && !isMembership) return "ignored";
      const m = await Members.findOne({ $or: [{ stripeSubscriptionId: o.id }, { courseSubscriptionId: o.id }] });
      if (!m) return "unknown subscription";
      if (["canceled", "unpaid", "incomplete_expired"].includes(o.status) && m.active) await deactivate(m.email, `subscription ${o.status}`);
      if (LIVE_STATUSES.has(o.status) && !m.active) {
        await Members.updateOne({ email: m.email }, { $set: { active: true, updatedAt: now() } });
        const user = await provision(m.email); await reactivateCredits(user._id);
      }
      return "ok";
    }
    default: return "ignored";
  }
}

// ---------- HTTP ----------
const json = (res, code, body, extra = {}) => { res.writeHead(code, { "content-type": "application/json", ...extra }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on("data", (d) => { c.push(d); if (c.reduce((n, b) => n + b.length, 0) > 64e3) reject(new Error("too large")); }); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", reject); });
function cors(req) {
  const o = req.headers.origin;
  return ALLOWED_ORIGINS.includes(o) ? { "access-control-allow-origin": o, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", vary: "Origin" } : {};
}
const ip = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, GATE_URL);
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); return res.end(); }
    if (url.pathname === "/health") return json(res, 200, { ok: true, stripe: !!stripe, email: !!RESEND_API_KEY, course: !!COURSE_ACCESS_TOKEN });

    if (req.method === "POST" && url.pathname === "/api/access") {
      const h = cors(req);
      if (limited("ip:" + ip(req), 20, 10 * 60e3)) return json(res, 429, { error: "Too many requests. Try again in a few minutes." }, h);
      let body; try { body = JSON.parse((await readBody(req)).toString() || "{}"); } catch { return json(res, 400, { error: "Bad request" }, h); }
      const email = normEmail(body.email); const next = body.next === "build" ? "build" : "chat"; const lang = String(body.lang || "en").slice(0, 5);
      if (!validEmail(email)) return json(res, 400, { error: "That doesn't look like an email address." }, h);
      if (limited("email:" + email, 5, 3600e3)) return json(res, 429, { error: "Too many links requested for this address. Check your inbox, or try again in an hour." }, h);
      const ent = await entitlement(email);
      if (ent.ok) {
        const m = await Members.findOne({ email });
        await provision(email);
        const sent = await sendSignin(email, next, !m?.lcInitialized);
        if (!sent) return json(res, 503, { error: "Email delivery isn't configured yet. Write to mail@dirk.it and we'll set you up by hand." }, h);
        return json(res, 200, { status: "sent", source: ent.source }, h);
      }
      try { return json(res, 200, { status: "checkout", url: await checkoutUrl(email, lang) }, h); }
      catch (e) { log("checkout error", e.message); return json(res, 503, { error: "Payments aren't available right now. Write to mail@dirk.it." }, h); }
    }

    if (req.method === "GET" && url.pathname === "/auth/verify") {
      const raw = url.searchParams.get("t") || "";
      const link = raw && (await Links.findOneAndUpdate({ tokenHash: sha256(raw), usedAt: null, expiresAt: { $gt: now() } }, { $set: { usedAt: now() } }));
      const doc = link?.value ?? link; // driver v5/v6 return shapes
      if (!doc || !doc.email) { res.writeHead(302, { location: `${SITE_URL}/chat/?expired=1` }); return res.end(); }
      const email = doc.email;
      const ent = await entitlement(email);
      if (!ent.ok) { res.writeHead(302, { location: `${SITE_URL}/chat/?inactive=1` }); return res.end(); }
      const user = await provision(email);
      const m = await Members.findOne({ email });
      let dest;
      if (!m?.lcInitialized) {
        dest = await setPasswordLink(user);
        await Members.updateOne({ email }, { $set: { lcInitialized: true, updatedAt: now() } });
      } else {
        dest = doc.next === "build" ? `${BUILD_URL}/` : `${CHAT_URL}/login`;
      }
      const cookie = `${COOKIE_NAME}=${encodeURIComponent(cookieValue(email))}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; Secure; HttpOnly; SameSite=Lax`;
      res.writeHead(302, { location: dest, "set-cookie": cookie, "cache-control": "no-store" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/logout") {
      res.writeHead(302, { location: `${SITE_URL}/chat/`, "set-cookie": `${COOKIE_NAME}=; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/me") {
      const email = verifyCookie(parseCookies(req)[COOKIE_NAME]);
      return json(res, email ? 200 : 401, email ? { email } : { error: "not signed in" }, cors(req));
    }

    if (req.method === "POST" && url.pathname === "/webhooks/stripe") {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) return json(res, 503, { error: "stripe not configured" });
      const body = await readBody(req);
      let event;
      try { event = stripe.webhooks.constructEvent(body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET); }
      catch (e) { log("bad stripe signature", e.message); return json(res, 400, { error: "bad signature" }); }
      const out = await handleStripe(event);
      log("stripe", event.type, out);
      return json(res, 200, { received: true, result: out });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    log("error", req.method, url.pathname, e.stack || e.message);
    json(res, 500, { error: "internal error" });
  }
});

// Daily: course members lose access when their course subscription ends.
setInterval(async () => {
  try {
    const cur = Members.find({ source: "course", active: true });
    for await (const m of cur) {
      if (!(await isStudent(m.email))) await deactivate(m.email, "course lapsed (daily check)");
      else await Members.updateOne({ email: m.email }, { $set: { lastCheckedAt: now() } });
    }
  } catch (e) { log("daily check error", e.message); }
}, 24 * 3600e3).unref();

server.listen(PORT, "0.0.0.0", () => log(`gate listening on ${PORT}`, { stripe: !!stripe, email: !!RESEND_API_KEY, course: !!COURSE_ACCESS_TOKEN }));
