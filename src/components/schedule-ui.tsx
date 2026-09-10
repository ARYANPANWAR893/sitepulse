"use client";

import { useActionState, useMemo, useState } from "react";
import { Note } from "@/components/import-ui";
import type { ScheduleState } from "@/app/schedule-actions";

/**
 * The schedule view.
 *
 * Reads as project controls, not a task list: a WBS rail on the left, a dense
 * fixed-column grid in the middle, Activity IDs in mono, planned against
 * baseline, and variance called out rather than hidden. Nothing here invents a
 * new design language — it is the same paper/ink/accent tokens, used denser.
 */

const EMPTY: ScheduleState = {};
type Action = (s: ScheduleState, f: FormData) => Promise<ScheduleState>;

export type ActivityRow = {
  id: string;
  activityId: string | null;
  title: string;
  description: string | null;
  wbs: string | null;
  wbsPath: string | null;
  discipline: string | null;
  location: string | null;
  status: string;
  progress: number;
  plannedStart: string | null;
  plannedFinish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  plannedDuration: number | null;
  notes: string | null;
  origin: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  canEdit: boolean;
  reportCount: number;
  predecessors: { id: string; ref: string | null; title: string; relationId: string }[];
  successors: { id: string; ref: string | null; title: string; relationId: string }[];
};

export type WbsRow = { code: string; label: string; level: number; count: number };
export type PersonOption = { id: string; name: string; role: string | null };

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started", in_progress: "In progress", completed: "Complete",
};
const STATUS_TONE: Record<string, string> = {
  not_started: "bg-paper-sunk text-ink-soft",
  in_progress: "bg-accent-soft text-accent-strong",
  completed: "bg-accent text-on-accent",
};

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.86rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";
const selectCls =
  "rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[0.8rem] text-ink outline-none focus:border-accent";

const fmt = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" }) : "—";

/** Whole days between two ISO dates, positive when `b` is later. */
function dayDelta(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[0.7rem] text-ink-soft">{hint}</span>}
    </label>
  );
}

/** Progress as a bar, because a column of bare percentages doesn't scan. */
function ProgressBar({ value, status }: { value: number; status: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-paper-sunk">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            status === "completed" ? "bg-accent" : "bg-accent-strong"
          }`}
          style={{ width: `${Math.max(value, value > 0 ? 4 : 0)}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right font-mono text-[0.72rem] text-ink-soft tabular-nums">{value}%</span>
    </div>
  );
}

/**
 * Finish variance against the baseline.
 *
 * The single number a planner looks for first, so it earns its own column
 * rather than living inside the detail panel.
 */
function Variance({ a }: { a: ActivityRow }) {
  const delta = dayDelta(a.baselineFinish, a.actualFinish ?? a.plannedFinish);
  if (delta === null) return <span className="font-mono text-[0.72rem] text-ink-soft">—</span>;
  if (delta === 0) return <span className="font-mono text-[0.72rem] text-accent-strong">on plan</span>;
  return (
    <span className={`font-mono text-[0.72rem] tabular-nums ${delta > 0 ? "text-rust" : "text-accent-strong"}`}>
      {delta > 0 ? `+${delta}d` : `${delta}d`}
    </span>
  );
}

// ---------------------------------------------------------------- WBS rail

