import { login } from "@/app/actions";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Head, LoginForm } from "@/components/auth-forms";
import { googleConfigured } from "@/lib/oauth";


export const metadata = { title: "Sign in — SitePulse" };

const NOTES: Record<string, string> = {
  state: "That sign-in attempt expired. Try again.",
  google: "Google sign-in isn't available right now.",
  unverified: "Your Google account needs a verified email address.",
  rate: "Too many attempts. Wait a few minutes.",
};

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ e?: string; reset?: string }> }) {
  // A signed-in visitor has no business on this form.
  if (await currentUser()) redirect("/dashboard");
  const sp = await searchParams;
  const note = sp.e ? NOTES[sp.e] : undefined;
  const google = googleConfigured();
  return (
    <>
      <Head title="Sign in" />
      {!google && process.env.NODE_ENV !== "production" && (
        <p className="mb-4 rounded-md border border-dashed border-line-strong px-3 py-2 font-mono text-[0.72rem] text-ink-soft">
          Google sign-in is hidden because GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
          aren&apos;t in .env.local. Dev-only notice.
        </p>
      )}
      {sp.reset && (
        <p className="mb-4 rounded-md bg-accent-soft px-3 py-2 text-[0.85rem] text-accent-strong">
          Password updated. Sign in with it.
        </p>
      )}
      {note && <p className="mb-4 rounded-md bg-rust-soft px-3 py-2 text-[0.85rem] text-rust">{note}</p>}
      <LoginForm action={login} google={google} />
    </>
  );
}
