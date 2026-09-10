import "server-only";

/**
 * Delivery is the one part of this system that can't be free forever: real SMS
 * costs money at every provider. So the security-relevant half (generation,
 * hashing, expiry, attempt limits) lives in auth.ts and is fully real, while
 * transport is swapped by env var:
 *
 *   email → RESEND_API_KEY   (resend.com, 3k/month free)
 *   sms   → FAST2SMS_API_KEY (India, free credits) or TWILIO_*
 *   none set → logged to the server console (dev)
 *
 * ponytail: no retry/queue. Add one when a dropped OTP actually costs something.
 */

const dev = process.env.NODE_ENV !== "production";

/**
 * DEV ONLY. Remembers the last code we failed (or declined) to actually deliver,
 * so the verify screen can show it instead of making you grep the server log.
 * Never populated in production — see the guard in remember().
 * ponytail: in-memory, so it clears on restart. That is fine; codes expire in 10m.
 */
const g = globalThis as unknown as { __devCodes?: Map<string, string> };
const devCodes = (g.__devCodes ??= new Map<string, string>());

function remember(to: string, text: string) {
  if (!dev) return;                       // hard gate: never in production
  const m = text.match(/\b(\d{6})\b/);
  if (m) devCodes.set(to, m[1]);
}

/** DEV ONLY. Returns the undelivered code for a target, if there is one. */
export function devCodeFor(to: string): string | null {
  return dev ? (devCodes.get(to) ?? null) : null;
}

function log(kind: string, to: string, body: string) {
  remember(to, body);
  if (dev) console.log(`\n  [${kind}] → ${to}\n  ${body}\n`);
  else console.log(`[${kind}] queued for ${to.slice(0, 3)}***`); // never log codes in prod
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return log("email", to, `${subject}\n  ${text}`);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? "SitePulse <onboarding@resend.dev>",
      to, subject, text,
    }),
  });
  // Surface to logs, never to the user — provider errors can leak account detail.
  if (!res.ok) console.error("[email] provider rejected:", res.status, await res.text());
}

export async function sendSms(to: string, text: string): Promise<void> {
  const f2s = process.env.FAST2SMS_API_KEY;
  const sid = process.env.TWILIO_ACCOUNT_SID;

  if (f2s) {
    // Route reality on Fast2SMS (verified against a live account):
    //   q   — no DLT needed, they send via their own registered entity,
    //         but locked until the account has made one 100 INR transaction.
    //   otp — needs a DLT Entity ID + approved Sender ID + approved template.
    //   dlt — same DLT requirement.
    // So `q` is the only route reachable without DLT registration, which in
    // India takes days and wants business documents.
    const route = process.env.FAST2SMS_ROUTE ?? "q";
    const code = text.match(/\b(\d{6})\b/)?.[1];
    const numbers = to.replace(/^\+91/, ""); // Fast2SMS wants bare 10-digit Indian numbers

    const payload =
      route === "otp" && code
        ? { route: "otp", variables_values: code, numbers }
        : { route, message: text, language: "english", numbers };

    const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: { authorization: f2s, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Fast2SMS answers 200 even when it refuses, so HTTP status alone would
    // report a silent failure as a success.
    const body = await res.text();
    let ok = res.ok;
    try { ok = res.ok && JSON.parse(body).return === true; } catch { ok = false; }

    if (ok) {
      if (dev) console.log(`  [sms] Fast2SMS accepted (route=${route}) for ${to}`);
      return;
    }
    console.error(`[sms] Fast2SMS refused (HTTP ${res.status}, route=${route}): ${body}`);
    // Degrade to the console rather than dead-ending: the code is already
    // stored, so without this the user is stuck on a step they cannot pass.
    // Dev only — never print a live code in production.
    if (dev) log("sms fallback", to, text);
    return;
  }

  if (sid && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: "Basic " + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM!, Body: text }),
    });
    if (!res.ok) {
      console.error("[sms] Twilio rejected:", res.status, await res.text());
      if (dev) log("sms fallback", to, text);
    }
    return;
  }

  log("sms", to, text);
}
