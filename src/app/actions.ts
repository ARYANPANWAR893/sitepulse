"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { cleanEmail, cleanPhone, cleanName, checkPassword, hashPassword, verifyPassword, burnPassword, allow, clearRate, endAllSessions, phantomId, issueOtp, checkOtp, issueReset, consumeReset, uq, newId, type User } from "@/lib/auth";
import { startSession, endSession, currentUser, setPending, getPending, clearPending } from "@/lib/session";
import { sendEmail, sendSms } from "@/lib/send";
import { phoneRequired } from "@/lib/flags";
import { linkPersonToUser } from "@/lib/people";

export type State = { error?: string; field?: string; ok?: string };

// x-forwarded-for is client-controlled unless a trusted proxy overwrites it, so
// every limit below is paired with a per-account limit that spoofing can't dodge.
async function ip(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

const GENERIC = "Email or password is not correct.";

// ------------------------------------------------------------------ signup

export async function signup(_prev: State, form: FormData): Promise<State> {
  const addr = await ip();
  if (!allow(`signup:${addr}`, 5, 60 * 60_000)) {
    return { error: "Too many signups from here. Try again later." };
  }

  const name = cleanName(form.get("name"));
  const email = cleanEmail(form.get("email"));
  const phone = cleanPhone(form.get("phone"));
  const pw = checkPassword(form.get("password"));

  if (!name) return { error: "Tell us your name.", field: "name" };
  if (!email) return { error: "That email doesn't look right.", field: "email" };
  if (!phone) return { error: "Use international format, e.g. +919876543210.", field: "phone" };
  if ("error" in pw) return pw;

  // Hashed before the branch so both paths cost the same.
  const hash = await hashPassword(pw.pw);
  const existing = uq.byEmail.get(email) as User | undefined;

  if (existing?.email_verified) {
    // Never hand back a session or a usable code for someone else's account.
    await sendEmail(email, "You already have a SitePulse account",
      "Someone tried to sign up with this address. If that was you, sign in instead — or reset your password from the sign-in page.");
    await setPending(phantomId());
    redirect("/verify");
  }

  const id = existing?.id ?? newId();
  if (!existing) uq.insert.run(id, name, email, null, hash, 0, 0, null, Date.now());
  uq.setPendingPhone.run(phone, id);

  const code = issueOtp(id, "email", email);
  await sendEmail(email, "Your SitePulse code", `Your verification code is ${code}. It expires in 10 minutes.`);
  await setPending(id);
  redirect("/verify");
}

// ------------------------------------------------------------------ login

export async function login(_prev: State, form: FormData): Promise<State> {
  const addr = await ip();
  const email = cleanEmail(form.get("email"));
  const password = form.get("password");

  if (!allow(`login-ip:${addr}`, 20, 15 * 60_000)) return { error: "Too many attempts. Wait a few minutes." };
  if (email && !allow(`login:${email}`, 8, 15 * 60_000)) return { error: "Too many attempts. Wait a few minutes." };

  if (!email || typeof password !== "string") {
    await burnPassword(typeof password === "string" ? password : "");
    return { error: GENERIC };
  }

  const user = uq.byEmail.get(email) as User | undefined;
  if (!user?.password_hash) {
    await burnPassword(password); // same cost as a real check — no timing oracle
    return { error: GENERIC };
  }
  if (!(await verifyPassword(password, user.password_hash))) return { error: GENERIC };

  clearRate(`login:${email}`);

  if (!user.email_verified) {
    const code = issueOtp(user.id, "email", user.email);
    await sendEmail(user.email, "Your SitePulse code", `Your verification code is ${code}. It expires in 10 minutes.`);
    await setPending(user.id);
    redirect("/verify");
  }

  await startSession(user.id);
  redirect(!phoneRequired() || user.phone_verified ? "/dashboard" : "/verify");
}

// ------------------------------------------------------------------ verify

export async function verifyEmail(_prev: State, form: FormData): Promise<State> {
  const user = await getPending();
  // Unknown pending cookie is answered exactly like a wrong code.
  if (!user) return { error: "That code isn't right." };
  if (!allow(`otpcheck:${user.id}`, 12, 15 * 60_000)) return { error: "Too many attempts. Request a new code." };

  const res = checkOtp(user.id, "email", form.get("code"));
  if ("error" in res) return res;

  uq.setEmailVerified.run(user.id);
  // Someone may already have been added to a project under this address. Now
  // that they've proved they own it, tie the record to the account so they can
  // sign in and see their own tasks.
  linkPersonToUser(user.id, user.email);
  await clearPending();
  await startSession(user.id);

  const fresh = uq.byId.get(user.id) as User;
  if (fresh.phone_verified || !phoneRequired()) redirect("/dashboard");

  // Straight into the phone step.
  if (fresh.pending_phone) {
    const code = issueOtp(user.id, "phone", fresh.pending_phone);
    await sendSms(fresh.pending_phone, `Your SitePulse code is ${code}. It expires in 10 minutes.`);
  }
  redirect("/verify");
}

export async function verifyPhone(_prev: State, form: FormData): Promise<State> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!allow(`otpcheck:${user.id}`, 12, 15 * 60_000)) return { error: "Too many attempts. Request a new code." };

  const res = checkOtp(user.id, "phone", form.get("code"));
  if ("error" in res) return res;

  try {
    uq.setPhone.run(res.target, user.id);
  } catch {
    // UNIQUE violation: someone else verified this number first. Safe to say so —
    // whoever is reading this just proved they control the handset.
    return { error: "That number is already linked to another account." };
  }
  redirect("/dashboard");
}

