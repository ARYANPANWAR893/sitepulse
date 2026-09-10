import "server-only";
import { cookies } from "next/headers";
import {
  createSession, readSession, dropSession, signPending, verifyPending,
  SESSION_COOKIE_NAME, SESSION_MAX_AGE, PENDING_COOKIE_NAME, PENDING_MAX_AGE,
  type User,
} from "./auth.ts";

// The only place cookies are touched. auth.ts stays free of request APIs so the
// security logic underneath is testable without a live Next request.
const opts = {
  httpOnly: true,                                 // unreadable from JavaScript
  secure: process.env.NODE_ENV === "production",  // HTTPS-only off localhost
  sameSite: "lax" as const,                       // second line against CSRF
  path: "/",
};

export async function startSession(userId: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, createSession(userId), { ...opts, maxAge: SESSION_MAX_AGE });
}

export async function currentUser(): Promise<User | null> {
  return readSession((await cookies()).get(SESSION_COOKIE_NAME)?.value);
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  dropSession(jar.get(SESSION_COOKIE_NAME)?.value);
  jar.delete(SESSION_COOKIE_NAME);
}

export async function setPending(userId: string): Promise<void> {
  (await cookies()).set(PENDING_COOKIE_NAME, signPending(userId), { ...opts, maxAge: PENDING_MAX_AGE });
}

export async function getPending(): Promise<User | null> {
  return verifyPending((await cookies()).get(PENDING_COOKIE_NAME)?.value);
}

export async function clearPending(): Promise<void> {
  (await cookies()).delete(PENDING_COOKIE_NAME);
}
