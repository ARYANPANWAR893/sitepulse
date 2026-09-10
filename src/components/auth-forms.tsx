"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { strength } from "@/lib/password-strength";
import type { State } from "@/app/actions";

const EMPTY: State = {};

export function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <h1 className="font-display text-2xl font-bold tracking-wide">{title}</h1>
      {sub && <p className="mt-1 text-[0.88rem] text-ink-soft">{sub}</p>}
    </div>
  );
}

function Alert({ s }: { s: State }) {
  if (s.ok) return <p className="rounded-md bg-accent-soft px-3 py-2 text-[0.85rem] text-accent-strong" role="status">{s.ok}</p>;
  if (s.error) return <p className="rounded-md bg-rust-soft px-3 py-2 text-[0.85rem] text-rust" role="alert">{s.error}</p>;
  return null;
}

function Field({
  label, name, type = "text", autoComplete, placeholder, required = true, defaultValue,
}: {
  label: string; name: string; type?: string; autoComplete?: string;
  placeholder?: string; required?: boolean; defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[0.72rem] tracking-wider text-ink-soft uppercase">{label}</span>
      <input
        name={name} type={type} autoComplete={autoComplete} placeholder={placeholder}
        required={required} defaultValue={defaultValue}
        className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[0.95rem] text-ink outline-none transition-colors placeholder:text-ink-soft/60 focus:border-accent"
      />
    </label>
  );
}

function Submit({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <button type="submit" disabled={pending} className="btn btn-primary w-full disabled:opacity-60">
      {pending ? "Working…" : children}
    </button>
  );
}

// ---------------------------------------------------------------- strength meter

function StrengthMeter({ pw }: { pw: string }) {
  const s = strength(pw);
  if (!pw) return <div className="h-[2.6rem]" />;
  const tone = s.score <= 1 ? "var(--rust)" : s.score === 2 ? "var(--amber)" : "var(--accent)";
  return (
    <div className="h-[2.6rem] pt-1.5">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-1 flex-1 rounded-full transition-colors duration-300"
            style={{ background: i < Math.max(s.score, 1) ? tone : "var(--paper-sunk)" }} />
        ))}
      </div>
      <p className="mt-1 text-[0.74rem] text-ink-soft" aria-live="polite">
        <span style={{ color: tone }}>{s.label}</span>
        {s.hint && <> · {s.hint}</>}
      </p>
    </div>
  );
}

function PasswordField({ label = "Password", meter = false, autoComplete = "current-password" }) {
  const [pw, setPw] = useState("");
  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block font-mono text-[0.72rem] tracking-wider text-ink-soft uppercase">{label}</span>
        <input
          name="password" type="password" required minLength={8} autoComplete={autoComplete}
          value={pw} onChange={(e) => setPw(e.target.value)}
          className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[0.95rem] text-ink outline-none transition-colors focus:border-accent"
        />
      </label>
      {meter ? <StrengthMeter pw={pw} /> : null}
    </div>
  );
}

function GoogleButton() {
  return (
    <a href="/api/auth/google" className="btn btn-ghost w-full">
      <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
        <path fill="#4285F4" d="M45 24c0-1.6-.1-2.7-.4-3.9H24v7.1h12c-.2 1.8-1.5 4.6-4.4 6.4l6.7 5.2c4-3.7 6.7-9.1 6.7-14.8Z" />
        <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.3c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41.1 15.4 46 24 46Z" />
        <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5l-7.1-5.5A22 22 0 0 0 2 24c0 3.5.9 6.9 2.4 9.9l7.1-5.4Z" />
        <path fill="#EA4335" d="M24 9.5c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 3.4 29.9 1 24 1 15.4 1 8.1 6 4.4 13.1l7.1 5.5C13.3 13.3 18.2 9.5 24 9.5Z" />
      </svg>
      Continue with Google
    </a>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[0.68rem] tracking-wider text-ink-soft uppercase">or</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// ---------------------------------------------------------------- forms

type Action = (s: State, f: FormData) => Promise<State>;

export function SignupForm({ action, google }: { action: Action; google: boolean }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="space-y-4">
      {google && <><GoogleButton /><Divider /></>}
      <Alert s={state} />
      <Field label="Name" name="name" autoComplete="name" placeholder="Aryan Panwar" />
      <Field label="Email" name="email" type="email" autoComplete="email" placeholder="you@company.com" />
      <Field label="Phone" name="phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" />
      <PasswordField label="Password" meter autoComplete="new-password" />
      <Submit pending={pending}>Create account</Submit>
      <p className="text-center text-[0.82rem] text-ink-soft">
        Already have one? <Link href="/login" className="text-accent-strong underline underline-offset-2">Sign in</Link>
      </p>
    </form>
  );
}

export function LoginForm({ action, google }: { action: Action; google: boolean }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="space-y-4">
      {google && <><GoogleButton /><Divider /></>}
      <Alert s={state} />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <PasswordField />
      <Submit pending={pending}>Sign in</Submit>
      <div className="flex justify-between text-[0.82rem] text-ink-soft">
        <Link href="/forgot" className="underline underline-offset-2 hover:text-accent-strong">Forgot password</Link>
        <Link href="/signup" className="underline underline-offset-2 hover:text-accent-strong">Create account</Link>
      </div>
    </form>
  );
}

export function CodeForm({
  action, resend, channel, target,
}: { action: Action; resend: Action; channel: "email" | "phone"; target: string }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const [rState, runResend, resending] = useActionState(resend, EMPTY);
  return (
    <div className="space-y-4">
      <p className="text-[0.9rem] text-ink-soft">
        We sent a 6-digit code to <span className="font-mono text-ink">{target}</span>.
      </p>
      <form action={run} className="space-y-4">
        <Alert s={state} />
        <label className="block">
          <span className="mb-1.5 block font-mono text-[0.72rem] tracking-wider text-ink-soft uppercase">Code</span>
          <input
            name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required
            autoComplete="one-time-code" autoFocus
            className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-center font-mono text-xl tracking-[0.4em] text-ink outline-none focus:border-accent"
          />
        </label>
        <Submit pending={pending}>Verify</Submit>
      </form>
      <form action={runResend}>
        <input type="hidden" name="channel" value={channel} />
        <Alert s={rState} />
        <button type="submit" disabled={resending}
          className="w-full py-2 text-[0.82rem] text-ink-soft underline underline-offset-2 hover:text-accent-strong disabled:opacity-60">
          {resending ? "Sending…" : "Send a new code"}
        </button>
      </form>
    </div>
  );
}

export function PhoneForm({ action }: { action: Action }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="space-y-4">
      <Alert s={state} />
      <Field label="Phone" name="phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" />
      <Submit pending={pending}>Send code</Submit>
    </form>
  );
}

export function ForgotForm({ action }: { action: Action }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="space-y-4">
      <Alert s={state} />
      <Field label="Email" name="email" type="email" autoComplete="email" />
      <Submit pending={pending}>Send reset link</Submit>
      <p className="text-center text-[0.82rem] text-ink-soft">
        <Link href="/login" className="underline underline-offset-2">Back to sign in</Link>
      </p>
    </form>
  );
}

export function ResetForm({ action, token }: { action: Action; token: string }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="space-y-4">
      <Alert s={state} />
      <input type="hidden" name="token" value={token} />
      <PasswordField label="New password" meter autoComplete="new-password" />
      <Submit pending={pending}>Set password</Submit>
    </form>
  );
}
