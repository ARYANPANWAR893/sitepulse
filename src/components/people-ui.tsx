"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import type { TeamState } from "@/app/team-actions";
import type { PeopleImportState } from "@/lib/import-types";
import {
  CountChips, FileDrop, ImportShell, MappingGrid, Note, SheetPicker, SourceBar, SourceTabs,
  Spinner, Verdict, headRow, rowTone, tableWrap,
} from "@/components/import-ui";

const EMPTY: TeamState = {};
type Action = (s: TeamState, f: FormData) => Promise<TeamState>;

export type RoleOption = { id: string; name: string; scope: string };

export type PersonRow = {
  id: string; name: string; phone: string | null; email: string | null;
  discipline: string | null; title: string | null;
  roleId: string | null; roleName: string;
  depth: number; reports: number; tasks: number;
  parentId: string | null; linked: boolean; isSelf: boolean;
  canManage: boolean;
};

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

const indent = (rows: PersonRow[]) =>
  rows.map((r) => (
    <option key={r.id} value={r.id}>
      {" ".repeat(r.depth * 2)}{r.name}{r.title ? ` · ${r.title}` : ""}
    </option>
  ));

function descendants(rows: PersonRow[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const r of rows) if (r.parentId === pid && !out.has(r.id)) { out.add(r.id); walk(r.id); }
  };
  walk(id);
  return out;
}

// ---------------------------------------------------------------- add

export function AddPerson({
  action, rows, roles, projectId, selfName, canSetRole,
}: {
  action: Action; rows: PersonRow[]; roles: RoleOption[];
  projectId: string; selfName: string; canSetRole: boolean;
}) {
  const [state, run, pending] = useActionState(action, EMPTY);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) ref.current?.reset(); }, [state.ok]);

  if (!open) return <button onClick={() => setOpen(true)} className="btn btn-primary">+ Add person</button>;

  const manageable = rows.filter((r) => r.canManage);

  return (
    <form ref={ref} action={run} className="w-full space-y-3 rounded-xl border border-line bg-paper-raised p-5">
      <input type="hidden" name="projectId" value={projectId} />
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold tracking-wide">Add person</h3>
        <button type="button" onClick={() => setOpen(false)} className="font-mono text-[0.76rem] text-ink-soft hover:text-ink">
          Close
        </button>
      </div>
      <Note s={state} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input name="name" required placeholder="R. Kandpal" className={inputCls} /></Field>
        <Field label="Job title"><input name="role" placeholder="Site supervisor" className={inputCls} /></Field>
        <Field label="Phone"><input name="phone" type="tel" placeholder="+919876543210" className={inputCls} /></Field>
        <Field label="Email"><input name="email" type="email" placeholder="so they can sign in" className={inputCls} /></Field>
        <Field label="Discipline"><input name="discipline" placeholder="Piping" className={inputCls} /></Field>
        <Field label="Reports to">
          <select name="parentId" defaultValue="" className={inputCls}>
            <option value="">— {selfName} (you)</option>
            {indent(manageable)}
          </select>
        </Field>
        {canSetRole && (
          <Field label="Role">
            <select name="roleId" defaultValue="" className={inputCls}>
              <option value="">— default (Contributor)</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.scope}</option>)}
            </select>
          </Field>
        )}
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
        {pending ? "Adding…" : "Add person"}
      </button>
      <p className="text-[0.74rem] leading-relaxed text-ink-soft">
        Reports-to defaults to you, so you only change it when someone sits further down.
        Give them an email and they can sign in with it — their record links to their
        account automatically once they verify that address.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------- import

/**
 * Upload → pick sheet → map columns → review → import.
 *
 * The review step is the point: duplicates, bad phone numbers, unknown managers
 * and circular reporting lines are all surfaced before anything is written.
 * Panel chrome is shared with the Tasks importer — see components/import-ui.
 */
export function ImportPeople(props: {
  startAction: (s: PeopleImportState, f: FormData) => Promise<PeopleImportState>;
  refineAction: (s: PeopleImportState, f: FormData) => Promise<PeopleImportState>;
  commitAction: Action;
  projectId: string;
  fields: readonly (readonly [string, string])[];
}) {
  const [open, setOpen] = useState(false);
  // Remounting is how "Start over" clears both useActionState hooks.
  const [attempt, setAttempt] = useState(0);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn btn-ghost">
        Import people
      </button>
    );
  }
  return (
    <ImportPeopleBody
      key={attempt}
      {...props}
      onClose={() => setOpen(false)}
      onReset={() => setAttempt((n) => n + 1)}
    />
  );
}

