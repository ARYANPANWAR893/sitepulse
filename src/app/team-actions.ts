"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { allow } from "@/lib/auth";
import { actorFor, can, scopeOf, type Actor } from "@/lib/access";
import {
  createProject, deleteProject,
  addMember, removeMember, setManager, setMemberRole,
  analyzePeopleRows, commitPeopleRows, guessPeopleMapping,
} from "@/lib/people";
import { stash, load, discard, describe, MAX_UPLOAD_BYTES } from "@/lib/staging";
import type { PeopleImportState } from "@/lib/import-types";
import { getRole } from "@/lib/roles";

export type TeamState = { error?: string; ok?: string; detail?: string[] };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

async function actor(form: FormData): Promise<{ a: Actor } | { fail: TeamState }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const projectId = str(form, "projectId");
  const a = projectId ? actorFor(projectId, user.id, user.name) : null;
  if (!a) return { fail: { error: "You don't have access to that project." } };
  return { a };
}

/** Everyone the actor may act on. Non-owners can only touch their own branch. */
const inScope = (a: Actor, personId: string) => a.isOwner || scopeOf(a).has(personId);

// ------------------------------------------------------------------ projects

export async function newProject(_prev: TeamState, form: FormData): Promise<TeamState> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!allow(`project-new:${user.id}`, 20, 60 * 60_000)) {
    return { error: "That's a lot of new projects. Try again shortly." };
  }
  const res = createProject(user.id, {
    name: str(form, "name"),
    code: str(form, "code"),
    description: str(form, "description"),
    location: str(form, "location"),
    client: str(form, "client"),
    startDate: str(form, "startDate"),
    plannedCompletion: str(form, "plannedCompletion"),
  });
  if ("error" in res) return res;
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard?project=${res.id}`);
}

export async function removeProject(form: FormData): Promise<void> {
  const user = await currentUser();
  if (!user) redirect("/login");
  // Only the account that owns a project can delete it.
  deleteProject(str(form, "projectId"), user.id);
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/settings");
}

// ------------------------------------------------------------------ people

export async function addTeamMember(_prev: TeamState, form: FormData): Promise<TeamState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "manage_people")) return { error: "Your role can't add people." };
  if (!allow(`team-add:${a.userId}`, 200, 60 * 60_000)) {
    return { error: "That's a lot of additions at once. Try again shortly." };
  }

  // "Reports to" defaults to whoever is adding — an L2 adding their crew
  // shouldn't have to pick themselves every time.
  const requested = str(form, "parentId");
  const parentId = requested || a.personId;
  if (parentId && !inScope(a, parentId)) {
    return { error: "You can only add people under yourself or someone you supervise." };
  }

  const roleId = str(form, "roleId");
  if (roleId) {
    if (!can(a, "assign_roles")) return { error: "Your role can't set someone's role." };
    if (!getRole(roleId, a.ownerId)) return { error: "That role doesn't exist." };
  }

  const res = addMember(a.ownerId, a.projectId, {
    name: str(form, "name"),
    phone: str(form, "phone") || null,
    email: str(form, "email") || null,
    role: str(form, "role") || null,
    discipline: str(form, "discipline") || null,
    parentId,
    roleId: roleId || null,
    actorPersonId: a.personId,
  });
  if ("error" in res) return res;

  revalidatePath("/dashboard", "layout");
  return { ok: `${str(form, "name").trim()} added.` };
}

/**
 * Removing someone used to fail silently when the caller lacked the standing —
 * the row simply stayed put with no explanation. Every refusal now says why.
 */
export async function removeTeamMember(_prev: TeamState, form: FormData): Promise<TeamState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  const personId = str(form, "personId");

  if (!can(a, "manage_people")) return { error: "Your role can't remove people." };
  if (personId === a.personId) return { error: "You can't remove yourself from the project." };
  if (!inScope(a, personId)) return { error: "That person is outside what you supervise." };

  const res = removeMember(a.projectId, personId, a.ownerId, a.personId);
  if ("error" in res) return res;

  revalidatePath("/dashboard", "layout");
  return {
    ok: "Removed from the project.",
    detail: res.released
      ? [`${res.released} task${res.released === 1 ? "" : "s"} they held went back to the pool — reassign from the Tasks page.`]
      : undefined,
  };
}

export async function changeManager(_prev: TeamState, form: FormData): Promise<TeamState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "manage_people")) return { error: "Your role can't change reporting lines." };

  const personId = str(form, "personId");
  const parent = str(form, "parentId");
  if (!inScope(a, personId)) return { error: "That person is outside what you supervise." };
  if (parent && !inScope(a, parent)) return { error: "That manager is outside what you supervise." };

  const res = setManager(a.projectId, personId, parent || null, a.ownerId, a.personId);
  if ("error" in res) return res;

  revalidatePath("/dashboard", "layout");
  return { ok: "Reporting line updated." };
}

/** Permission role for one person on one project. */
export async function setPersonRole(_prev: TeamState, form: FormData): Promise<TeamState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "assign_roles")) return { error: "Your role can't change roles." };

  const personId = str(form, "personId");
  if (!inScope(a, personId)) return { error: "That person is outside what you supervise." };

  const roleId = str(form, "roleId");
  if (roleId && !getRole(roleId, a.ownerId)) return { error: "That role doesn't exist." };

  setMemberRole(a.projectId, personId, roleId || null, a.personId);
  revalidatePath("/dashboard", "layout");
  return { ok: "Role updated." };
}

// ---------------------------------------------------------------- people import
//
// Same four steps as the task import: stash, pick sheet, map columns, review.
// Validation runs again on commit, from the staged original.

const PREVIEW_LIMIT = 300;

async function stagedPeople(form: FormData, a: Actor) {
  const id = str(form, "stagingId");
  return id ? load(id, a.projectId, a.userId) : null;
}

function peoplePreview(
  a: Actor, st: NonNullable<ReturnType<typeof load>>,
  sheetIndex: number, mapping: Record<number, string> | undefined
): PeopleImportState {
  const sheet = st.sheets[sheetIndex];
  const header = sheet.rows[0] ?? [];
  const map = mapping ?? guessPeopleMapping(header);
  const scope = scopeOf(a);
  const inScope = (id: string) => a.isOwner || scope.has(id);

  const { rows, counts, fatal } =
    analyzePeopleRows(a.ownerId, a.projectId, sheet.rows, a.personId, inScope, map);

  return {
    stagingId: st.id, filename: st.filename,
    sheets: describe(st), sheetIndex, header, mapping: map,
    rows: rows.slice(0, PREVIEW_LIMIT),
    shown: Math.min(rows.length, PREVIEW_LIMIT),
    counts: { ...counts, total: rows.length },
    error: fatal && !rows.length ? fatal : undefined,
    detail: fatal && rows.length ? [fatal] : undefined,
    ok: rows.length ? `${rows.length} ${rows.length === 1 ? "person" : "people"} detected in "${sheet.name}".` : undefined,
  };
}

export async function startPeopleImport(_prev: PeopleImportState, form: FormData): Promise<PeopleImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "manage_people")) return { error: "Your role can't add people." };
  if (!allow(`people-stage:${a.userId}`, 40, 60 * 60_000)) {
    return { error: "Too many uploads in a row. Wait a few minutes." };
  }

  const file = form.get("file");
  const pasted = form.get("pasted");
  let id: string;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` };
    }
    const buf = Buffer.from(await file.arrayBuffer());
    id = stash(a.projectId, a.userId, "people", file.name,
      /\.xlsx$/i.test(file.name) ? buf : buf.toString("utf8"));
  } else if (typeof pasted === "string" && pasted.trim()) {
    id = stash(a.projectId, a.userId, "people", null, pasted);
  } else {
    return { error: "Choose a .csv or .xlsx file, or paste some rows." };
  }

  const st = load(id, a.projectId, a.userId);
  if (!st || !st.sheets.length) {
    discard(id);
    return { error: st?.unreadable ?? "Nothing readable in that file." };
  }
  return peoplePreview(a, st, st.suggested, undefined);
}

