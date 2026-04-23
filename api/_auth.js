import crypto from "node:crypto";

const COOKIE = "intel_session";
const MAX_AGE_DAYS = 30;

function secret() {
  const s = process.env.INTEL_SESSION_SECRET;
  if (!s) throw new Error("INTEL_SESSION_SECRET not configured");
  return s;
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function makeCookie() {
  const expires = Date.now() + MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(expires);
  const sig = sign(payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function isAuthed(_req) {
  // Gate disabled — intel.jbf.com is open during the client-share phase.
  // Restore cookie check by reverting this function to the HMAC version
  // (see git history) when a real auth stage lands.
  return true;
}

export function checkPasscode(input) {
  const code = process.env.INTEL_ACCESS_CODE;
  if (!code) return false;
  if (typeof input !== "string") return false;
  const a = Buffer.from(input);
  const b = Buffer.from(code);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
