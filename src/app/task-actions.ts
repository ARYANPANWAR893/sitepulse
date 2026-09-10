"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { allow } from "@/lib/auth";
import { actorFor, can, type Actor } from "@/lib/access";
import {
  createTask, updateTask, assignTask, deleteTask, delegateTask, getTask,
  analyzeRows, commitRows, guessMapping,
  type ColumnMap, type AnalyzedRow,
} from "@/lib/tasks";
import { canAssignTo } from "@/lib/access";
import { stash, load, discard, describe, MAX_UPLOAD_BYTES } from "@/lib/staging";
import type { ImportState } from "@/lib/import-types";

export type TaskState = { error?: string; ok?: string; detail?: string[] };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/**
 * The one place a request becomes an authorised actor. Nothing downstream reads
 * a role, a scope or a person id from the form — it all resolves from the
 * session plus the database.
 */
async function actor(form: FormData): Promise<{ a: Actor } | { fail: TaskState }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const projectId = str(form, "projectId");
  const a = projectId ? actorFor(projectId, user.id, user.name) : null;
  if (!a) return { fail: { error: "You don't have access to that project." } };
  return { a };
}

export async function newTask(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`task-new:${r.a.userId}`, 300, 60 * 60_000)) {
    return { error: "Too many tasks created at once. Try again shortly." };
  }

  const res = createTask(r.a, {
    title: str(form, "title"),
    description: str(form, "description"),
    status: str(form, "status"),
    priority: str(form, "priority"),
    progress: str(form, "progress"),
    startDate: str(form, "startDate"),
    dueDate: str(form, "dueDate"),
    assignedTo: str(form, "assignedTo"),
  });
  if ("error" in res) return res;

  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: "Task created." };
}

export async function editTask(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  // Edits were the one mutation with no ceiling on it.
  if (!allow(`task-edit:${r.a.userId}`, 600, 60 * 60_000)) {
    return { error: "Too many edits at once. Try again shortly." };
  }

  const res = updateTask(r.a, str(form, "taskId"), {
    title: str(form, "title"),
    description: str(form, "description"),
    status: str(form, "status"),
    priority: str(form, "priority"),
    progress: form.has("progress") ? str(form, "progress") : undefined,
    startDate: str(form, "startDate"),
    dueDate: str(form, "dueDate"),
  });
  if ("error" in res) return res;

  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: "Task updated." };
}

export async function reassignTask(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;

  const target = str(form, "assignedTo");
  const res = assignTask(r.a, str(form, "taskId"), target || null);
  if ("error" in res) return res;

  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: target ? "Reassigned." : "Assignment cleared." };
}

/**
 * Hand your own task down the tree. Separate from reassignment: you must hold
 * the task, and the chain is appended to rather than rewritten.
 */
export async function delegate(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;

  const to = str(form, "assignedTo");
  if (!to) return { error: "Choose someone to delegate to." };

  const res = delegateTask(r.a, str(form, "taskId"), to);
  if ("error" in res) return res;

  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: "Delegated." };
}

/**
 * Quick status/progress change from the list — same edit scope as a full edit.
 *
 * Returns state rather than void: this used to swallow every refusal, so a
 * contributor nudging someone else's task saw the control snap back with no
 * explanation and no record that anything had been attempted.
 */
export async function setTaskStatus(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const taskId = str(form, "taskId");
  const existing = getTask(taskId, r.a.projectId);
  if (!existing) return { error: "That task isn't in this project." };

  const res = updateTask(r.a, taskId, {
    title: existing.title, description: existing.description,
    status: form.has("status") ? str(form, "status") : existing.status,
    priority: existing.priority,
    progress: form.has("progress") ? str(form, "progress") : undefined,
    startDate: existing.start_date, dueDate: existing.due_date,
  });
  if ("error" in res) return res;

  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: "Updated." };
}

export async function removeTask(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const res = deleteTask(r.a, str(form, "taskId"));
  if ("error" in res) return res;
  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
  return { ok: "Task deleted." };
}

// ---------------------------------------------------------------- import
//
// Four steps, all server-side: stash the file, pick a sheet, map the columns,
// review and commit. Every step re-reads the staged original and re-runs the
// same validator, so the preview is a convenience rather than a source of truth.


const PREVIEW_LIMIT = 300;

/** Reads `override:<line>` fields from the preview table. */
function readOverrides(form: FormData): Record<number, string | null> {
  const out: Record<number, string | null> = {};
  for (const [k, v] of form.entries()) {
    const m = /^override:(\d+)$/.exec(k);
    if (m && typeof v === "string") out[Number(m[1])] = v || null;
  }
  return out;
}

async function staged(form: FormData, a: Actor) {
  const id = str(form, "stagingId");
  return id ? load(id, a.projectId, a.userId) : null;
}

