"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { TaskState } from "@/app/task-actions";
import type { ImportState, PreviewRow, SheetInfo } from "@/lib/import-types";
import {
  CountChips, FileDrop, ImportShell, MappingGrid, Note, SheetPicker, SourceBar, SourceTabs,
  Spinner, Verdict, headRow, rowTone, tableWrap,
} from "@/components/import-ui";

const EMPTY: TaskState = {};

export type Person = { id: string; name: string; role: string | null; depth: number };

export type HistoryEntry = {
  /** null when this entry took the task off someone rather than giving it to one. */
  toName: string | null;
  byName: string; type: string;
  source: string | null; at: number;
};

export type TaskRow = {
  id: string; ref: string | null; title: string; description: string | null;
  status: string; priority: string; progress: number;
  startDate: string | null; dueDate: string | null;
  assignedTo: string | null; assignedToName: string | null;
  assignedByName: string | null; createdByName: string | null;
  originalName: string | null;
  canEdit: boolean; isMine: boolean; iAssigned: boolean;
  delegatedToMe: boolean; delegatedByMe: boolean;
  history: HistoryEntry[];
};

type Action = (s: TaskState, f: FormData) => Promise<TaskState>;

const STATUS = [
  ["not_started", "Not started"], ["in_progress", "In progress"], ["completed", "Completed"],
] as const;
const PRIORITY = [["low", "Low"], ["medium", "Medium"], ["high", "High"]] as const;

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.88rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">{label}</span>
      {children}
    </label>
  );
}

/** Indented so the picker reads as the slice of the tree you may assign into. */
function PersonOptions({ people, selfId }: { people: Person[]; selfId: string | null }) {
  return (
    <>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {" ".repeat(p.depth * 2)}{p.name}{p.id === selfId ? " (you)" : ""}{p.role ? ` · ${p.role}` : ""}
        </option>
      ))}
    </>
  );
}

