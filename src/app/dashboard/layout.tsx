import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { phoneRequired } from "@/lib/flags";
import { logout } from "@/app/actions";
import { newProject } from "@/app/team-actions";
import { DashSidebar } from "@/components/dash-nav";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { dashContext } from "@/lib/dash";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // One gate for every dashboard route. Each page still re-resolves the actor
  // for the project it renders — this only proves you're signed in.
  const session = await currentUser();
  if (!session) redirect("/login");
  if (!session.email_verified) redirect("/verify");
  if (phoneRequired() && !session.phone_verified) redirect("/verify");

  const { projects } = await dashContext();
  const nav = projects.map((p) => ({ id: p.id, name: p.name, code: p.code }));

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 border-b border-line bg-paper/90 backdrop-blur-md">
        <div className="flex h-16 items-center justify-between gap-3 px-4 lg:px-5">
          <div className="flex items-center gap-3 pl-14 lg:pl-0">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-on-accent">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12h4l2.5-7 5 18 2.5-11H21" />
                </svg>
              </span>
              <span className="font-display text-xl font-extrabold tracking-wide">SitePulse</span>
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[0.76rem] text-ink-soft sm:inline">{session.email}</span>
            <form action={logout}>
              <button className="btn btn-ghost">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      {/* Outside the header on purpose — see the note in DashSidebar. Both the
          rail and the New Project dialog are position:fixed, and the header's
          backdrop-blur would otherwise become their containing block. */}
      <Suspense fallback={null}>
        <DashSidebar projects={nav}>
          <NewProjectDialog action={newProject} />
        </DashSidebar>
      </Suspense>

      <main className="px-4 py-8 lg:pl-[272px] lg:pr-6">
        <div className="mx-auto max-w-[1100px]">{children}</div>
      </main>
    </div>
  );
}