function ImportPeopleBody({
  startAction, refineAction, commitAction, projectId, fields, onClose, onReset,
}: {
  startAction: (s: PeopleImportState, f: FormData) => Promise<PeopleImportState>;
  refineAction: (s: PeopleImportState, f: FormData) => Promise<PeopleImportState>;
  commitAction: Action;
  projectId: string;
  fields: readonly (readonly [string, string])[];
  onClose: () => void;
  onReset: () => void;
}) {
  const [state, start, starting] = useActionState(startAction, {} as PeopleImportState);
  const [refined, refine, refining] = useActionState(refineAction, {} as PeopleImportState);
  const [commitState, commit, committing] = useActionState(commitAction, EMPTY);
  const [mode, setMode] = useState<"file" | "paste">("file");
  const [onlyBad, setOnlyBad] = useState(false);

  const view: PeopleImportState = refined.stagingId ? refined : state;
  const rows = view.rows ?? [];
  const counts = view.counts ?? {};
  const importable = (counts.valid ?? 0) + (counts.warning ?? 0);
  const shownRows = onlyBad ? rows.filter((r) => r.verdict !== "valid") : rows;

  return (
    <ImportShell title="Import people" step={view.stagingId ? 2 : 0} onClose={onClose}>
      {!view.stagingId && (
        <form action={start} className="space-y-3">
          <input type="hidden" name="projectId" value={projectId} />
          <Note s={state} />

          <SourceTabs mode={mode} onMode={setMode} />

          {mode === "file" ? (
            <FileDrop key="file" />
          ) : (
            <textarea key="paste" name="pasted" rows={5}
              placeholder={"Name,Phone,Email,Role,Reports To\nRahul Sharma,+919999999999,rahul@email.com,Manager,\nKaran Singh,+919999999998,karan@email.com,Supervisor,Rahul Sharma"}
              className={`${inputCls} font-mono text-[0.78rem]`} />
          )}

          <p className="text-[0.76rem] leading-relaxed text-ink-soft">
            Rows with no <b>Reports to</b> land under you. A manager can be someone already on
            the project, or another row in the same file.
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
            noun="people"
            onReset={onReset}
          />
          <Note s={view} />
          <Note s={commitState} />

          <SheetPicker sheets={view.sheets} current={view.sheetIndex} />
          <MappingGrid header={view.header} mapping={view.mapping} fields={fields} />

          {rows.length > 0 && (
            <>
              <CountChips counts={counts} noun="people detected" filter={onlyBad} onFilter={setOnlyBad} />

              <div className={`${tableWrap} max-h-[22rem]`}>
                <table className="w-full min-w-[42rem] border-collapse text-[0.8rem]">
                  <thead className="sticky top-0 z-10 bg-paper-sunk">
                    <tr className={headRow}>
                      <th className="px-2.5 py-2">Row</th>
                      <th className="px-2.5 py-2">Name</th>
                      <th className="px-2.5 py-2">Phone</th>
                      <th className="px-2.5 py-2">Reports to</th>
                      <th className="px-2.5 py-2">Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.map((r) => (
                      <tr key={r.line} className={`border-t border-line align-top ${rowTone(r.verdict)}`}>
                        <td className="px-2.5 py-1.5 font-mono text-ink-soft">{r.line}</td>
                        <td className="px-2.5 py-1.5 text-ink">{r.name || <span className="text-ink-soft">—</span>}</td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.74rem] text-ink-soft">{r.phone ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-ink-soft">
                          {r.reportsToName ?? <span className="italic">you</span>}
                        </td>
                        <td className="px-2.5 py-1.5">
                          <Verdict v={r.verdict} messages={r.messages} />
                        </td>
                      </tr>
                    ))}
                    {shownRows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-2.5 py-6 text-center text-[0.8rem] text-ink-soft">
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
              {committing ? <><Spinner />Importing…</> : `Import ${importable}`}
            </button>
            <p className="text-[0.76rem] text-ink-soft">
              Duplicates, unknown managers and circular reporting lines are rejected, never imported.
            </p>
          </div>
        </form>
      )}
    </ImportShell>
  );
}

// ---------------------------------------------------------------- tree

export function PeopleTree({
  rows, roles, projectId, selfName, moveAction, roleAction, removeAction, canManage, canSetRole,
}: {
  rows: PersonRow[]; roles: RoleOption[]; projectId: string; selfName: string;
  moveAction: Action; roleAction: Action;
  removeAction: Action;
  canManage: boolean; canSetRole: boolean;
}) {
  const [moveState, runMove] = useActionState(moveAction, EMPTY);
  const [roleState, runRole] = useActionState(roleAction, EMPTY);
  // Removal used to fail silently when the caller lacked the standing.
  const [removeState, runRemove] = useActionState(removeAction, EMPTY);
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const open = rows.find((r) => r.id === openId) ?? null;

  // Only computed when a panel is open — at 500 people a per-row option list
  // would be a quarter of a million nodes.
  const managerOptions = useMemo(() => {
    if (!open) return [];
    const banned = descendants(rows, open.id);
    banned.add(open.id);
    return rows.filter((r) => !banned.has(r.id) && r.canManage);
  }, [open, rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      (r.title ?? "").toLowerCase().includes(q) ||
      (r.discipline ?? "").toLowerCase().includes(q));
  }, [rows, query]);

  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
        <p className="font-display text-lg font-bold">No one on this project yet.</p>
        <p className="mt-1 text-[0.86rem] text-ink-soft">Add your first reportee, or import a list.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people…" aria-label="Search people"
        className={`${inputCls} max-w-[20rem]`} />

      <Note s={moveState} />
      <Note s={roleState} />
      <Note s={removeState} />

      <ul className="overflow-hidden rounded-xl border border-line">
        <li className="bg-paper-sunk px-3 py-2 font-mono text-[0.72rem] tracking-wider text-ink-soft uppercase">
          {selfName} · top of this project
        </li>

        {shown.map((p) => (
          <li key={p.id} className="border-t border-line bg-paper-raised">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5"
              style={{ paddingLeft: `${0.75 + (query ? 0 : p.depth) * 1.35}rem` }}>
              {!query && p.depth > 0 && (
                <span aria-hidden className="font-mono text-[0.7rem] text-ink-soft select-none">└</span>
              )}
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.92rem] font-semibold text-ink">{p.name}</span>
                  {p.title && <span className="font-mono text-[0.72rem] text-ink-soft">{p.title}</span>}
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[0.64rem] text-accent-strong">
                    {p.roleName}
                  </span>
                  {p.linked && (
                    <span className="font-mono text-[0.64rem] text-ink-soft" title="Has signed in">● account</span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[0.72rem] text-ink-soft">
                  <span>depth {p.depth}</span>
                  <span>{p.reports} report{p.reports === 1 ? "" : "s"}</span>
                  <span>{p.tasks} task{p.tasks === 1 ? "" : "s"}</span>
                  {p.discipline && <span>{p.discipline}</span>}
                </div>
              </div>

              <button type="button" onClick={() => setOpenId(openId === p.id ? null : p.id)}
                aria-expanded={openId === p.id}
                className="min-h-[32px] rounded-md px-2 font-mono text-[0.74rem] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent-strong">
                {openId === p.id ? "Close" : "Details"}
              </button>
            </div>

            {openId === p.id && (
              <div className="space-y-4 border-t border-line bg-paper px-4 py-4">
                <dl className="grid gap-x-8 gap-y-1.5 text-[0.84rem] sm:grid-cols-2">
                  {[
                    ["Name", p.name], ["Job title", p.title ?? "—"],
                    ["Role", p.roleName], ["Hierarchy depth", String(p.depth)],
                    ["Phone", p.phone ?? "—"], ["Email", p.email ?? "—"],
                    ["Direct reports", String(p.reports)], ["Assigned tasks", String(p.tasks)],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-line pb-1">
                      <dt className="text-ink-soft">{k}</dt>
                      <dd className="truncate text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>

                {!p.canManage && (
                  <p className="text-[0.78rem] text-ink-soft">
                    This person is outside what you supervise, so you can view them but not change them.
                  </p>
                )}

                {p.canManage && canSetRole && (
                  <form action={runRole} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="personId" value={p.id} />
                    <Field label="Change role">
                      <select name="roleId" defaultValue={p.roleId ?? ""} className={`${inputCls} min-w-[14rem]`}>
                        <option value="">— default (Contributor)</option>
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.scope}</option>)}
                      </select>
                    </Field>
                    <button type="submit" className="btn btn-ghost">Save role</button>
                  </form>
                )}

                {p.canManage && canManage && (
                  <form action={async (fd) => { await runMove(fd); setOpenId(null); }}
                    className="flex flex-wrap items-end gap-2 border-t border-line pt-4">
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="personId" value={p.id} />
                    <Field label="Reports to">
                      <select name="parentId" defaultValue={p.parentId ?? ""} className={`${inputCls} min-w-[16rem]`}>
                        <option value="">— {selfName} (top level)</option>
                        {indent(managerOptions)}
                      </select>
                    </Field>
                    <button type="submit" className="btn btn-ghost">Move</button>
                    <p className="w-full text-[0.74rem] text-ink-soft">
                      Anyone reporting to {p.name} is left out — moving them under their own report
                      would make a loop.
                    </p>
                  </form>
                )}

                {p.canManage && canManage && !p.isSelf && (
                  <form action={runRemove} className="border-t border-line pt-4"
                    onSubmit={(e) => {
                      const msg = p.reports > 0
                        ? `Remove ${p.name} from this project? Their ${p.reports} report${p.reports === 1 ? "" : "s"} move up a level.`
                        : `Remove ${p.name} from this project?`;
                      if (!confirm(msg)) e.preventDefault();
                    }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="personId" value={p.id} />
                    <button className="font-mono text-[0.76rem] text-ink-soft transition-colors hover:text-rust">
                      Remove from project
                    </button>
                  </form>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
