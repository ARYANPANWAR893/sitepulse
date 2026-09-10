import { requestReset } from "@/app/actions";
import { Head, ForgotForm } from "@/components/auth-forms";


export const metadata = { title: "Reset password — SitePulse" };

export default function Page() {
  return (
    <>
      <Head title="Reset password" sub="We'll email you a one-time link." />
      <ForgotForm action={requestReset} />
    </>
  );
}