function WbsRail({
  rows, value, onPick, total,
}: { rows: WbsRow[]; value: string; onPick: (code: string) => void; total: number }) {
  return (
    <nav aria-label="Work breakdown structure" className="space-y-0.5">
      <button
        type="button"
        onClick={() => onPick("")}
        className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[0.82rem] transition-colors ${
          value === "" ? "bg-accent-soft text-accent-strong" : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
        }`}
      >
        <span className="font-semibold">Whole schedule</span>
        <span className="font-mono text-[0.7rem] tabular-nums opacity-70">{total}</span>
      </button>
      {rows.map((n) => (
        <button
          key={n.code}
          type="button"
          onClick={() => onPick(n.code)}
          style={{ paddingLeft: `${0.5 + (n.level - 1) * 0.75}rem` }}
          className={`flex w-full items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-left text-[0.8rem] transition-colors ${
            value === n.code ? "bg-accent-soft text-accent-strong" : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
          }`}
        >
          <span className="min-w-0 truncate">
            <span className="font-mono text-[0.68rem] opacity-60">{n.code}</span>{" "}
            {n.label !== n.code && n.label}
          </span>
          <span className="font-mono text-[0.7rem] tabular-nums opacity-60">{n.count}</span>
        </button>
      ))}
      {rows.length === 0 && (
        <p className="px-2 py-3 text-[0.78rem] text-ink-soft">
          No WBS codes yet. Map a <b>WBS</b> column when you import.
        </p>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- detail

function DetailPanel({
  a, people, projectId, canAssign,
  editAction, reportAction, reassignAction, unlinkAction, onClose,
}: {
  a: ActivityRow; people: PersonOption[]; projectId: string; canAssign: boolean;
  editAction: Action; reportAction: Action; reassignAction: Action; unlinkAction: Action;
  onClose: () => void;
}) {
  const [editState, runEdit] = useActionState(editAction, EMPTY);
  const [reportState, runReport] = useActionState(reportAction, EMPTY);
  const [assignState, runAssign] = useActionState(reassignAction, EMPTY);
  const [unlinkState, runUnlink] = useActionState(unlinkAction, EMPTY);
  const [tab, setTab] = useState<"detail" | "logic" | "report">("detail");

  const startVar = dayDelta(a.baselineStart, a.actualStart ?? a.plannedStart);

  return (
    <div className="border-t border-line bg-paper">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        {(["detail", "logic", "report"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-2.5 py-1 font-mono text-[0.72rem] tracking-wider uppercase transition-colors ${
              tab === t ? "bg-accent text-on-accent" : "text-ink-soft hover:text-ink"
            }`}
          >
            {t === "detail" ? "Activity" : t === "logic" ? `Logic (${a.predecessors.length + a.successors.length})` : `Field reports (${a.reportCount})`}
          </button>
        ))}
        <button type="button" onClick={onClose} className="ml-auto font-mono text-[0.74rem] text-ink-soft hover:text-ink">
          Close
        </button>
      </div>

      <div className="space-y-5 px-4 py-4">
        <Note s={editState} />
        <Note s={reportState} />
        <Note s={assignState} />
        <Note s={unlinkState} />

        {tab === "detail" && (
          <>
            <div className="grid gap-5 lg:grid-cols-2">
              <div>
                <p className="mb-2 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Schedule position</p>
                <dl className="grid gap-1.5 text-[0.84rem]">
                  {([
                    ["Activity ID", a.activityId ?? "—"],
                    ["WBS", a.wbs ?? "—"],
                    ["WBS path", a.wbsPath ?? "—"],
                    ["Discipline", a.discipline ?? "—"],
                    ["Location", a.location ?? "—"],
                    ["Source", a.origin === "import" ? "Imported" : "Entered by hand"],
                  ] as const).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-line pb-1">
                      <dt className="shrink-0 text-ink-soft">{k}</dt>
                      <dd className="min-w-0 truncate text-right text-ink" title={String(v)}>{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div>
                <p className="mb-2 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Dates</p>
                <table className="w-full text-[0.82rem]">
                  <thead>
                    <tr className="font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
                      <th className="pb-1 text-left font-normal" />
                      <th className="pb-1 text-right font-normal">Start</th>
                      <th className="pb-1 text-right font-normal">Finish</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {([
                      ["Planned", a.plannedStart, a.plannedFinish],
                      ["Baseline", a.baselineStart, a.baselineFinish],
                      ["Actual", a.actualStart, a.actualFinish],
                    ] as const).map(([k, s, f]) => (
                      <tr key={k} className="border-t border-line">
                        <td className="py-1 text-ink-soft">{k}</td>
                        <td className="py-1 text-right font-mono text-[0.78rem] text-ink">{fmt(s)}</td>
                        <td className="py-1 text-right font-mono text-[0.78rem] text-ink">{fmt(f)}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-line">
                      <td className="py-1 text-ink-soft">Variance</td>
                      <td className="py-1 text-right font-mono text-[0.78rem]">
                        {startVar === null ? "—" : (
                          <span className={startVar > 0 ? "text-rust" : "text-accent-strong"}>
                            {startVar > 0 ? `+${startVar}d` : `${startVar}d`}
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right"><Variance a={a} /></td>
                    </tr>
                  </tbody>
                </table>
                {a.plannedDuration !== null && (
                  <p className="mt-2 font-mono text-[0.72rem] text-ink-soft">
                    Original duration {a.plannedDuration}d
                  </p>
                )}
              </div>
            </div>

            {a.canEdit ? (
              <form action={runEdit} className="space-y-3 border-t border-line pt-4">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="activityId" value={a.id} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Activity name">
                    <input name="title" defaultValue={a.title} required className={inputCls} />
                  </Field>
                  <Field label="Discipline">
                    <input name="discipline" defaultValue={a.discipline ?? ""} className={inputCls} />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="WBS code"><input name="wbs" defaultValue={a.wbs ?? ""} className={inputCls} /></Field>
                  <Field label="Location"><input name="location" defaultValue={a.location ?? ""} className={inputCls} /></Field>
                  <Field label="Planned start"><input name="plannedStart" type="date" defaultValue={a.plannedStart ?? ""} className={inputCls} /></Field>
                  <Field label="Planned finish"><input name="plannedFinish" type="date" defaultValue={a.plannedFinish ?? ""} className={inputCls} /></Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Baseline start"><input name="baselineStart" type="date" defaultValue={a.baselineStart ?? ""} className={inputCls} /></Field>
                  <Field label="Baseline finish"><input name="baselineFinish" type="date" defaultValue={a.baselineFinish ?? ""} className={inputCls} /></Field>
                  <Field label="Actual start"><input name="actualStart" type="date" defaultValue={a.actualStart ?? ""} className={inputCls} /></Field>
                  <Field label="Actual finish"><input name="actualFinish" type="date" defaultValue={a.actualFinish ?? ""} className={inputCls} /></Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Status">
                    <select name="status" defaultValue={a.status} className={inputCls}>
                      {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </Field>
                  <Field label={`Progress — ${a.progress}%`}
                    hint="Editing this directly bypasses review; a field report is the audited route.">
                    <input name="progress" type="range" min={0} max={100} step={5}
                      defaultValue={a.progress} className="w-full accent-[var(--accent)]" />
                  </Field>
                </div>
                <Field label="Notes">
                  <textarea name="notes" rows={2} defaultValue={a.notes ?? ""} className={inputCls} />
                </Field>
                <button type="submit" className="btn btn-primary">Save activity</button>
              </form>
            ) : (
              <p className="border-t border-line pt-4 font-mono text-[0.76rem] text-ink-soft">
                Read-only — this activity is outside what you supervise.
              </p>
            )}

            {a.canEdit && canAssign && (
              <form action={runAssign} className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="taskId" value={a.id} />
                <Field label="Responsible">
                  <select name="assignedTo" defaultValue={a.assignedTo ?? ""} className={`${inputCls} min-w-[15rem]`}>
                    <option value="">— unassigned</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.role ? ` · ${p.role}` : ""}</option>
                    ))}
                  </select>
                </Field>
                <button type="submit" className="btn btn-ghost">Reassign</button>
              </form>
            )}
          </>
        )}

        {tab === "logic" && (
          <div className="grid gap-5 lg:grid-cols-2">
            {([["Predecessors", a.predecessors], ["Successors", a.successors]] as const).map(([label, list]) => (
              <div key={label}>
                <p className="mb-2 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">{label}</p>
                {list.length === 0 ? (
                  <p className="text-[0.8rem] text-ink-soft">None recorded.</p>
                ) : (
                  <ul className="space-y-1">
                    {list.map((r) => (
                      <li key={r.relationId} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
                        <span className="font-mono text-[0.72rem] text-accent-strong">{r.ref ?? "—"}</span>
                        <span className="min-w-0 flex-1 truncate text-[0.82rem] text-ink">{r.title}</span>
                        {a.canEdit && (
                          <form action={runUnlink}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="relationId" value={r.relationId} />
                            <button className="font-mono text-[0.7rem] text-ink-soft transition-colors hover:text-rust">
                              remove
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <p className="lg:col-span-2 font-mono text-[0.72rem] text-ink-soft">
              Links come from the Predecessors and Successors columns at import. A dependency
              that would close a loop is refused.
            </p>
          </div>
        )}

        {tab === "report" && (
          <form action={runReport} className="max-w-[46rem] space-y-3">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="activityId" value={a.id} />
            <p className="text-[0.84rem] leading-relaxed text-ink-soft">
              Log what the field actually reported. It is stored as a claim against this
              activity and waits for review — the schedule does not move until someone accepts it.
            </p>
            <Field label="What was reported">
              <textarea name="rawText" rows={2} required
                placeholder="Welded 6 of 10 joints on the 12 inch line today"
                className={inputCls} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Progress claimed">
                <input name="progress" type="number" min={0} max={100} placeholder={String(a.progress)} className={inputCls} />
              </Field>
              <Field label="Status claimed">
                <select name="status" defaultValue="" className={inputCls}>
                  <option value="">— unchanged</option>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Actual start"><input name="actualStart" type="date" className={inputCls} /></Field>
              <Field label="Actual finish"><input name="actualFinish" type="date" className={inputCls} /></Field>
            </div>
            <button type="submit" className="btn btn-primary">Log field report</button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- table

export function ScheduleView({
  activities, wbs, people, disciplines, locations, projectId, canAssign,
  editAction, reportAction, reassignAction, unlinkAction,
}: {
  activities: ActivityRow[];
  wbs: WbsRow[];
  people: PersonOption[];
  disciplines: string[];
  locations: string[];
  projectId: string;
  canAssign: boolean;
  editAction: Action; reportAction: Action; reassignAction: Action; unlinkAction: Action;
}) {
  const [query, setQuery] = useState("");
  const [wbsCode, setWbsCode] = useState("");
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");
  const [discipline, setDiscipline] = useState("");
  const [location, setLocation] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return activities.filter((a) => {
      if (wbsCode && !(a.wbs === wbsCode || a.wbs?.startsWith(`${wbsCode}.`))) return false;
      if (status && a.status !== status) return false;
      if (discipline && a.discipline !== discipline) return false;
      if (location && a.location !== location) return false;
      if (assignee === "unassigned" ? a.assignedTo !== null : assignee && a.assignedTo !== assignee) return false;
      if (needle) {
        const hay = `${a.activityId ?? ""} ${a.title} ${a.wbsPath ?? ""} ${a.discipline ?? ""} ${a.location ?? ""}`;
        if (!hay.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [activities, query, wbsCode, status, assignee, discipline, location]);

  const rollup = useMemo(() => {
    const complete = shown.filter((a) => a.status === "completed").length;
    const running = shown.filter((a) => a.status === "in_progress").length;
    const late = shown.filter((a) => {
      const d = dayDelta(a.baselineFinish, a.actualFinish ?? a.plannedFinish);
      return d !== null && d > 0;
    }).length;
    const weighted = shown.length ? Math.round(shown.reduce((n, a) => n + a.progress, 0) / shown.length) : 0;
    return { complete, running, late, weighted };
  }, [shown]);

  const filtered = Boolean(query || wbsCode || status || assignee || discipline || location);

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      {/* WBS rail */}
      <aside className="rounded-xl border border-line bg-paper-raised p-2 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
        <p className="px-2 py-1.5 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
          Work breakdown
        </p>
        <WbsRail rows={wbs} value={wbsCode} onPick={setWbsCode} total={activities.length} />
      </aside>

      <div className="min-w-0 space-y-3">
        {/* roll-up */}
        <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
          {([
            ["Activities", String(shown.length), filtered ? "in this view" : "in the schedule"],
            ["Average progress", `${rollup.weighted}%`, "unweighted mean"],
            ["In progress", String(rollup.running), `${rollup.complete} complete`],
            ["Behind baseline", String(rollup.late), "finish later than baseline"],
          ] as const).map(([k, v, hint]) => (
            <div key={k} className="bg-paper-raised p-3">
              <dt className="font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">{k}</dt>
              <dd className={`mt-1 font-display text-2xl font-bold tabular-nums ${
                k === "Behind baseline" && rollup.late > 0 ? "text-rust" : ""
              }`}>{v}</dd>
              <p className="text-[0.7rem] text-ink-soft">{hint}</p>
            </div>
          ))}
        </dl>

        {/* filters */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper-raised p-2.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search activity ID, name, WBS path…"
            aria-label="Search activities"
            className={`${selectCls} min-w-[14rem] flex-1`}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" className={selectCls}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={discipline} onChange={(e) => setDiscipline(e.target.value)} aria-label="Filter by discipline" className={selectCls}>
            <option value="">All disciplines</option>
            {disciplines.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Filter by location" className={selectCls}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Filter by assignee" className={selectCls}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {filtered && (
            <button
              type="button"
              onClick={() => { setQuery(""); setWbsCode(""); setStatus(""); setAssignee(""); setDiscipline(""); setLocation(""); }}
              className="font-mono text-[0.74rem] text-ink-soft transition-colors hover:text-accent-strong"
            >
              Clear
            </button>
          )}
        </div>

        {/* grid */}
        {activities.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-14 text-center">
            <p className="font-display text-xl font-bold">No schedule loaded.</p>
            <p className="mx-auto mt-1 max-w-[46ch] text-[0.86rem] text-ink-soft">
              Import a Primavera or MS Project export — Activity ID, WBS, dates and
              predecessors are all read — or add an activity by hand.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
            <p className="text-[0.9rem] text-ink-soft">No activity matches those filters.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[62rem] border-collapse text-[0.82rem]">
                <thead className="bg-paper-sunk">
                  <tr className="text-left font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
                    <th className="px-2.5 py-2">Activity ID</th>
                    <th className="px-2.5 py-2">WBS</th>
                    <th className="px-2.5 py-2">Activity</th>
                    <th className="px-2.5 py-2">Discipline</th>
                    <th className="px-2.5 py-2 text-right">Planned start</th>
                    <th className="px-2.5 py-2 text-right">Planned finish</th>
                    <th className="px-2.5 py-2 text-right">Var.</th>
                    <th className="px-2.5 py-2">Progress</th>
                    <th className="px-2.5 py-2">Status</th>
                    <th className="px-2.5 py-2">Responsible</th>
                    <th className="px-2.5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <>
                      <tr
                        key={a.id}
                        className={`border-t border-line transition-colors hover:bg-paper-sunk/50 ${
                          openId === a.id ? "bg-paper-sunk/60" : "bg-paper-raised"
                        }`}
                      >
                        <td className="px-2.5 py-1.5 font-mono text-[0.76rem] whitespace-nowrap text-accent-strong">
                          {a.activityId ?? "—"}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.74rem] whitespace-nowrap text-ink-soft">
                          {a.wbs ?? "—"}
                        </td>
                        <td className="max-w-[24rem] px-2.5 py-1.5">
                          <span className="block truncate text-ink" title={a.title}>{a.title}</span>
                          {a.wbsPath && (
                            <span className="block truncate font-mono text-[0.68rem] text-ink-soft" title={a.wbsPath}>
                              {a.wbsPath}
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap text-ink-soft">{a.discipline ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-[0.76rem] whitespace-nowrap text-ink-soft tabular-nums">
                          {fmt(a.plannedStart)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right font-mono text-[0.76rem] whitespace-nowrap text-ink tabular-nums">
                          {fmt(a.plannedFinish)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right whitespace-nowrap"><Variance a={a} /></td>
                        <td className="px-2.5 py-1.5"><ProgressBar value={a.progress} status={a.status} /></td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          <span className={`rounded-full px-2 py-0.5 font-mono text-[0.66rem] ${STATUS_TONE[a.status]}`}>
                            {STATUS_LABEL[a.status] ?? a.status}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap text-ink-soft">
                          {a.assignedToName ?? <span className="italic opacity-70">unassigned</span>}
                        </td>
                        <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                          {a.reportCount > 0 && (
                            <span
                              title={`${a.reportCount} field report${a.reportCount === 1 ? "" : "s"}`}
                              className="mr-1.5 rounded-full bg-amber-soft px-1.5 py-0.5 font-mono text-[0.64rem] text-amber"
                            >
                              {a.reportCount}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => setOpenId(openId === a.id ? null : a.id)}
                            aria-expanded={openId === a.id}
                            className="rounded-md px-2 py-1 font-mono text-[0.72rem] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent-strong"
                          >
                            {openId === a.id ? "Close" : "Open"}
                          </button>
                        </td>
                      </tr>
                      {openId === a.id && (
                        <tr key={`${a.id}-detail`}>
                          <td colSpan={11} className="p-0">
                            <DetailPanel
                              a={a} people={people} projectId={projectId} canAssign={canAssign}
                              editAction={editAction} reportAction={reportAction}
                              reassignAction={reassignAction} unlinkAction={unlinkAction}
                              onClose={() => setOpenId(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- new activity

export function NewActivity({ action, projectId, people }: {
  action: Action; projectId: string; people: PersonOption[];
}) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const [open, setOpen] = useState(false);

  if (!open) {
    return <button onClick={() => setOpen(true)} className="btn btn-primary">+ Add activity</button>;
  }
  return (
    <div className="w-full space-y-3 rounded-xl border border-line bg-paper-raised p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold tracking-wide">Add a schedule activity</h3>
        <button type="button" onClick={() => setOpen(false)} className="font-mono text-[0.76rem] text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
      <Note s={state} />
      <form action={run} className="space-y-3">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Activity name">
            <input name="title" required placeholder="Hydrotest 12in CS line" className={inputCls} />
          </Field>
          <Field label="Discipline"><input name="discipline" placeholder="Piping" className={inputCls} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="WBS code" hint="Dotted, e.g. 1.2.1"><input name="wbs" placeholder="1.2.1" className={inputCls} /></Field>
          <Field label="WBS path"><input name="wbsPath" placeholder="Unit 3 > Piping > Testing" className={inputCls} /></Field>
          <Field label="Planned start"><input name="plannedStart" type="date" className={inputCls} /></Field>
          <Field label="Planned finish"><input name="plannedFinish" type="date" className={inputCls} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Location"><input name="location" placeholder="Unit 3" className={inputCls} /></Field>
          <Field label="Duration (days)"><input name="plannedDuration" type="number" min={0} className={inputCls} /></Field>
          <Field label="Responsible">
            <select name="assignedTo" defaultValue="" className={inputCls}>
              <option value="">— unassigned</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-70">
          {pending ? "Adding…" : "Add activity"}
        </button>
      </form>
    </div>
  );
}