function analyse(a: Actor, sheet: string[][], mapping: ColumnMap, overrides: Record<number, string | null>) {
  const { rows, counts, fatal } = analyzeRows(a, sheet, mapping);
  for (const r of rows) {
    if (!(r.line in overrides)) continue;
    const to = overrides[r.line];
    if (to && !canAssignTo(a, to)) {
      r.verdict = "error";
      r.messages = ["You can't assign work to that person."];
    } else {
      r.assignedTo = to;
      r.assignedToName = to ? (a.members.find((m) => m.id === to)?.name ?? null) : null;
      if (r.verdict === "error" && r.messages.every((m) => /assign/i.test(m))) {
        r.verdict = "valid";
        r.messages = [];
      }
    }
  }
  const fresh = { valid: 0, warning: 0, error: 0 } as Record<string, number>;
  for (const r of rows) fresh[r.verdict]++;
  return { rows, counts: fresh, fatal, ignored: counts };
}

/** Step 1 — take the upload, park it, and show what we found. */
export async function startImport(_prev: ImportState, form: FormData): Promise<ImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "create_tasks")) return { error: "Your role can't create tasks." };
  if (!allow(`task-stage:${a.userId}`, 40, 60 * 60_000)) {
    return { error: "Too many uploads in a row. Wait a few minutes." };
  }

  const file = form.get("file");
  const pasted = form.get("pasted");
  let id: string;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB.` };
    }
    const isXlsx = /\.xlsx$/i.test(file.name);
    const buf = Buffer.from(await file.arrayBuffer());
    try {
      id = stash(a.projectId, a.userId, "tasks", file.name, isXlsx ? buf : buf.toString("utf8"));
    } catch {
      return { error: "That file couldn't be read." };
    }
  } else if (typeof pasted === "string" && pasted.trim()) {
    id = stash(a.projectId, a.userId, "tasks", null, pasted);
  } else {
    return { error: "Choose a .csv or .xlsx file, or paste some rows." };
  }

  const st = load(id, a.projectId, a.userId);
  if (!st || !st.sheets.length) {
    discard(id);
    return { error: st?.unreadable ?? "Nothing readable in that file." };
  }

  return buildPreview(a, st, st.suggested, undefined, {});
}

/** Steps 2 and 3 — a different sheet, a corrected mapping, or a changed assignee. */
export async function refineImport(_prev: ImportState, form: FormData): Promise<ImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;

  const st = await staged(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };
  if (!st.sheets.length) return { error: st.unreadable ?? "That file couldn't be read." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);

  // A mapping arrives as map:<columnIndex> = field.
  let mapping: ColumnMap | undefined;
  const explicit: ColumnMap = {};
  let sawMapping = false;
  for (const [k, v] of form.entries()) {
    const m = /^map:(\d+)$/.exec(k);
    if (m && typeof v === "string") { sawMapping = true; if (v) explicit[Number(m[1])] = v; }
  }
  if (sawMapping) mapping = explicit;

  return buildPreview(a, st, sheetIndex, mapping, readOverrides(form));
}

function buildPreview(
  a: Actor, st: NonNullable<ReturnType<typeof load>>,
  sheetIndex: number, mapping: ColumnMap | undefined, overrides: Record<number, string | null>
): ImportState {
  const sheet = st.sheets[sheetIndex];
  const header = sheet.rows[0] ?? [];
  const map = mapping ?? guessMapping(header);
  const { rows, counts, fatal } = analyse(a, sheet.rows, map, overrides);

  return {
    stagingId: st.id,
    filename: st.filename,
    sheets: describe(st),
    sheetIndex,
    header,
    mapping: map,
    rows: rows.slice(0, PREVIEW_LIMIT),
    shown: Math.min(rows.length, PREVIEW_LIMIT),
    counts: { ...counts, total: rows.length },
    error: fatal && !rows.length ? fatal : undefined,
    detail: fatal && rows.length ? [fatal] : undefined,
    ok: rows.length ? `${rows.length} task${rows.length === 1 ? "" : "s"} detected in "${sheet.name}".` : undefined,
  };
}

/** Step 4 — commit. Re-parses and re-authorises from the staged original. */
export async function confirmImport(_prev: TaskState, form: FormData): Promise<TaskState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!allow(`task-import:${a.userId}`, 20, 60 * 60_000)) {
    return { error: "Too many imports in a row. Wait a few minutes." };
  }

  const st = await staged(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };
  if (!st.sheets.length) return { error: st.unreadable ?? "That file couldn't be read." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);
  const explicit: ColumnMap = {};
  for (const [k, v] of form.entries()) {
    const m = /^map:(\d+)$/.exec(k);
    if (m && typeof v === "string" && v) explicit[Number(m[1])] = v;
  }

  const res = commitRows(a, st.sheets[sheetIndex].rows,
    Object.keys(explicit).length ? explicit : undefined, readOverrides(form));
  if ("error" in res) return res;

  discard(st.id);
  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");

  // Say what actually happened to the rows, not just how many landed. An import
  // that assigns nothing looks identical to a successful one otherwise.
  const detail: string[] = [];
  if (res.added) {
    detail.push(res.assigned
      ? `${res.assigned} auto-assigned from the file; ${res.unassigned} left unassigned.`
      : `None could be auto-assigned — assign them from the Tasks list.`);
  }
  if (res.skipped) detail.push(`${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped — nothing with an error is ever written.`);
  detail.push(...res.reasons);
  if (res.truncated) detail.push(res.truncated);

  return {
    ok: `Imported ${res.added} task${res.added === 1 ? "" : "s"}.`,
    detail: detail.length ? detail : undefined,
  };
}
