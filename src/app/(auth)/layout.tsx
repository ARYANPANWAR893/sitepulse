import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-5 py-12">
      <div aria-hidden className="blueprint-grid pointer-events-none absolute inset-0 -z-10" />
      <Link href="/" className="mb-7 flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-accent text-on-accent">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h4l2.5-7 5 18 2.5-11H21" />
          </svg>
        </span>
        <span className="font-display text-xl font-extrabold tracking-wide">SitePulse</span>
      </Link>
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-paper-raised p-6 shadow-[var(--shadow-raised)] sm:p-7">
        {children}
      </div>
    </main>
  );
}