const StatusPill = ({ status }: { status: string }) => {
  const tone =
    status === "completed" ? "bg-accent-soft text-accent-strong"
    : status === "in_progress" ? "bg-amber-soft text-amber"
    : "bg-paper-sunk text-ink-soft";
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[0.66rem] whitespace-nowrap ${tone}`}>
      {STATUS.find(([v]) => v === status)?.[1] ?? status}
    </span>
  );
};

const PriorityMark = ({ priority }: { priority: string }) => {
  const tone = priority === "high" ? "text-rust" : priority === "low" ? "text-ink-soft" : "text-amber";
  return <span className={`font-mono text-[0.7rem] ${tone}`}>{priority}</span>;
};

// ---------------------------------------------------------------- create

export function CreateTask({
  action, people, projectId, selfId, canAssign,
}: { action: Action; people: Person[]; projectId: string; selfId: string | null; canAssign: boolean }) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLFormElement>(null);

  // Clear the form only once the server confirms it landed — on an error the
  // typed values stay put, which is what you want when it's rejected.
  useEffect(() => { if (state.ok) ref.current?.reset(); }, [state.ok]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-primary">
        + Create task
      </button>
    );
  }

  return (
    <form
      ref={ref}
      action={run}
      className="w-full space-y-3 rounded-xl border border-line bg-paper-raised p-5"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold tracking-wide">New task</h3>
        <button type="button" onClick={() => setOpen(false)} className="font-mono text-[0.76rem] text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
      <Note s={state} />

      <Field label="Task name">
        <input name="title" required placeholder="Cable tray erection — Unit 3" className={inputCls} />
      </Field>
      <Field label="Description">
        <textarea name="description" rows={2} placeholder="optional" className={inputCls} />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Start date"><input name="startDate" type="date" className={inputCls} /></Field>
        <Field label="Due date"><input name="dueDate" type="date" className={inputCls} /></Field>
        <Field label="Priority">
          <select name="priority" defaultValue="medium" className={inputCls}>
            {PRIORITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select name="status" defaultValue="not_started" className={inputCls}>
            {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Assign to">
        <select name="assignedTo" defaultValue={selfId ?? ""} className={inputCls}>
          <option value="">— unassigned</option>
          <PersonOptions people={people} selfId={selfId} />
        </select>
      </Field>
      <p className="text-[0.74rem] text-ink-soft">
        {canAssign
          ? "This list is your supervision scope — yourself and the people your role lets you reach. It never shows the whole organisation."
          : "Your role can't assign work to others, so you can only take a task yourself."}
      </p>

      <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
        {pending ? "Creating…" : "Create task"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- import

/**
 * Upload → pick sheet → map columns → review → import.
 *
 * The file stays on the server between steps; this only ever sends back the
 * staging id plus the choices made, and every step re-validates. The panel
 * chrome is shared with the People importer — see components/import-ui.
 */
export function ImportTasks(props: {
  startAction: (s: ImportState, f: FormData) => Promise<ImportState>;
  refineAction: (s: ImportState, f: FormData) => Promise<ImportState>;
  commitAction: (s: TaskState, f: FormData) => Promise<TaskState>;
  projectId: string;
  people: Person[];
  fields: readonly (readonly [string, string])[];
}) {
  const [open, setOpen] = useState(false);
  // Remounting is how "Start over" clears both useActionState hooks — there is
  // no reset for them, and threading an empty state back through is worse.
  const [attempt, setAttempt] = useState(0);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-ghost">
        Import tasks
      </button>
    );
  }
  return (
    <ImportBody
      key={attempt}
      {...props}
      onClose={() => setOpen(false)}
      onReset={() => setAttempt((n) => n + 1)}
    />
  );
}

function ImportBody({
  startAction, refineAction, commitAction, projectId, people, fields, onClose, onReset,
}: {
  startAction: (s: ImportState, f: FormData) => Promise<ImportState>;
  refineAction: (s: ImportState, f: FormData) => Promise<ImportState>;
  commitAction: (s: TaskState, f: FormData) => Promise<TaskState>;
  projectId: string;
  people: Person[];
  fields: readonly (readonly [string, string])[];
  onClose: () => void;
  onReset: () => void;
}) {
  const [state, start, starting] = useActionState(startAction, {} as ImportState);
  const [refined, refine, refining] = useActionState(refineAction, {} as ImportState);
  const [commitState, commit, committing] = useActionState(commitAction, EMPTY);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [onlyBad, setOnlyBad] = useState(false);

  // The newest analysis wins, whichever step produced it.
  const view: ImportState = refined.stagingId ? refined : state;
  const rows = view.rows ?? [];
  const counts = view.counts ?? {};
  const importable = (counts.valid ?? 0) + (counts.warning ?? 0);
  const shownRows = onlyBad ? rows.filter((r) => r.verdict !== "valid") : rows;

  return (
    <ImportShell title="Import tasks" step={view.stagingId ? 2 : 0} onClose={onClose}>
      {!view.stagingId && (
        <form action={start} className="space-y-3">
          <input type="hidden" name="projectId" value={projectId} />
          <Note s={state} />

          <SourceTabs mode={mode} onMode={setMode} />

          {mode === "file" ? (
            <FileDrop key="file" />
          ) : (
            <textarea key="paste" name="pasted" rows={6}
              placeholder={"Task Name,Start Date,Due Date,Priority,Assigned To\nCable tray erection — Unit 3,2026-03-01,2026-03-14,high,S. Ekka"}
              className={`${inputCls} font-mono text-[0.78rem]`} />
          )}

          <p className="text-[0.76rem] leading-relaxed text-ink-soft">
            You pick the sheet and confirm the column mapping in the next step. Nothing is
            written until you review it.
          </p>

          <button type="submit" disabled={starting} className="btn btn-primary disabled:opacity-70">
            {starting ? <><Spinner />Reading…</> : "Check file"}
          </button>
        </form>
      )}

      {view.stagingId && (
        <form action={refine} className="space-y-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="stagingId" value={view.stagingId} />

          <SourceBar
            filename={view.filename}
            // Only worth naming when there was a choice to make.
            sheet={(view.sheets?.length ?? 0) > 1
              ? view.sheets!.find((sh) => sh.index === view.sheetIndex)
              : undefined}
            total={counts.total ?? rows.length}
            noun="tasks"
            onReset={onReset}
          />
          <Note s={view} />
          <Note s={commitState} />

          <SheetPicker sheets={view.sheets} current={view.sheetIndex} />
          <MappingGrid header={view.header} mapping={view.mapping} fields={fields} />

          {rows.length > 0 && (
            <>
              <CountChips counts={counts} noun="tasks detected" filter={onlyBad} onFilter={setOnlyBad} />

              <div className={`${tableWrap} max-h-[24rem]`}>
                <table className="w-full min-w-[48rem] border-collapse text-[0.8rem]">
                  <thead className="sticky top-0 z-10 bg-paper-sunk">
                    <tr className={headRow}>
                      <th className="px-2.5 py-2">Row</th>
                      <th className="px-2.5 py-2">Ref</th>
                      <th className="px-2.5 py-2">Task</th>
                      <th className="px-2.5 py-2">Due</th>
                      <th className="px-2.5 py-2">Assigned to</th>
                      <th className="px-2.5 py-2">Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((r) => (
                      <tr key={r.line} className={`border-t border-line align-top ${rowTone(r.verdict)}`}>
                        <td className="px-2.5 py-1.5 font-mono text-ink-soft">{r.line}</td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.74rem] text-ink-soft">{r.ref ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-ink">{r.title || <span className="text-ink-soft">—</span>}</td>
                        <td className="px-2.5 py-1.5 font-mono text-ink-soft">{r.dueDate ?? "—"}</td>
                        <td className="px-2.5 py-1.5">
                          {/* Auto-assignment is a suggestion — every row stays editable. */}
                          <select name={`override:${r.line}`} defaultValue={r.assignedTo ?? ""}
                            aria-label={`Assignee for row ${r.line}`}
                            className="w-full min-w-[9rem] rounded-md border border-line-strong bg-paper px-1.5 py-1 text-[0.76rem] text-ink outline-none focus:border-accent">
                            <option value="">— unassigned</option>
                            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Verdict v={r.verdict} messages={r.messages} />
                        </td>
                      </tr>
                    ))}
                    {shownRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-2.5 py-6 text-center text-[0.8rem] text-ink-soft">
                          Nothing to fix — every row checks out.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {(view.shown ?? 0) < (counts.total ?? 0) && (
                <p className="font-mono text-[0.74rem] text-ink-soft">
                  Showing the first {view.shown} rows. All {counts.total} are validated and imported.
                </p>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <button type="submit" disabled={refining} className="btn btn-ghost disabled:opacity-70">
              {refining ? <><Spinner />Re-checking…</> : "Re-check"}
            </button>
            <button type="submit" formAction={commit} disabled={committing || importable === 0}
              className="btn btn-primary disabled:opacity-70">
              {committing ? <><Spinner />Importing…</> : `Import ${importable} task${importable === 1 ? "" : "s"}`}
            </button>
            <p className="text-[0.76rem] text-ink-soft">
              Rows marked <span className="text-rust">error</span> are never written, and the file is
              re-checked on import.
            </p>
          </div>
        </form>
      )}
    </ImportShell>
  );
}

// ---------------------------------------------------------------- list

const TABS = [
  ["all", "All tasks"], ["mine", "My tasks"], ["assigned", "Tasks I assigned"],
  ["delegated_to", "Delegated to me"], ["delegated_by", "Delegated by me"],
] as const;
type Tab = (typeof TABS)[number][0];

const TYPE_LABEL: Record<string, string> = {
  initial: "Assigned", delegated: "Delegated", reassigned: "Reassigned", unassigned: "Unassigned",
};

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The chain, oldest first. Reads as a hand-off trail rather than a log. */
function AssignmentChain({ history }: { history: HistoryEntry[] }) {
  if (!history.length) {
    return <p className="text-[0.8rem] text-ink-soft">No assignment yet.</p>;
  }
  return (
    <ol className="space-y-0">
      {history.map((h, i) => (
        <li key={i} className="relative pl-5">
          <span aria-hidden
            className={`absolute top-1.5 left-0 h-2 w-2 rounded-full ${
              i === history.length - 1 ? "bg-accent" : "bg-line-strong"
            }`} />
          {i < history.length - 1 && (
            <span aria-hidden className="absolute top-3.5 left-[3px] h-full w-px bg-line" />
          )}
          <p className="pb-3 text-[0.82rem]">
            <b className="text-ink">{h.byName}</b>
            {/* "unassigned to unassigned" was the old reading — an entry that
                clears the assignee has no recipient to name. */}
            {h.toName === null ? (
              <span className="text-ink-soft"> unassigned it</span>
            ) : (
              <>
                <span className="text-ink-soft"> {TYPE_LABEL[h.type]?.toLowerCase() ?? h.type} to </span>
                <b className="text-accent-strong">{h.toName}</b>
              </>
            )}
            {/* Only `auto` is worth calling out: it is the one the importer
                decided rather than a person, and it stays editable. */}
            {h.source === "auto" && (
              <span className="ml-1.5 rounded bg-amber-soft px-1.5 py-0.5 font-mono text-[0.64rem] text-amber">
                auto
              </span>
            )}
            <span className="ml-2 font-mono text-[0.7rem] text-ink-soft">{when(h.at)}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}

export function TaskTable({
  tasks, people, delegateTargets, projectId, selfId,
  statusAction, reassignAction, editAction, delegateAction, deleteAction, canAssign,
}: {
  tasks: TaskRow[]; people: Person[]; delegateTargets: Person[];
  projectId: string; selfId: string | null;
  statusAction: Action; reassignAction: Action; editAction: Action;
  delegateAction: Action; deleteAction: Action;
  canAssign: boolean;
}) {
  const [reassignState, runReassign] = useActionState(reassignAction, EMPTY);
  const [editState, runEdit] = useActionState(editAction, EMPTY);
  const [delegateState, runDelegate] = useActionState(delegateAction, EMPTY);
  // Both used to be fire-and-forget, so a refused status change or delete just
  // looked like nothing happened.
  const [statusState, runStatus] = useActionState(statusAction, EMPTY);
  const [deleteState, runDelete] = useActionState(deleteAction, EMPTY);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const counts = useMemo(() => ({
    all: tasks.length,
    mine: tasks.filter((t) => t.isMine).length,
    assigned: tasks.filter((t) => t.iAssigned).length,
    delegated_to: tasks.filter((t) => t.delegatedToMe).length,
    delegated_by: tasks.filter((t) => t.delegatedByMe).length,
  }), [tasks]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      if (tab === "mine" && !t.isMine) return false;
      if (tab === "delegated_to" && !t.delegatedToMe) return false;
      if (tab === "delegated_by" && !t.delegatedByMe) return false;
      if (tab === "assigned" && !t.iAssigned) return false;
      if (status && t.status !== status) return false;
      if (priority && t.priority !== priority) return false;
      if (assignee && t.assignedTo !== assignee) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.ref ?? "").toLowerCase().includes(q) ||
        (t.assignedToName ?? "").toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [tasks, tab, query, status, priority, assignee]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            className={`flex min-h-[38px] items-center gap-1.5 border-b-2 px-3 text-[0.84rem] transition-colors ${
              tab === id ? "border-accent font-semibold text-accent-strong" : "border-transparent text-ink-soft hover:text-ink"
            }`}>
            {label}
            <span className="font-mono text-[0.68rem] opacity-70">{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search task, ref, person…" aria-label="Search tasks"
          className={`${inputCls} max-w-[18rem]`} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"
          className={`${inputCls} max-w-[10rem]`}>
          <option value="">All statuses</option>
          {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Filter by priority"
          className={`${inputCls} max-w-[9rem]`}>
          <option value="">All priorities</option>
          {PRIORITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee"
          className={`${inputCls} max-w-[12rem]`}>
          <option value="">Anyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="ml-auto font-mono text-[0.74rem] text-ink-soft">{shown.length} of {tasks.length}</span>
      </div>

      <Note s={reassignState} />
      <Note s={editState} />
      <Note s={delegateState} />
      <Note s={statusState} />
      <Note s={deleteState} />

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
          <p className="font-display text-lg font-bold">
            {tasks.length ? "Nothing matches those filters." : "No tasks yet."}
          </p>
          <p className="mt-1 text-[0.86rem] text-ink-soft">
            {tasks.length ? "Try another tab, or clear the filters." : "Create one, or import your master task list."}
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {shown.map((t, i) => {
            const canDelegate = t.isMine && delegateTargets.length > 0;
            return (
              <li key={t.id} className={`bg-paper-raised ${i ? "border-t border-line" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3">
                  <div className="min-w-[14rem] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {t.ref && <span className="font-mono text-[0.7rem] text-ink-soft">{t.ref}</span>}
                      <span className="text-[0.92rem] font-semibold text-ink">{t.title}</span>
                      <StatusPill status={t.status} />
                      <PriorityMark priority={t.priority} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[0.72rem] text-ink-soft">
                      <span>
                        Assigned to{" "}
                        <b className={t.assignedToName ? "text-accent-strong" : ""}>
                          {t.assignedToName ?? "unassigned"}
                        </b>
                      </span>
                      {t.assignedByName && <span>by {t.assignedByName}</span>}
                      {t.dueDate && <span>due {t.dueDate}</span>}
                      {t.history.length > 1 && (
                        <span className="text-amber">{t.history.length} handoffs</span>
                      )}
                    </div>
                  </div>

                  {t.isMine && (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[0.64rem] text-accent-strong">
                      assigned to you
                    </span>
                  )}

                  {t.canEdit ? (
                    <form action={runStatus} className="flex items-center gap-2">
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="taskId" value={t.id} />
                      <select name="status" defaultValue={t.status}
                        onChange={(e) => e.currentTarget.form?.requestSubmit()}
                        aria-label={`Status for ${t.title}`}
                        className="rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[0.8rem] text-ink outline-none focus:border-accent">
                        {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </form>
                  ) : (
                    <span className="font-mono text-[0.7rem] text-ink-soft" title="Outside your supervision scope">
                      view only
                    </span>
                  )}

                  <button type="button" onClick={() => setOpenId(openId === t.id ? null : t.id)}
                    aria-expanded={openId === t.id}
                    className="min-h-[32px] rounded-md px-2 font-mono text-[0.74rem] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent-strong">
                    {openId === t.id ? "Close" : "Details"}
                  </button>
                </div>

                {openId === t.id && (
                  <div className="space-y-5 border-t border-line bg-paper px-4 py-4">
                    {t.description && (
                      <p className="max-w-[70ch] text-[0.86rem] leading-relaxed text-ink-soft">{t.description}</p>
                    )}

                    <div className="grid gap-5 lg:grid-cols-2">
                      <div>
                        <p className="label mb-2">Assignment</p>
                        <dl className="grid gap-1.5 text-[0.84rem]">
                          {[
                            ["Original assignee", t.originalName ?? "—"],
                            ["Current assignee", t.assignedToName ?? "unassigned"],
                            ["Assigned by", t.assignedByName ?? "—"],
                            ["Created by", t.createdByName ?? "—"],
                            ["Start", t.startDate ?? "—"],
                            ["Due", t.dueDate ?? "—"],
                          ].map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-3 border-b border-line pb-1">
                              <dt className="text-ink-soft">{k}</dt><dd className="text-ink">{v}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                      <div>
                        <p className="label mb-2">Assignment history</p>
                        <AssignmentChain history={t.history} />
                      </div>
                    </div>

                    {canDelegate && (
                      <form action={async (fd) => { await runDelegate(fd); setOpenId(null); }}
                        className="flex flex-wrap items-end gap-2 rounded-lg border border-accent/40 bg-accent-soft/30 p-3">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <Field label="Delegate to">
                          <select name="assignedTo" required className={`${inputCls} min-w-[16rem]`}>
                            <option value="">Choose someone…</option>
                            <PersonOptions people={delegateTargets} selfId={selfId} />
                          </select>
                        </Field>
                        <button type="submit" className="btn btn-primary">Delegate task</button>
                        <p className="w-full text-[0.74rem] text-ink-soft">
                          It becomes theirs, and the chain above keeps who handed it down.
                        </p>
                      </form>
                    )}

                    {t.canEdit && (
                      <form action={async (fd) => { await runEdit(fd); setOpenId(null); }} className="space-y-3">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <Field label="Task name">
                          <input name="title" defaultValue={t.title} required className={inputCls} />
                        </Field>
                        <Field label="Description">
                          <textarea name="description" rows={2} defaultValue={t.description ?? ""} className={inputCls} />
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <Field label="Start date">
                            <input name="startDate" type="date" defaultValue={t.startDate ?? ""} className={inputCls} />
                          </Field>
                          <Field label="Due date">
                            <input name="dueDate" type="date" defaultValue={t.dueDate ?? ""} className={inputCls} />
                          </Field>
                          <Field label="Priority">
                            <select name="priority" defaultValue={t.priority} className={inputCls}>
                              {PRIORITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          </Field>
                          <Field label="Status">
                            <select name="status" defaultValue={t.status} className={inputCls}>
                              {STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          </Field>
                        </div>
                        <Field label={`Progress — ${t.progress}%`}>
                          <input name="progress" type="range" min={0} max={100} step={5}
                            defaultValue={t.progress}
                            className="w-full accent-[var(--accent)]" />
                        </Field>
                        <button type="submit" className="btn btn-primary">Save changes</button>
                      </form>
                    )}

                    {t.canEdit && canAssign && (
                      <form action={async (fd) => { await runReassign(fd); setOpenId(null); }}
                        className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <Field label="Reassign to">
                          <select name="assignedTo" defaultValue={t.assignedTo ?? ""} className={`${inputCls} min-w-[16rem]`}>
                            <option value="">— unassigned</option>
                            <PersonOptions people={people} selfId={selfId} />
                          </select>
                        </Field>
                        <button type="submit" className="btn btn-ghost">Reassign</button>
                      </form>
                    )}

                    {t.canEdit && (
                      <form action={runDelete} className="border-t border-line pt-4"
                        onSubmit={(e) => { if (!confirm(`Delete "${t.title}"?`)) e.preventDefault(); }}>
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <button className="font-mono text-[0.76rem] text-ink-soft transition-colors hover:text-rust">
                          Delete task
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
