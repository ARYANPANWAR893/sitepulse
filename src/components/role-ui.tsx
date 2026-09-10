"use client";

import { useActionState, useState } from "react";
import type { RoleState } from "@/app/role-actions";

const EMPTY: RoleState = {};
type Action = (s: RoleState, f: FormData) => Promise<RoleState>;

export type RoleCard = {
  id: string; name: string; description: string | null;
  permissions: string[]; scope: string; preset: boolean;
};

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-2.5 py-2 text-[0.88rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

function Note({ s }: { s: RoleState }) {
  if (!s.error && !s.ok) return null;
  const bad = !!s.error;
  return (
    <div role={bad ? "alert" : "status"}
      className={`rounded-md px-3 py-2 text-[0.85rem] ${bad ? "bg-rust-soft text-rust" : "bg-accent-soft text-accent-strong"}`}>
      {s.error ?? s.ok}
    </div>
  );
}

function PermissionBoxes({
  all, labels, checked,
}: { all: string[]; labels: Record<string, string>; checked: string[] }) {
  return (
    <fieldset className="grid gap-1.5 sm:grid-cols-2">
      <legend className="mb-1 font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Permissions</legend>
      {all.map((p) => (
        <label key={p} className="flex items-center gap-2 text-[0.86rem] text-ink">
          <input type="checkbox" name="permissions" value={p} defaultChecked={checked.includes(p)} />
          {labels[p] ?? p}
        </label>
      ))}
    </fieldset>
  );
}

function ScopeRadios({ scopes, labels, current }: { scopes: string[]; labels: Record<string, string>; current: string }) {
  return (
    <fieldset className="flex flex-wrap gap-4">
      <legend className="mb-1 font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">
        Assignment scope
      </legend>
      {scopes.map((s) => (
        <label key={s} className="flex items-center gap-2 text-[0.86rem] text-ink">
          <input type="radio" name="scope" value={s} defaultChecked={current === s} />
          {labels[s] ?? s}
        </label>
      ))}
    </fieldset>
  );
}

export function RoleList({
  roles, allPermissions, permissionLabels, scopes, scopeLabels,
  projectId, canManage, myRoleId, myRoleName, myScopeLabel, isOwner,
  createAction, saveAction, deleteAction,
}: {
  roles: RoleCard[]; allPermissions: string[]; permissionLabels: Record<string, string>;
  scopes: string[]; scopeLabels: Record<string, string>;
  projectId: string; canManage: boolean;
  myRoleId: string | null; myRoleName: string; myScopeLabel: string; isOwner: boolean;
  createAction: Action; saveAction: Action;
  deleteAction: (f: FormData) => void | Promise<void>;
}) {
  const [createState, runCreate, creating] = useActionState(createAction, EMPTY);
  const [saveState, runSave] = useActionState(saveAction, EMPTY);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const mine = roles.find((r) => r.id === myRoleId) ?? null;

  return (
    <div className="space-y-5">
      {/* What the viewer themselves can do, before the catalogue of roles. */}
      <section className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-accent/45 bg-accent-soft/40 px-5 py-4">
        <div>
          <p className="font-mono text-[0.64rem] tracking-[0.16em] text-ink-soft uppercase">Your role</p>
          <p className="mt-0.5 font-display text-2xl font-bold tracking-wide text-accent-strong">
            {myRoleName}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <dt className="font-mono text-[0.64rem] tracking-[0.16em] text-ink-soft uppercase">Assignment scope</dt>
            <dd className="mt-0.5 text-[0.9rem] text-ink">{myScopeLabel}</dd>
          </div>
          <div>
            <dt className="font-mono text-[0.64rem] tracking-[0.16em] text-ink-soft uppercase">Permissions</dt>
            <dd className="mt-0.5 text-[0.9rem] text-ink">
              {mine ? `${mine.permissions.length} of ${allPermissions.length}` : "—"}
            </dd>
          </div>
        </dl>
        {isOwner && (
          <p className="ml-auto max-w-[30ch] text-[0.78rem] leading-snug text-ink-soft">
            You own this project, so you always reach everyone in it.
          </p>
        )}
      </section>

      {canManage && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.84rem] text-ink-soft">
            {roles.length} roles · presets can be re-permissioned, custom roles can be removed.
          </p>
          {!adding && (
            <button onClick={() => setAdding(true)} className="btn btn-primary">
              + Create custom role
            </button>
          )}
        </div>
      )}

      <Note s={saveState} />

      <div className="grid gap-4 md:grid-cols-2">
        {roles.map((r) => {
          const isMine = r.id === myRoleId;
          return (
          <article key={r.id}
            className={`rounded-xl border bg-paper-raised p-5 transition-colors ${
              isMine ? "border-accent ring-1 ring-accent/40" : "border-line"
            }`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-xl font-bold tracking-wide">{r.name}</h3>
                {r.description && <p className="mt-1 text-[0.84rem] text-ink-soft">{r.description}</p>}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {isMine && (
                  <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[0.62rem] tracking-wide text-on-accent uppercase">
                    your role
                  </span>
                )}
                {r.preset && (
                  <span className="rounded bg-paper-sunk px-1.5 py-0.5 font-mono text-[0.62rem] tracking-wide text-ink-soft uppercase">
                    preset
                  </span>
                )}
              </div>
            </div>

            <ul className="mt-3 grid gap-0.5 sm:grid-cols-2">
              {allPermissions.map((p) => {
                const on = r.permissions.includes(p);
                return (
                  <li key={p} className={`flex items-center gap-1.5 text-[0.8rem] ${on ? "text-ink" : "text-ink-soft/60"}`}>
                    <span aria-hidden className={on ? "text-accent-strong" : ""}>{on ? "✓" : "·"}</span>
                    {permissionLabels[p] ?? p}
                  </li>
                );
              })}
            </ul>

            <p className="mt-3 font-mono text-[0.72rem] text-ink-soft">
              Assignment scope: <b className="text-accent-strong">{scopeLabels[r.scope] ?? r.scope}</b>
            </p>

            {canManage && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <button type="button" onClick={() => setEditing(editing === r.id ? null : r.id)}
                  className="btn btn-ghost">
                  {editing === r.id ? "Cancel" : "Edit permissions"}
                </button>
                {!r.preset && (
                  <form action={deleteAction}
                    onSubmit={(e) => { if (!confirm(`Delete the "${r.name}" role?`)) e.preventDefault(); }}>
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="roleId" value={r.id} />
                    <button className="btn btn-ghost text-rust hover:border-rust">Delete</button>
                  </form>
                )}
              </div>
            )}

            {editing === r.id && canManage && (
              <form action={async (fd) => { await runSave(fd); setEditing(null); }}
                className="mt-4 space-y-3 border-t border-line pt-4">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="roleId" value={r.id} />
                <label className="block">
                  <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Name</span>
                  <input name="name" defaultValue={r.name} required readOnly={r.preset}
                    className={`${inputCls} ${r.preset ? "opacity-60" : ""}`} />
                </label>
                <label className="block">
                  <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Description</span>
                  <input name="description" defaultValue={r.description ?? ""} className={inputCls} />
                </label>
                <PermissionBoxes all={allPermissions} labels={permissionLabels} checked={r.permissions} />
                <ScopeRadios scopes={scopes} labels={scopeLabels} current={r.scope} />
                <button type="submit" className="btn btn-primary">Save role</button>
                {r.preset && (
                  <p className="text-[0.74rem] text-ink-soft">
                    Preset names are fixed so existing assignments keep their meaning — permissions
                    and scope are still yours to change.
                  </p>
                )}
              </form>
            )}
          </article>
          );
        })}
      </div>

      {canManage && adding && (
        (
          <form action={runCreate} className="max-w-[40rem] space-y-3 rounded-xl border border-line bg-paper-raised p-5">
            <input type="hidden" name="projectId" value={projectId} />
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold tracking-wide">Custom role</h3>
              <button type="button" onClick={() => setAdding(false)} className="font-mono text-[0.76rem] text-ink-soft hover:text-ink">
                Close
              </button>
            </div>
            <Note s={createState} />
            <label className="block">
              <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Role name</span>
              <input name="name" required placeholder="Site Engineer" className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">Description</span>
              <input name="description" placeholder="What this role is for" className={inputCls} />
            </label>
            <PermissionBoxes all={allPermissions} labels={permissionLabels} checked={["view_tasks", "view_people"]} />
            <ScopeRadios scopes={scopes} labels={scopeLabels} current="self" />
            <button type="submit" disabled={creating} className="btn btn-primary disabled:opacity-60">
              {creating ? "Creating…" : "Create role"}
            </button>
          </form>
        )
      )}
    </div>
  );
}
