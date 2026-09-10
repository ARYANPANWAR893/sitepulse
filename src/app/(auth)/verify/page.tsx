import { redirect } from "next/navigation";
import { currentUser, getPending } from "@/lib/session";
import { verifyEmail, verifyPhone, resendCode, setPhone } from "@/app/actions";
import { Head, CodeForm, PhoneForm } from "@/components/auth-forms";
import { devCodeFor } from "@/lib/send";
import { phoneRequired } from "@/lib/flags";


export const metadata = { title: "Verify — SitePulse" };

function DevCode({ target }: { target: string }) {
  const code = devCodeFor(target);
  if (!code) return null;   // devCodeFor already returns null in production
  return (
    <p className="mb-4 rounded-md border border-dashed border-amber px-3 py-2 font-mono text-[0.78rem] text-amber">
      Dev only — no SMS/email provider delivered this, so here is the code:{" "}
      <b className="text-[0.95rem] tracking-widest">{code}</b>
    </p>
  );
}

const maskEmail = (e: string) => e.replace(/^(.).*(.@)/, "$1•••$2");
const maskPhone = (p: string) => p.slice(0, 3) + "•••" + p.slice(-3);

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ phone?: string }> }) {
  const wantsPhone = (await searchParams).phone === "1";
  const user = await currentUser();

  // Step 2: signed in, email done, phone outstanding.
  if (user) {
    if (user.email_verified && (user.phone_verified || (!phoneRequired() && !wantsPhone)))
      redirect("/dashboard");
    const target = user.pending_phone;
    return (
      <>
        <Head title="Verify your phone" sub="Step 2 of 2" />
        {target ? (
          <>
            <DevCode target={target} />
            <CodeForm action={verifyPhone} resend={resendCode} channel="phone" target={maskPhone(target)} />
            {/* Must always be reachable: a stranger's signup against an
                unverified account can leave a number the owner didn't choose. */}
            <details className="mt-5 border-t border-line pt-4">
              <summary className="cursor-pointer text-[0.82rem] text-ink-soft hover:text-accent-strong">
                Not your number? Use a different one
              </summary>
              <div className="mt-3">
                <PhoneForm action={setPhone} />
              </div>
            </details>
          </>
        ) : (
          <PhoneForm action={setPhone} />
        )}
      </>
    );
  }

  // Step 1: mid-signup, identified only by the signed pending cookie.
  const pending = await getPending();
  if (!pending) redirect("/login");
  return (
    <>
      <Head title="Verify your email" sub="Step 1 of 2" />
      <CodeForm action={verifyEmail} resend={resendCode} channel="email" target={maskEmail(pending.email)} />
    </>
  );
}
