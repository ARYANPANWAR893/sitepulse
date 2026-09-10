"use client";

import { useActionState, useState } from "react";
import {
  CountChips, FileDrop, ImportShell, MappingGrid, Note, SheetPicker, SourceBar,
  SourceTabs, Spinner, Verdict, headRow, rowTone, tableWrap,
} from "@/components/import-ui";
import type { ScheduleImportState } from "@/lib/import-types";
import type { ScheduleState } from "@/app/schedule-actions";
import type { PersonOption } from "@/components/schedule-ui";

/**
 * Schedule import.
 *
 * Same four beats as every other importer here — source, sheet, map, review —
 * with one addition the task importer never needed: a re-issued schedule has to
 * be able to *update* activities it already knows, so the mode is chosen before
 * the preview and the preview says how each row will land.
 */

const EMPTY: ScheduleState = {};
type StartAction = (s: ScheduleImportState, f: FormData) => Promise<ScheduleImportState>;
type CommitAction = (s: ScheduleState, f: FormData) => Promise<ScheduleState>;

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.86rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

const ACTION_TONE: Record<string, string> = {
  create: "bg-accent-soft text-accent-strong",
  update: "bg-amber-soft text-amber",
  skip: "bg-rust-soft text-rust",
};

const SAMPLE = [
  "Activity ID,Activity Name,WBS,WBS Path,Discipline,Location,Planned Start,Planned Finish,Duration,Predecessors,% Complete,Status,Assignee",
  "A1010,Excavate trench,1.1,Unit 3 > Civil,Civil,Unit 3,2026-01-05,2026-01-12,7,,100,Complete,",
  "A1020,Lay pipe spool,1.2,Unit 3 > Piping,Piping,Unit 3,2026-01-13,2026-01-25,12,A1010,40,In Progress,",
].join("\n");

