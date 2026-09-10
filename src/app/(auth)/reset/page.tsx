import { redirect } from "next/navigation";
import { performReset } from "@/app/actions";
import { Head, ResetForm } from "@/components/auth-forms";


export const metadata = { title: "New password — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) redirect("/forgot");
  return (
    <>
      <Head title="Choose a new password" sub="This link works once." />
      <ResetForm action={performReset} token={token} />
    </>
  );
}
