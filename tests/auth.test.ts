import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

// Must be set before the modules under test are imported.
process.env.AUTH_SECRET = "test-secret-that-is-definitely-over-32-chars";
process.env.AUTH_DB_PATH = ".data/test-auth.db";
rmSync(".data/test-auth.db", { force: true });
rmSync(".data/test-auth.db-wal", { force: true });
rmSync(".data/test-auth.db-shm", { force: true });

type A = typeof import("../src/lib/auth.ts");
type D = typeof import("../src/lib/db.ts");
let a: A, d: D;

before(async () => {
  a = await import("../src/lib/auth.ts");
  d = await import("../src/lib/db.ts");
});

let seq = 0;
function mkUser(email?: string) {
  const id = a.newId();
  const e = email ?? `u${seq++}@example.com`;
  a.uq.insert.run(id, "Test User", e, null, null, 0, 0, null, Date.now());
  return id;
}

// ---------------------------------------------------------------- passwords

describe("password storage", () => {
  test("stored form leaks neither the password nor a static hash of it", async () => {
    const stored = await a.hashPassword("correct horse battery staple");
    assert.ok(!stored.includes("correct horse"));
    assert.ok(!stored.includes(createHash("sha256").update("correct horse battery staple").digest("base64")));
    assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$/);
  });

  test("same password hashes differently every time (per-hash salt)", async () => {
    const [x, y] = await Promise.all([a.hashPassword("hunter2222"), a.hashPassword("hunter2222")]);
    assert.notEqual(x, y);
    assert.ok(await a.verifyPassword("hunter2222", x));
    assert.ok(await a.verifyPassword("hunter2222", y));
  });

  test("wrong password and tampered hash both fail", async () => {
    const stored = await a.hashPassword("righteous8");
    assert.equal(await a.verifyPassword("righteous9", stored), false);
    assert.equal(await a.verifyPassword("righteous8", stored.slice(0, -4) + "AAAA"), false);
    assert.equal(await a.verifyPassword("righteous8", "md5$deadbeef"), false);
  });

  test("weak-but-allowed: 12345678 is accepted by policy, as required", () => {
    const r = a.checkPassword("12345678");
    assert.ok("ok" in r, "policy must not block common passwords");
  });

  test("policy rejects short and absurdly long input", () => {
    assert.ok("error" in a.checkPassword("1234567"));
    assert.ok("error" in a.checkPassword("x".repeat(10_000)), "unbounded input is a CPU-burn vector");
    assert.ok("error" in a.checkPassword(null));
  });
});

// ---------------------------------------------------------------- OTP

describe("OTP", () => {
  test("brute force dies after 5 wrong attempts", () => {
    const id = mkUser();
    const code = a.issueOtp(id, "email", "x@example.com");
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) assert.ok("error" in a.checkOtp(id, "email", wrong));
    // Even the CORRECT code is dead now — the record was burned.
    const after = a.checkOtp(id, "email", code);
    assert.ok("error" in after);
  });

  test("a correct code cannot be replayed", () => {
    const id = mkUser();
    const code = a.issueOtp(id, "email", "y@example.com");
    assert.ok("ok" in a.checkOtp(id, "email", code));
    assert.ok("error" in a.checkOtp(id, "email", code), "single use");
  });

  test("expired codes are refused", () => {
    const id = mkUser();
    const code = a.issueOtp(id, "email", "z@example.com");
    d.db.prepare("UPDATE otps SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1, id);
    assert.ok("error" in a.checkOtp(id, "email", code));
  });

  test("one user's code does not verify another user", () => {
    const alice = mkUser(), bob = mkUser();
    const code = a.issueOtp(alice, "email", "a@example.com");
    a.issueOtp(bob, "email", "b@example.com");
    assert.ok("error" in a.checkOtp(bob, "email", code));
  });

  test("channels are isolated", () => {
    const id = mkUser();
    const emailCode = a.issueOtp(id, "email", "c@example.com");
    a.issueOtp(id, "phone", "+919876543210");
    assert.ok("error" in a.checkOtp(id, "phone", emailCode));
  });

  test("stored digest is keyed, so a dumped DB can't be brute-forced offline", () => {
    const id = mkUser();
    const code = a.issueOtp(id, "email", "d@example.com");
    const row = d.db.prepare("SELECT code_hash FROM otps WHERE user_id = ?").get(id) as { code_hash: string };
    assert.notEqual(row.code_hash, createHash("sha256").update(code).digest("hex"));
    assert.ok(!row.code_hash.includes(code));
  });

  test("malformed input is rejected without crashing", () => {
    const id = mkUser();
    a.issueOtp(id, "email", "e@example.com");
    for (const bad of ["", "abc", "12345", "1234567", "  ", null, undefined, 123456, {}]) {
      assert.ok("error" in a.checkOtp(id, "email", bad as unknown));
    }
  });
});