export function ImportSchedule(props: {
  startAction: StartAction;
  refineAction: StartAction;
  commitAction: CommitAction;
  projectId: string;
  people: PersonOption[];
  fields: readonly (readonly [string, string])[];
  hasSchedule: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Remounting is how "Start over" clears the action states — there is no reset
  // for useActionState, and threading an empty state back is worse.
  const [attempt, setAttempt] = useState(0);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-ghost">
        Import schedule
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
  startAction, refineAction, commitAction, projectId, people, fields, hasSchedule,
  onClose, onReset,
}: {
  startAction: StartAction;
  refineAction: StartAction;
  commitAction: CommitAction;
  projectId: string;
  people: PersonOption[];
  fields: readonly (readonly [string, string])[];
  hasSchedule: boolean;
  onClose: () => void;
  onReset: () => void;
}) {
  const [state, start, starting] = useActionState(startAction, {} as ScheduleImportState);
  const [refined, refine, refining] = useActionState(refineAction, {} as ScheduleImportState);
  const [commitState, commit, committing] = useActionState(commitAction, EMPTY);
  const [source, setSource] = useState<"file" | "paste">("file");
  // Defaults to update once a schedule exists, because that is what a weekly
  // re-issue is; the first import can only be a create.
  const [mode, setMode] = useState<"create" | "update">(hasSchedule ? "update" : "create");
  const [onlyBad, setOnlyBad] = useState(false);

  const view: ScheduleImportState = refined.stagingId ? refined : state;
  const rows = view.rows ?? [];
  const counts = view.counts ?? {};
  const importable = (counts.create ?? 0) + (counts.update ?? 0);
  const shownRows = onlyBad ? rows.filter((r) => r.verdict !== "valid") : rows;

  const ModePicker = (
    <fieldset className="rounded-lg border border-line bg-paper-sunk/50 p-3">
      <legend className="px-1 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
        How should this file land?
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {([
          ["create", "New schedule", "Every row is a new activity. An Activity ID that already exists is refused."],
          ["update", "Update existing", "Rows matching an Activity ID refresh it in place. Anything new is added."],
        ] as const).map(([v, label, hint]) => (
          <label
            key={v}
            className={`cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
              mode === v ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent"
            }`}
          >
            <input type="radio" name="mode" value={v} checked={mode === v}
              onChange={() => setMode(v)} className="sr-only" />
            <span className={`block text-[0.86rem] font-semibold ${mode === v ? "text-accent-strong" : "text-ink"}`}>
              {label}
            </span>
            <span className="mt-0.5 block text-[0.74rem] leading-snug text-ink-soft">{hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <ImportShell title="Import schedule" step={view.stagingId ? 2 : 0} onClose={onClose}>
      {!view.stagingId && (
        <form action={start} className="space-y-3">
          <input type="hidden" name="projectId" value={projectId} />
          <Note s={state} />

          {ModePicker}
          <SourceTabs mode={source} onMode={setSource} />

          {source === "file" ? (
            <FileDrop key="file" />
          ) : (
            <textarea key="paste" name="pasted" rows={6} placeholder={SAMPLE}
              className={`${inputCls} font-mono text-[0.74rem]`} />
          )}

          <p className="text-[0.76rem] leading-relaxed text-ink-soft">
            A Primavera P6 or MS Project export works as-is — Activity ID, WBS, planned and
            baseline dates, duration, predecessors, progress and assignee are all recognised.
            You confirm the sheet and the column mapping next; nothing is written until you review it.
          </p>

          <button type="submit" disabled={starting} className="btn btn-primary disabled:opacity-70">
            {starting ? <><Spinner />Reading…</> : "Read schedule"}
          </button>
        </form>
      )}

      {view.stagingId && (
        <form action={refine} className="space-y-4">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="stagingId" value={view.stagingId} />
          <input type="hidden" name="mode" value={mode} />

          <SourceBar
            filename={view.filename}
            sheet={(view.sheets?.length ?? 0) > 1
              ? view.sheets!.find((sh) => sh.index === view.sheetIndex)
              : undefined}
            total={counts.total ?? rows.length}
            noun="activities"
            onReset={onReset}
          />
          <Note s={view} />
          <Note s={commitState} />

          {/* Mode stays changeable after the preview — seeing 240 duplicates is
              usually what tells you this was meant to be an update. */}
          {ModePicker}

          <SheetPicker sheets={view.sheets} current={view.sheetIndex} />
          <MappingGrid header={view.header} mapping={view.mapping} fields={fields} />

          {rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-paper-sunk px-2.5 py-1 font-mono text-[0.72rem] text-ink">
                  {counts.total ?? 0} rows · {counts.columns ?? 0} columns · {view.mappedColumns ?? 0} mapped
                </span>
                {(counts.create ?? 0) > 0 && (
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[0.72rem] text-accent-strong">
                    {counts.create} new
                  </span>
                )}
                {(counts.update ?? 0) > 0 && (
                  <span className="rounded-full bg-amber-soft px-2.5 py-1 font-mono text-[0.72rem] text-amber">
                    {counts.update} to update
                  </span>
                )}
              </div>

              <CountChips
                counts={counts}
                noun="rows validated"
                filter={onlyBad}
                onFilter={setOnlyBad}
              />

              <div className={`${tableWrap} max-h-[26rem]`}>
                <table className="w-full min-w-[64rem] border-collapse text-[0.8rem]">
                  <thead className="sticky top-0 z-10 bg-paper-sunk">
                    <tr className={headRow}>
                      <th className="px-2.5 py-2">Row</th>
                      <th className="px-2.5 py-2">Will</th>
                      <th className="px-2.5 py-2">Activity ID</th>
                      <th className="px-2.5 py-2">WBS</th>
                      <th className="px-2.5 py-2">Activity</th>
                      <th className="px-2.5 py-2">Start</th>
                      <th className="px-2.5 py-2">Finish</th>
                      <th className="px-2.5 py-2">Logic</th>
                      <th className="px-2.5 py-2">Responsible</th>
                      <th className="px-2.5 py-2">Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((r) => (
                      <tr key={r.line} className={`border-t border-line align-top ${rowTone(r.verdict)}`}>
                        <td className="px-2.5 py-1.5 font-mono text-ink-soft">{r.line}</td>
                        <td className="px-2.5 py-1.5">
                          <span className={`rounded-full px-1.5 py-0.5 font-mono text-[0.66rem] ${ACTION_TONE[r.action]}`}>
                            {r.action}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.74rem] whitespace-nowrap text-accent-strong">
                          {r.activityId ?? "—"}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.72rem] whitespace-nowrap text-ink-soft">
                          {r.wbs ?? "—"}
                        </td>
                        <td className="max-w-[18rem] px-2.5 py-1.5">
                          <span className="block truncate text-ink" title={r.title}>
                            {r.title || <span className="text-ink-soft">—</span>}
                          </span>
                          {r.discipline && (
                            <span className="font-mono text-[0.66rem] text-ink-soft">{r.discipline}</span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.72rem] whitespace-nowrap text-ink-soft">
                          {r.plannedStart ?? "—"}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.72rem] whitespace-nowrap text-ink-soft">
                          {r.plannedFinish ?? "—"}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.7rem] text-ink-soft">
                          {r.predecessors.length || r.successors.length
                            ? `${r.predecessors.length}↤ ${r.successors.length}↦`
                            : "—"}
                        </td>
                        <td className="px-2.5 py-1.5">
                          {/* Auto-assignment is a suggestion — every row stays editable. */}
                          <select name={`override:${r.line}`} defaultValue={r.assignedTo ?? ""}
                            aria-label={`Responsible for row ${r.line}`}
                            className="w-full min-w-[9rem] rounded-md border border-line-strong bg-paper px-1.5 py-1 text-[0.74rem] text-ink outline-none focus:border-accent">
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
                        <td colSpan={10} className="px-2.5 py-6 text-center text-[0.8rem] text-ink-soft">
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
              {committing ? <><Spinner />Importing…</> : `Import ${importable} activit${importable === 1 ? "y" : "ies"}`}
            </button>
            <p className="text-[0.76rem] text-ink-soft">
              The whole file lands or none of it does. Rows marked{" "}
              <span className="text-rust">error</span> are never written.
            </p>
          </div>
        </form>
      )}
    </ImportShell>
  );
}