export async function refinePeopleImport(_prev: PeopleImportState, form: FormData): Promise<PeopleImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;

  const st = await stagedPeople(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);
  const explicit: Record<number, string> = {};
  let sawMapping = false;
  for (const [k, v] of form.entries()) {
    const m = /^map:(\d+)$/.exec(k);
    if (m && typeof v === "string") { sawMapping = true; if (v) explicit[Number(m[1])] = v; }
  }
  return peoplePreview(a, st, sheetIndex, sawMapping ? explicit : undefined);
}

export async function confirmPeopleImport(_prev: TeamState, form: FormData): Promise<TeamState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "manage_people")) return { error: "Your role can't add people." };
  if (!allow(`people-import:${a.userId}`, 20, 60 * 60_000)) {
    return { error: "Too many imports in a row. Wait a few minutes." };
  }

  const st = await stagedPeople(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);
  const explicit: Record<number, string> = {};
  for (const [k, v] of form.entries()) {
    const m = /^map:(\d+)$/.exec(k);
    if (m && typeof v === "string" && v) explicit[Number(m[1])] = v;
  }

  const scope = scopeOf(a);
  const res = commitPeopleRows(a.ownerId, a.projectId, st.sheets[sheetIndex].rows, a.personId,
    (id) => a.isOwner || scope.has(id),
    Object.keys(explicit).length ? explicit : undefined, a.personId);
  // A failed import wrote nothing, so the upload stays parked and the user can
  // fix the file and retry against the same preview.
  if ("error" in res) return res;

  discard(st.id);
  revalidatePath("/dashboard", "layout");

  const detail: string[] = [];
  if (res.linked) detail.push(`${res.linked} reporting line${res.linked === 1 ? "" : "s"} wired from names in the file.`);
  if (res.skipped) detail.push(`${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped — nothing with an error is ever written.`);
  detail.push(...res.reasons);
  if (res.truncated) detail.push(res.truncated);

  return {
    ok: `Imported ${res.added} ${res.added === 1 ? "person" : "people"}.`,
    detail: detail.length ? detail : undefined,
  };
}
