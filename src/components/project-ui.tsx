"use client";

import { useActionState, useState } from "react";
import type { TeamState } from "@/app/team-actions";

const EMPTY: TeamState = {};
type Action = (s: TeamState, f: FormData) => Promise<TeamState>;

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.88rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

function Note({ s }: { s: TeamState }) {
  if (!s.error && !s.ok) return null;
  const bad = !!s.error;
  return (
    <div role={bad ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-[0.85rem] ${bad ? "bg-rust-soft text-rust" : "bg-accent-soft text-accent-strong"}`}>
      {s.error ?? s.ok}
    </div>
  );
}

export function CreateProject({ action }: { action: Action }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const [open, setOpen] = useState(false);

  if (!open) {
    return <button onClick={() => setOpen(true)} className="btn btn-primary">+ New project</button>;
  }

  return (
    <form action={run} className="w-full max-w-[36rem] space-y-3 rounded-xl border border-line bg-paper-raised p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold tracking-wide">New project</h3>
        <button type="button" onClick={() => setOpen(false)} className="font-mono text-[0.76rem] text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
      <Note s={state} />
      <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
        <label className="block">
          <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Project name</span>
          <input name="name" required placeholder="Rajouri Garden Pipeline" className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Code</span>
          <input name="code" placeholder="optional" className={inputCls} />
        </label>
      </div>
      <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
        {pending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}

export function DeleteProject({
  action, projectId, name,
}: { action: (f: FormData) => void | Promise<void>; projectId: string; name: string }) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Delete "${name}"? Its people structure and every task on it go with it. People stay on your other projects.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="projectId" value={projectId} />
      <button className="btn btn-ghost text-rust hover:border-rust">Delete this project</button>
    </form>
  );
}
