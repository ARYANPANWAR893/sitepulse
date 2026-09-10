import { NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { googleConfigured, callbackUrl, appUrl } from "@/lib/oauth";

export const runtime = "nodejs";

export async function GET() {
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/login?e=google", appUrl()));
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  const res = NextResponse.redirect(url);
  // Short-lived, httpOnly: state defeats CSRF on the callback, PKCE defeats
  // code interception. Both are read once and cleared.
  const opts = {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, path: "/api/auth/google", maxAge: 600,
  };
  res.cookies.set("g_state", state, opts);
  res.cookies.set("g_verifier", verifier, opts);
  return res;
}