// ---------------------------------------------------------------- sessions

describe("sessions", () => {
  test("cookie value is never what is stored", () => {
    const id = mkUser();
    const token = a.createSession(id);
    const row = d.db.prepare("SELECT id FROM sessions WHERE user_id = ?").get(id) as { id: string };
    assert.notEqual(row.id, token);
    assert.equal(row.id, createHash("sha256").update(token).digest("hex"));
  });

  test("valid token resolves, tampered and unknown tokens do not", () => {
    const id = mkUser();
    const token = a.createSession(id);
    assert.equal(a.readSession(token)?.id, id);
    assert.equal(a.readSession(token.slice(0, -2) + "zz"), null);
    assert.equal(a.readSession(randomBytes(32).toString("base64url")), null);
    assert.equal(a.readSession(undefined), null);
    assert.equal(a.readSession(""), null);
  });

  test("absolute expiry and idle timeout both end the session", () => {
    const id1 = mkUser(), id2 = mkUser();
    const t1 = a.createSession(id1);
    d.db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1, id1);
    assert.equal(a.readSession(t1), null, "absolute cap");

    const t2 = a.createSession(id2);
    d.db.prepare("UPDATE sessions SET last_seen = ? WHERE user_id = ?")
      .run(Date.now() - 25 * 60 * 60 * 1000, id2);
    assert.equal(a.readSession(t2), null, "idle cutoff");
  });

  test("logout and password reset revoke server-side, not just the cookie", () => {
    const id = mkUser();
    const t1 = a.createSession(id), t2 = a.createSession(id);
    a.dropSession(t1);
    assert.equal(a.readSession(t1), null);
    assert.ok(a.readSession(t2));
    a.endAllSessions(id);
    assert.equal(a.readSession(t2), null, "reset must kill every device");
  });

  test("logging in issues a brand-new token (no session fixation)", () => {
    const id = mkUser();
    assert.notEqual(a.createSession(id), a.createSession(id));
  });
});

// ---------------------------------------------------------------- pending cookie

describe("pending cookie", () => {
  test("forged or unsigned values are rejected", () => {
    const id = mkUser();
    assert.equal(a.verifyPending(id)?.id, undefined);
    assert.equal(a.verifyPending(`${id}.deadbeef`), null);
    assert.equal(a.verifyPending(`${id}.`), null);
    assert.equal(a.verifyPending(undefined), null);
    assert.equal(a.verifyPending(a.signPending(id))?.id, id);
  });

  test("a signature cannot be moved to another user id", () => {
    const alice = mkUser(), bob = mkUser();
    const sig = a.signPending(alice).split(".")[1];
    assert.equal(a.verifyPending(`${bob}.${sig}`), null);
  });
});

// ---------------------------------------------------------------- reset tokens

describe("password reset", () => {
  test("token works once, then never again", () => {
    const id = mkUser();
    const tok = a.issueReset(id);
    assert.equal((a.consumeReset(tok) as { userId: string }).userId, id);
    assert.ok("error" in a.consumeReset(tok), "replay must fail");
  });

  test("issuing a new link invalidates the old one", () => {
    const id = mkUser();
    const first = a.issueReset(id);
    a.issueReset(id);
    assert.ok("error" in a.consumeReset(first));
  });

  test("expired and bogus tokens are refused", () => {
    const id = mkUser();
    const tok = a.issueReset(id);
    d.db.prepare("UPDATE resets SET expires_at = ? WHERE user_id = ?").run(Date.now() - 1, id);
    assert.ok("error" in a.consumeReset(tok));
    assert.ok("error" in a.consumeReset("nope"));
    assert.ok("error" in a.consumeReset(null));
  });
});

// ---------------------------------------------------------------- rate limiting

describe("rate limiting", () => {
  test("blocks once over budget and recovers after the window", () => {
    const k = "test:" + a.newId();
    for (let i = 0; i < 3; i++) assert.equal(a.allow(k, 3, 60_000), true);
    assert.equal(a.allow(k, 3, 60_000), false);
    d.db.prepare("UPDATE rate SET reset_at = ? WHERE k = ?").run(Date.now() - 1, k);
    assert.equal(a.allow(k, 3, 60_000), true, "window rolls over");
  });

  test("keys are independent and a success can clear one", () => {
    const k1 = "t1:" + a.newId(), k2 = "t2:" + a.newId();
    for (let i = 0; i < 3; i++) a.allow(k1, 3, 60_000);
    assert.equal(a.allow(k1, 3, 60_000), false);
    assert.equal(a.allow(k2, 3, 60_000), true);
    a.clearRate(k1);
    assert.equal(a.allow(k1, 3, 60_000), true);
  });
});

// ---------------------------------------------------------------- injection & validation

