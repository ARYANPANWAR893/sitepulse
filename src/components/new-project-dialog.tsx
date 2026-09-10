"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { TeamState } from "@/app/team-actions";

const EMPTY: TeamState = {};
type Action = (s: TeamState, f: FormData) => Promise<TeamState>;

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.88rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[0.72rem] text-ink-soft">{hint}</span>}
    </label>
  );
}

/**
 * Project creation, in a real modal.
 *
 * Native <dialog> rather than a hand-rolled overlay: it brings the focus trap,
 * Escape-to-close, inert background and the ::backdrop for free, which a div
 * would all have to reimplement (usually badly).
 */
export function NewProjectDialog({ action }: { action: Action }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Empty states elsewhere ask for this dialog by event, so project creation
  // keeps a single implementation and a single entry point.
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("sitepulse:new-project", openIt);
    return () => window.removeEventListener("sitepulse:new-project", openIt);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-h-[38px] items-center gap-2 rounded-lg border border-dashed border-line-strong px-2.5 text-[0.84rem] text-ink-soft transition-colors hover:border-accent hover:text-accent-strong"
      >
        <span aria-hidden className="text-[1rem] leading-none">+</span> New project
      </button>

      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        // Clicking the backdrop (the dialog element itself) dismisses it.
        onClick={(e) => { if (e.target === ref.current) setOpen(false); }}
        // m-auto is load-bearing: the UA stylesheet centres a modal <dialog> with
        // margin:auto, and Tailwind's preflight resets it to 0, pinning it top-left.
        // sp-modal carries the open/close transition (see globals.css).
        className="sp-modal m-auto max-h-[90dvh] w-[min(34rem,92vw)] overflow-y-auto rounded-2xl border border-line bg-paper-raised p-0 text-ink shadow-[var(--shadow-raised)] backdrop:bg-ink/50 backdrop:backdrop-blur-sm"
      >
        <form action={run} className={`space-y-4 p-6 ${open ? "sp-stagger" : ""}`}>
          <div>
            <h2 className="font-display text-2xl font-bold tracking-wide">New project</h2>
            <p className="mt-1 text-[0.84rem] text-ink-soft">
              People, hierarchy and tasks all live inside a project.
            </p>
          </div>

          {state.error && (
            <p role="alert" className="rounded-md bg-rust-soft px-3 py-2 text-[0.85rem] text-rust">
              {state.error}
            </p>
          )}

          <Field label="Project name">
            <input name="name" required autoFocus placeholder="Oil India Pipeline Development" className={inputCls} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Project code" hint="Used as the task ref prefix.">
              <input name="code" placeholder="OILP" className={inputCls} />
            </Field>
            <Field label="Client">
              <input name="client" placeholder="Oil India Limited" className={inputCls} />
            </Field>
          </div>

          <Field label="Location">
            <input name="location" placeholder="Duliajan, Assam" className={inputCls} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Start date">
              <input name="startDate" type="date" className={inputCls} />
            </Field>
            <Field label="Planned completion">
              <input name="plannedCompletion" type="date" className={inputCls} />
            </Field>
          </div>

          <Field label="Description">
            <textarea name="description" rows={2} placeholder="Optional — scope, package, or notes." className={inputCls} />
          </Field>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost">Cancel</button>
            <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-70">
              {pending ? (
                <>
                  <span className="sp-spinner" aria-hidden />Creating…
                </>
              ) : (
                "Create project"
              )}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
