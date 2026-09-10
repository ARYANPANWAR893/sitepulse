import "server-only";
import {
  randomBytes, randomInt, scrypt as _scrypt, timingSafeEqual,
  createHash, createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { db, now } from "./db.ts";

const scrypt = promisify(_scrypt) as (
  pw: string | Buffer, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

// ---------------------------------------------------------------- secrets

function secret(): Buffer {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error("AUTH_SECRET missing or under 32 chars. Run: npm run gen-secret");
  }
  return Buffer.from(s, "utf8");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Keyed so a stolen DB alone can't brute-force 6-digit OTPs offline. */
const hmac = (s: string) => createHmac("sha256", secret()).update(s).digest("hex");

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- passwords

// OWASP-acceptable scrypt params. 128*N*r = 64MB, so maxmem must exceed that.
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const MAX_PW = 200; // cap input; unbounded length is a cheap CPU-burn vector

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scrypt(pw.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const derived = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64"), 64, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  const expected = Buffer.from(key, "base64");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Burned when the email doesn't exist, so login costs the same either way and
// can't be used to enumerate accounts by response time.
let decoy: string | null = null;
export async function burnPassword(pw: string): Promise<void> {
  decoy ??= await hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(pw.slice(0, MAX_PW), decoy).catch(() => false);
}

// ---------------------------------------------------------------- validation

export type Fail = { error: string; field?: string };

export function cleanEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@,;:<>"'()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(e)) return null;
  return e;
}

/** E.164. Rejects anything we can't send an SMS to. */
export function cleanPhone(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const p = v.replace(/[\s()\-.]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

export function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const n = v.trim().replace(/\s+/g, " ");
  return n.length >= 1 && n.length <= 100 ? n : null;
}

/** Length only — deliberately permits "12345678". */
export function checkPassword(v: unknown): { ok: true; pw: string } | Fail {
  if (typeof v !== "string") return { error: "Password is required.", field: "password" };
  if (v.length < 8) return { error: "Use at least 8 characters.", field: "password" };
  if (v.length > MAX_PW) return { error: `Keep it under ${MAX_PW} characters.`, field: "password" };
  return { ok: true, pw: v };
}

// ---------------------------------------------------------------- rate limit

const q = {
  rateGet: db.prepare("SELECT count, reset_at FROM rate WHERE k = ?"),
  rateSet: db.prepare("INSERT INTO rate (k, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET count = count + 1"),
  rateReset: db.prepare("UPDATE rate SET count = 1, reset_at = ? WHERE k = ?"),
  rateClear: db.prepare("DELETE FROM rate WHERE k = ?"),
};

/** Fixed window. Returns false once the caller is over budget. */
export function allow(key: string, limit: number, windowMs: number): boolean {
  const t = now();
  const row = q.rateGet.get(key) as { count: number; reset_at: number } | undefined;
  if (!row || row.reset_at <= t) {
    q.rateReset.run(t + windowMs, key);
    if (!row) q.rateSet.run(key, t + windowMs);
    return true;
  }
  if (row.count >= limit) return false;
  q.rateSet.run(key, t + windowMs);
  return true;
}

export const clearRate = (key: string) => q.rateClear.run(key);

// ---------------------------------------------------------------- sessions

const SESSION_COOKIE = "sp_session";
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // hard cap
const IDLE_MS = 24 * 60 * 60 * 1000;         // inactivity cutoff

export type User = {
  id: string; name: string; email: string; phone: string | null;
  email_verified: number; phone_verified: number; role: string; pending_phone: string | null;
  password_hash: string | null; google_sub: string | null;
};

const su = {
  insert: db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)"),
  join: db.prepare(`SELECT s.expires_at, s.last_seen, u.* FROM sessions s
                    JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
  touch: db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?"),
  del: db.prepare("DELETE FROM sessions WHERE id = ?"),
  delUser: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
};

/** Fresh token every time — logging in never reuses an attacker-supplied id. */
export function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const t = now();
  // Only the hash is stored: a dumped sessions table yields no usable cookie.
  su.insert.run(sha256(token), userId, t, t + ABSOLUTE_MS, t);
  return token;
}

export function readSession(token: string | undefined): User | null {
  if (!token) return null;
  const id = sha256(token);
  const row = su.join.get(id) as (User & { expires_at: number; last_seen: number }) | undefined;
  if (!row) return null;

  const t = now();
  if (row.expires_at <= t || row.last_seen + IDLE_MS <= t) {
    su.del.run(id);
    return null;
  }
  if (t - row.last_seen > 5 * 60 * 1000) su.touch.run(t, id);
  return row;
}

export function dropSession(token: string | undefined): void {
  if (token) su.del.run(sha256(token));
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_MAX_AGE = Math.floor(ABSOLUTE_MS / 1000);

/** Password change / reset kills every other device. */
export const endAllSessions = (userId: string) => su.delUser.run(userId);

// ---------------------------------------------------------------- OTP

const OTP_TTL = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

const oq = {
  put: db.prepare(`INSERT INTO otps (user_id, channel, target, code_hash, expires_at, attempts)
                   VALUES (?, ?, ?, ?, ?, 0)
                   ON CONFLICT(user_id, channel) DO UPDATE SET
                     target = excluded.target, code_hash = excluded.code_hash,
                     expires_at = excluded.expires_at, attempts = 0`),
  get: db.prepare("SELECT * FROM otps WHERE user_id = ? AND channel = ?"),
  bump: db.prepare("UPDATE otps SET attempts = attempts + 1 WHERE user_id = ? AND channel = ?"),
  del: db.prepare("DELETE FROM otps WHERE user_id = ? AND channel = ?"),
};

export type Channel = "email" | "phone";

export function issueOtp(userId: string, channel: Channel, target: string): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  oq.put.run(userId, channel, target, hmac(`${userId}:${channel}:${code}`), now() + OTP_TTL);
  return code;
}

export function checkOtp(userId: string, channel: Channel, code: unknown):
  { ok: true; target: string } | Fail {
  const row = oq.get.get(userId, channel) as
    { target: string; code_hash: string; expires_at: number; attempts: number } | undefined;
  if (!row) return { error: "Request a new code." };
  if (row.expires_at <= now()) {
    oq.del.run(userId, channel);
    return { error: "That code expired. Request a new one." };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    oq.del.run(userId, channel);
    return { error: "Too many wrong attempts. Request a new code." };
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    oq.bump.run(userId, channel);
    return { error: "Enter the 6-digit code." };
  }
  if (!equal(hmac(`${userId}:${channel}:${code.trim()}`), row.code_hash)) {
    oq.bump.run(userId, channel);
    return { error: "That code isn't right." };
  }
  oq.del.run(userId, channel); // single use
  return { ok: true, target: row.target };
}

// ---------------------------------------------------------------- reset tokens

const RESET_TTL = 30 * 60 * 1000;
const rq = {
  put: db.prepare("INSERT INTO resets (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)"),
  get: db.prepare("SELECT * FROM resets WHERE token_hash = ?"),
  use: db.prepare("UPDATE resets SET used = 1 WHERE token_hash = ?"),
  purge: db.prepare("DELETE FROM resets WHERE user_id = ?"),
};

export function issueReset(userId: string): string {
  rq.purge.run(userId); // only the newest link stays live
  const token = randomBytes(32).toString("base64url");
  rq.put.run(sha256(token), userId, now() + RESET_TTL);
  return token;
}

export function consumeReset(token: unknown): { ok: true; userId: string } | Fail {
  if (typeof token !== "string" || token.length < 20) return { error: "That link is invalid." };
  const h = sha256(token);
  const row = rq.get.get(h) as { user_id: string; expires_at: number; used: number } | undefined;
  if (!row || row.used || row.expires_at <= now()) return { error: "That link is invalid or expired." };
  rq.use.run(h);
  return { ok: true, userId: row.user_id };
}

// ---------------------------------------------------------------- users

export const uq = {
  byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  byPhone: db.prepare("SELECT * FROM users WHERE phone = ?"),
  byId: db.prepare("SELECT * FROM users WHERE id = ?"),
  byGoogle: db.prepare("SELECT * FROM users WHERE google_sub = ?"),
  insert: db.prepare(`INSERT INTO users (id, name, email, phone, password_hash, email_verified, phone_verified, google_sub, role, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'operator', ?)`),
  setEmailVerified: db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?"),
  setPhone: db.prepare("UPDATE users SET phone = ?, phone_verified = 1 WHERE id = ?"),
  setPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  // A password set on a never-verified row was never proven to belong to
  // anyone, so claiming the address via Google discards it. Without this, an
  // attacker can pre-register a victim's address and keep a working password.
  linkGoogle: db.prepare(`UPDATE users SET google_sub = ?,
      password_hash = CASE WHEN email_verified = 1 THEN password_hash ELSE NULL END,
      email_verified = 1
    WHERE id = ?`),
  setPendingPhone: db.prepare("UPDATE users SET pending_phone = ? WHERE id = ?"),
};

export const newId = () => randomBytes(16).toString("hex");

/** What a client is allowed to see. Never return password_hash to the browser. */
export const publicUser = (u: User) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone,
  emailVerified: !!u.email_verified, phoneVerified: !!u.phone_verified, role: u.role,
});

// ---------------------------------------------------------------- pending (pre-verification) cookie

export const PENDING_COOKIE_NAME = "sp_pending";
export const PENDING_MAX_AGE = 20 * 60;

/**
 * Names who is mid-verification. Signed so it can't be forged, but it grants
 * nothing on its own — the emailed/texted OTP is the actual gate.
 */
export const signPending = (userId: string) => `${userId}.${hmac("pending:" + userId)}`;

export function verifyPending(raw: string | undefined): User | null {
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 1) return null;
  const id = raw.slice(0, i);
  if (!equal(raw.slice(i + 1), hmac("pending:" + id))) return null;
  return (uq.byId.get(id) as User | undefined) ?? null;
}

/** Signup for an address that already has a verified account gets a cookie
 *  pointing at nothing, so the screens match but no session can ever result. */
export const phantomId = () => randomBytes(16).toString("hex");