describe("injection and input validation", () => {
  test("SQL metacharacters are data, never syntax", () => {
    const evil = "'; DROP TABLE users; --";
    const id = a.newId();
    a.uq.insert.run(id, evil, "sqli@example.com", null, null, 0, 0, null, Date.now());

    // Table still exists and the payload round-trips verbatim.
    const back = a.uq.byId.get(id) as { name: string };
    assert.equal(back.name, evil);
    assert.ok((d.db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c > 0);

    // A classic auth-bypass string matches nothing.
    assert.equal(a.uq.byEmail.get("' OR 1=1 --"), undefined);
    assert.equal(a.uq.byEmail.get("sqli@example.com' --"), undefined);
  });

  test("email validation rejects XSS, header injection and overlong input", () => {
    for (const bad of [
      "<script>alert(1)</script>@x.com",
      "a@b.com\nBcc: victim@x.com",
      "a@b.com\r\nSubject: spam",
      "no-at-sign", "@nolocal.com", "a@nodot", "a b@c.com",
      "a@b.com,c@d.com", "x".repeat(250) + "@example.com",
      "", "   ", null, 42, {},
    ]) {
      assert.equal(a.cleanEmail(bad as unknown), null, `should reject: ${String(bad)}`);
    }
    assert.equal(a.cleanEmail("  Aryan@Example.COM "), "aryan@example.com", "normalised");
  });

  test("phone validation enforces E.164", () => {
    for (const bad of ["9876543210", "+0123456789", "+91 98765 4321o", "+1", "+" + "9".repeat(20), "", null]) {
      assert.equal(a.cleanPhone(bad as unknown), null, `should reject: ${String(bad)}`);
    }
    assert.equal(a.cleanPhone("+91 98765-43210"), "+919876543210");
  });

  test("name validation trims and bounds", () => {
    assert.equal(a.cleanName("  Aryan   Panwar "), "Aryan Panwar");
    assert.equal(a.cleanName("x".repeat(101)), null);
    assert.equal(a.cleanName(""), null);
  });
});

// ---------------------------------------------------------------- data exposure

describe("data exposure", () => {
  test("the client-facing shape carries no secret material", async () => {
    const id = a.newId();
    a.uq.insert.run(id, "Leak Check", "leak@example.com", null,
      await a.hashPassword("hunter2222"), 1, 0, "google-sub-123", Date.now());

    const pub = a.publicUser(a.uq.byId.get(id) as never);
    const keys = Object.keys(pub);
    for (const secret of ["password_hash", "passwordHash", "google_sub", "googleSub"]) {
      assert.ok(!keys.includes(secret), `publicUser must not expose ${secret}`);
    }
    assert.ok(!JSON.stringify(pub).includes("scrypt$"));
    assert.ok(!JSON.stringify(pub).includes("google-sub-123"));
  });
});

// ---------------------------------------------------------------- account linking

describe("Google account linking (pre-hijacking)", () => {
  test("claiming a never-verified address via Google discards the squatter's password", async () => {
    // Attacker pre-registers the victim's address with a password they know.
    const id = a.newId();
    const stolen = await a.hashPassword("attacker-knows-this");
    a.uq.insert.run(id, "Squatter", "victim@gmail.com", null, stolen, 0, 0, null, Date.now());

    // Victim later signs in with Google for the same address.
    a.uq.linkGoogle.run("google-sub-victim", id);

    const row = a.uq.byId.get(id) as { password_hash: string | null; email_verified: number };
    assert.equal(row.password_hash, null, "attacker's password must not survive the claim");
    assert.equal(row.email_verified, 1);
  });

  test("linking Google to an already-verified account keeps that owner's password", async () => {
    const id = a.newId();
    const mine = await a.hashPassword("my-real-password");
    a.uq.insert.run(id, "Owner", "owner@gmail.com", null, mine, 1, 0, null, Date.now());

    a.uq.linkGoogle.run("google-sub-owner", id);

    const row = a.uq.byId.get(id) as { password_hash: string | null };
    assert.equal(row.password_hash, mine, "a verified owner keeps their password");
    assert.ok(await a.verifyPassword("my-real-password", row.password_hash!));
  });
});

describe("phone claim", () => {
  test("a number verified by one account cannot be taken by another", () => {
    const first = mkUser(), second = mkUser();
    a.uq.setPhone.run("+919999900000", first);
    assert.throws(() => a.uq.setPhone.run("+919999900000", second), /UNIQUE|constraint/i);
    const row = a.uq.byId.get(second) as { phone: string | null; phone_verified: number };
    assert.equal(row.phone, null);
    assert.equal(row.phone_verified, 0);
  });

  test("the number that gets saved comes from the OTP record, not the caller", () => {
    const id = mkUser();
    const code = a.issueOtp(id, "phone", "+919876500001");
    const res = a.checkOtp(id, "phone", code);
    assert.ok("ok" in res);
    // verifyPhone writes res.target — a client-supplied number never reaches the row.
    assert.equal(res.target, "+919876500001");
  });
});