/** Used by both verify steps; the channel decides where the code goes. */
export async function resendCode(_prev: State, form: FormData): Promise<State> {
  const channel = form.get("channel") === "phone" ? "phone" : "email";
  const user = channel === "phone" ? await currentUser() : await getPending();
  if (!user) return { ok: "If that request was valid, a new code is on its way." };

  if (!allow(`otpsend:${user.id}:${channel}`, 3, 10 * 60_000)) {
    return { error: "You've asked for several codes. Wait a few minutes." };
  }

  if (channel === "email") {
    const code = issueOtp(user.id, "email", user.email);
    await sendEmail(user.email, "Your SitePulse code", `Your verification code is ${code}. It expires in 10 minutes.`);
  } else {
    const target = user.pending_phone ?? user.phone;
    if (!target) return { error: "Add a phone number first." };
    const code = issueOtp(user.id, "phone", target);
    await sendSms(target, `Your SitePulse code is ${code}. It expires in 10 minutes.`);
  }
  return { ok: "New code sent." };
}

/** Change the number before verifying it (typo path, and the Google flow). */
export async function setPhone(_prev: State, form: FormData): Promise<State> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!allow(`otpsend:${user.id}:phone`, 3, 10 * 60_000)) {
    return { error: "You've asked for several codes. Wait a few minutes." };
  }

  const phone = cleanPhone(form.get("phone"));
  if (!phone) return { error: "Use international format, e.g. +919876543210.", field: "phone" };

  uq.setPendingPhone.run(phone, user.id);
  const code = issueOtp(user.id, "phone", phone);
  await sendSms(phone, `Your SitePulse code is ${code}. It expires in 10 minutes.`);
  return { ok: "Code sent." };
}

// ------------------------------------------------------------------ reset

export async function requestReset(_prev: State, form: FormData): Promise<State> {
  const addr = await ip();
  const email = cleanEmail(form.get("email"));
  const done = { ok: "If that address has an account, a reset link is on the way." };

  if (!allow(`reset:${addr}`, 5, 60 * 60_000)) return done; // silent — no oracle
  if (!email) return done;
  if (!allow(`reset:${email}`, 3, 60 * 60_000)) return done;

  const user = uq.byEmail.get(email) as User | undefined;
  if (user) {
    const token = issueReset(user.id);
    const base = process.env.APP_URL ?? "http://localhost:3000";
    await sendEmail(email, "Reset your SitePulse password",
      `Open ${base}/reset?token=${token} to choose a new password. The link expires in 30 minutes and works once.`);
  }
  return done;
}

export async function performReset(_prev: State, form: FormData): Promise<State> {
  const addr = await ip();
  if (!allow(`resetuse:${addr}`, 10, 60 * 60_000)) return { error: "Too many attempts. Try again later." };

  const pw = checkPassword(form.get("password"));
  if ("error" in pw) return pw;

  const res = consumeReset(form.get("token"));
  if ("error" in res) return res;

  uq.setPassword.run(await hashPassword(pw.pw), res.userId);
  endAllSessions(res.userId); // every other device is logged out
  redirect("/login?reset=1");
}

// ------------------------------------------------------------------ logout

export async function logout(): Promise<void> {
  await endSession();
  redirect("/");
}
