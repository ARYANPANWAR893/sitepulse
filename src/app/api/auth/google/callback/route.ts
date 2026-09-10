import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { uq, newId, allow, endAllSessions, type User } from "@/lib/auth";
import { startSession } from "@/lib/session";
import { linkPersonToUser } from "@/lib/people";
import { phoneRequired } from "@/lib/flags";
import { callbackUrl, googleConfigured, appUrl } from "@/lib/oauth";

export const runtime = "nodejs";

const base = appUrl;
const fail = (why: string) => NextResponse.redirect(new URL(`/login?e=${why}`, base()));

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function GET(req: NextRequest) {
  if (!googleConfigured()) return fail("google");

  const addr = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (!allow(`oauth:${addr}`, 20, 15 * 60_000)) return fail("rate");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("g_state")?.value;
  const verifier = req.cookies.get("g_verifier")?.value;

  const clear = (res: NextResponse) => {
    res.cookies.delete({ name: "g_state", path: "/api/auth/google" });
    res.cookies.delete({ name: "g_verifier", path: "/api/auth/google" });
    return res;
  };

  if (!code || !state || !cookieState || !verifier || !same(state, cookieState)) {
    return clear(fail("state"));
  }

  // Exchange happens server-to-server over TLS, so the token response is
  // authoritative and no ID-token signature check is required (OIDC 3.1.3.7).
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return clear(fail("google"));
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return clear(fail("google"));

  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!infoRes.ok) return clear(fail("google"));
  const info = (await infoRes.json()) as {
    sub?: string; email?: string; email_verified?: boolean; name?: string;
  };

  // Auto-linking by address is only safe because Google asserts it verified.
  if (!info.sub || !info.email || info.email_verified !== true) return clear(fail("unverified"));
  const email = info.email.trim().toLowerCase();

  let user = uq.byGoogle.get(info.sub) as User | undefined;
  if (!user) {
    const byEmail = uq.byEmail.get(email) as User | undefined;
    if (byEmail) {
      uq.linkGoogle.run(info.sub, byEmail.id);
      endAllSessions(byEmail.id); // drop anything opened before the claim
      user = uq.byId.get(byEmail.id) as User;
    } else {
      const id = newId();
      uq.insert.run(id, (info.name ?? email.split("@")[0]).slice(0, 100), email, null, null, 1, 0, info.sub, Date.now());
      user = uq.byId.get(id) as User;
    }
  }

  linkPersonToUser(user.id, user.email);
  await startSession(user.id);
  return clear(NextResponse.redirect(new URL(!phoneRequired() || user.phone_verified ? "/dashboard" : "/verify", base())));
}
