import { signup } from "@/app/actions";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Head, SignupForm } from "@/components/auth-forms";
import { googleConfigured } from "@/lib/oauth";


export const metadata = { title: "Create account — SitePulse" };

export default async function Page() {
  // A signed-in visitor has no business on these forms.
  if (await currentUser()) redirect("/dashboard");
  const google = googleConfigured();
  return (
    <>
      <Head title="Create account" sub="We'll verify your email, then your phone." />
      {!google && process.env.NODE_ENV !== "production" && (
        <p className="mb-4 rounded-md border border-dashed border-line-strong px-3 py-2 font-mono text-[0.72rem] text-ink-soft">
          Google sign-in is hidden because GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
          aren&apos;t in .env.local. Dev-only notice.
        </p>
      )}
      <SignupForm action={signup} google={google} />
    </>
  );
}
