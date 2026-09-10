"use client";

import { useEffect, useState } from "react";
import { IconGitHub } from "@/components/icons";
import { ThemeToggle } from "@/components/theme-toggle";

const LINKS = [
  { href: "#problem", label: "The problem" },
  { href: "#how", label: "How it works" },
  { href: "#people", label: "Who it's for" },
  { href: "#trust", label: "Trust & audit" },
];

const REPO = "https://github.com/ARYANPANWAR893/SIH---SitePulse";

function Mark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center rounded-md bg-accent text-on-accent"
      style={{ width: size, height: size }}
    >
      <span className="pulse-ring absolute inset-0 rounded-md" />
      <svg
        width={size * 0.57}
        height={size * 0.57}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 12h4l2.5-7 5 18 2.5-11H21" />
      </svg>
    </span>
  );
}

export function SiteHeader({ user }: { user: { name: string } | null }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Escape closes; body scroll locks while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A resize past the lg breakpoint should not leave the sheet stranded open.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled || open
          ? "border-b border-line bg-paper/90 backdrop-blur-md"
          : "border-b border-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between gap-3 px-5">
        <a
          href="#top"
          className="-ml-1 flex min-h-[44px] items-center gap-2.5 rounded px-1"
          onClick={() => setOpen(false)}
        >
          <Mark />
          <span className="font-display text-xl font-extrabold tracking-wide">SitePulse</span>
          <span className="ml-1 hidden rounded bg-paper-sunk px-1.5 py-0.5 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase sm:inline">
            SIH26122
          </span>
        </a>

        <nav className="hidden items-center gap-7 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="flex min-h-[44px] items-center font-mono text-[0.8rem] text-ink-soft transition-colors hover:text-accent-strong"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />

          <a
            href={REPO}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="SitePulse on GitHub"
            className="hidden h-11 w-11 place-items-center rounded-lg border border-line-strong text-ink-soft transition-colors hover:border-accent hover:text-accent-strong lg:grid"
          >
            <IconGitHub width={17} height={17} />
          </a>

          {user ? (
            <a href="/dashboard" className="btn btn-primary hidden md:inline-flex">
              Dashboard
            </a>
          ) : (
            <>
              <a
                href="/login"
                className="hidden px-2 font-mono text-[0.8rem] text-ink-soft transition-colors hover:text-accent-strong md:inline"
              >
                Sign in
              </a>
              <a href="/signup" className="btn btn-primary hidden md:inline-flex">
                Get started
              </a>
            </>
          )}

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="grid h-11 w-11 place-items-center rounded-lg border border-line-strong text-ink transition-colors hover:border-accent lg:hidden"
          >
            <span className="relative block h-4 w-5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="absolute left-0 block h-[2px] w-full rounded-full bg-current transition-all duration-300"
                  style={
                    open
                      ? {
                          top: "7px",
                          transform:
                            i === 1 ? "scaleX(0)" : `rotate(${i === 0 ? 45 : -45}deg)`,
                          opacity: i === 1 ? 0 : 1,
                        }
                      : { top: `${i * 7}px` }
                  }
                />
              ))}
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div
          id="mobile-menu"
          className="menu-panel border-t border-line bg-paper px-5 pt-2 pb-6 lg:hidden"
        >
          <nav className="flex flex-col">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="menu-link font-mono text-[0.95rem] text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="mt-5 flex flex-col gap-2.5">
            {user ? (
              <a href="/dashboard" className="btn btn-primary w-full">
                Dashboard — {user.name}
              </a>
            ) : (
              <>
                <a href="/signup" className="btn btn-primary w-full">Get started</a>
                <a href="/login" className="btn btn-ghost w-full">Sign in</a>
              </>
            )}
            <a href="#demo" onClick={() => setOpen(false)} className="btn btn-ghost w-full">
              See it work
            </a>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost w-full"
            >
              <IconGitHub width={15} height={15} /> View source
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
