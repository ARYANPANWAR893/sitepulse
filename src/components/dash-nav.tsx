"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  // Above Tasks on purpose: the schedule is the system of record, and the task
  // list is the slice of it that has been handed to someone.
  { href: "/dashboard/schedule", label: "Schedule" },
  { href: "/dashboard/reports", label: "Field reports" },
  { href: "/dashboard/tasks", label: "Tasks" },
  { href: "/dashboard/people", label: "People" },
  { href: "/dashboard/roles", label: "Roles & permissions" },
  { href: "/dashboard/settings", label: "Project settings" },
];

export type NavProject = { id: string; name: string; code: string | null };

/**
 * Left rail: project context on top, sections beneath.
 *
 * The active project rides in `?project=`, so every link has to carry it —
 * otherwise moving between sections would silently switch project.
 */
export function DashSidebar({
  projects, children,
}: { projects: NavProject[]; children: React.ReactNode }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const active = params.get("project") ?? projects[0]?.id ?? null;
  const withProject = (base: string) => (active ? `${base}?project=${active}` : base);

  const [open, setOpen] = useState(false);
  // Route change closes the drawer; on desktop the rail is always visible.
  useEffect(() => { setOpen(false); }, [pathname, params]);

  return (
    <>
      {/* Fixed, and deliberately NOT inside the header: the header carries
          backdrop-filter, which would make it the containing block for every
          fixed descendant and clip this rail to the header's own height. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="dash-sidebar"
        className="fixed top-2.5 left-3 z-[60] grid h-11 w-11 place-items-center rounded-lg border border-line-strong bg-paper text-ink transition-colors hover:border-accent lg:hidden"
      >
        <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d={open ? "M6 6l12 12M18 6L6 18" : "M4 7h16M4 12h16M4 17h16"} />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-30 bg-ink/40 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} />
      )}

      <aside
        id="dash-sidebar"
        className={`fixed top-16 bottom-0 left-0 z-40 w-[248px] overflow-y-auto border-r border-line bg-paper px-3 py-5 transition-transform lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <p className="mb-2 px-2 font-mono text-[0.62rem] tracking-[0.16em] text-ink-soft uppercase">
          Projects
        </p>

        <ul className="mb-3 space-y-1">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`${pathname}?project=${p.id}`}
                aria-current={p.id === active ? "true" : undefined}
                className={`flex min-h-[38px] flex-col justify-center rounded-lg px-2.5 py-1 transition-colors ${
                  p.id === active
                    ? "bg-accent-soft text-accent-strong"
                    : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                }`}
              >
                <span className="truncate text-[0.86rem] font-medium">{p.name}</span>
                {p.code && <span className="font-mono text-[0.66rem] opacity-70">{p.code}</span>}
              </Link>
            </li>
          ))}
        </ul>

        {/* The single entry point for project creation. */}
        {children}

        <nav className="mt-6 space-y-0.5" aria-label="Project sections">
          <p className="mb-2 px-2 font-mono text-[0.62rem] tracking-[0.16em] text-ink-soft uppercase">
            Sections
          </p>
          {NAV.map((n) => {
            const isActive = n.href === "/dashboard" ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={withProject(n.href)}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-[40px] items-center rounded-lg px-2.5 text-[0.88rem] transition-colors ${
                  isActive
                    ? "bg-paper-sunk font-semibold text-ink"
                    : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
