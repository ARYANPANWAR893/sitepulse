"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { allow } from "@/lib/auth";
import { actorFor, can, canAssignTo, type Actor } from "@/lib/access";
import {
  createActivity, updateActivity, analyzeSchedule, commitSchedule,
  guessScheduleMapping, linkActivities, unlinkActivities,
  recordProgressEvent, decideProgressEvent, attachEvidence,
  type ColumnMap, type RelationType,
} from "@/lib/schedule";
import { stash, load, discard, describe, MAX_UPLOAD_BYTES } from "@/lib/staging";
import type { ScheduleImportState } from "@/lib/import-types";

export type ScheduleState = { error?: string; ok?: string; detail?: string[] };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/** The one place a request becomes an authorised actor. Nothing downstream
 *  reads a role, a scope or a person id from the form. */
async function actor(form: FormData): Promise<{ a: Actor } | { fail: ScheduleState }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const projectId = str(form, "projectId");
  const a = projectId ? actorFor(projectId, user.id, user.name) : null;
  if (!a) return { fail: { error: "You don't have access to that project." } };
  return { a };
}

const refresh = () => {
  revalidatePath("/dashboard/schedule");
  revalidatePath("/dashboard/tasks");
  revalidatePath("/dashboard");
};

// ---------------------------------------------------------------- activities

export async function newActivity(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`activity-new:${r.a.userId}`, 300, 60 * 60_000)) {
    return { error: "Too many activities created at once. Try again shortly." };
  }

  const res = createActivity(r.a, {
    title: str(form, "title"),
    description: str(form, "description"),
    wbs: str(form, "wbs"),
    wbsPath: str(form, "wbsPath"),
    discipline: str(form, "discipline"),
    location: str(form, "location"),
    plannedStart: str(form, "plannedStart"),
    plannedFinish: str(form, "plannedFinish"),
    plannedDuration: str(form, "plannedDuration"),
    status: str(form, "status"),
    assignedTo: str(form, "assignedTo"),
  });
  if ("error" in res) return res;

  refresh();
  return { ok: "Activity added to the schedule." };
}

export async function editActivity(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`activity-edit:${r.a.userId}`, 600, 60 * 60_000)) {
    return { error: "Too many edits at once. Try again shortly." };
  }

  // Only the fields actually present are passed through, so a partial form
  // never blanks a column it didn't render.
  const patch: Record<string, unknown> = {};
  for (const key of [
    "title", "description", "wbs", "wbsPath", "discipline", "location",
    "plannedStart", "plannedFinish", "baselineStart", "baselineFinish",
    "actualStart", "actualFinish", "plannedDuration", "progress", "status", "notes",
  ]) {
    if (form.has(key)) patch[key] = str(form, key);
  }

  const res = updateActivity(r.a, str(form, "activityId"), patch);
  if ("error" in res) return res;

  refresh();
  return { ok: "Activity updated." };
}

// ---------------------------------------------------------------- logic links

export async function linkActivity(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!can(r.a, "edit_tasks")) return { error: "Your role can't change schedule logic." };

  const from = str(form, "predecessorId");
  const to = str(form, "successorId");
  if (!from || !to) return { error: "Choose both activities." };

  const type = str(form, "type") as RelationType;
  const res = linkActivities(r.a.projectId, from, to,
    (["FS", "SS", "FF", "SF"] as const).includes(type) ? type : "FS",
    Number(str(form, "lagDays")) || 0);
  if ("error" in res) return res;

  refresh();
  return { ok: "Dependency added." };
}

export async function unlinkActivity(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!can(r.a, "edit_tasks")) return { error: "Your role can't change schedule logic." };
  if (!unlinkActivities(str(form, "relationId"), r.a.projectId)) {
    return { error: "That dependency is no longer there." };
  }
  refresh();
  return { ok: "Dependency removed." };
}

// ---------------------------------------------------------------- field reports

export async function reportProgress(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  if (!allow(`progress-report:${r.a.userId}`, 400, 60 * 60_000)) {
    return { error: "Too many reports at once. Try again shortly." };
  }

  const progress = str(form, "progress");
  const res = recordProgressEvent(r.a, {
    activityId: str(form, "activityId") || null,
    source: "manual",
    rawText: str(form, "rawText") || null,
    progress: progress === "" ? null : Number(progress),
    status: str(form, "status") || null,
    actualStart: str(form, "actualStart") || null,
    actualFinish: str(form, "actualFinish") || null,
  });
  if ("error" in res) return res;

  refresh();
  return {
    ok: "Report logged for review.",
    detail: ["The activity hasn't moved yet — a report is a claim until someone accepts it."],
  };
}

export async function reviewProgress(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;

  const decision = str(form, "decision");
  if (decision !== "accepted" && decision !== "rejected") return { error: "Choose accept or reject." };

  const res = decideProgressEvent(r.a, str(form, "eventId"), decision, str(form, "note") || undefined);
  if ("error" in res) return res;

  refresh();
  return { ok: decision === "accepted" ? "Accepted and applied to the activity." : "Rejected. The activity is unchanged." };
}

export async function addEvidence(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const kind = str(form, "kind");
  if (!["photo", "document", "message", "link"].includes(kind)) return { error: "Pick a kind of evidence." };

  const res = attachEvidence(r.a, {
    activityId: str(form, "activityId") || null,
    progressEventId: str(form, "eventId") || null,
    kind: kind as "photo" | "document" | "message" | "link",
    uri: str(form, "uri") || null,
    caption: str(form, "caption") || null,
  });
  if ("error" in res) return res;

  refresh();
  return { ok: "Evidence attached." };
}

// ---------------------------------------------------------------- import
//
// Four steps, all server-side: stash the file, pick a sheet, map the columns,
// review and commit. Every step re-reads the staged original and re-runs the
// same validator, so the preview is a convenience rather than a source of truth.

const PREVIEW_LIMIT = 300;

function readOverrides(form: FormData): Record<number, string | null> {
  const out: Record<number, string | null> = {};
  for (const [k, v] of form.entries()) {
    const m = /^override:(\d+)$/.exec(k);
    if (m && typeof v === "string") out[Number(m[1])] = v || null;
  }
  return out;
}

function readMapping(form: FormData): ColumnMap | undefined {
  const explicit: ColumnMap = {};
  let saw = false;
  for (const [k, v] of form.entries()) {
    const m = /^map:(\d+)$/.exec(k);
    if (m && typeof v === "string") { saw = true; if (v) explicit[Number(m[1])] = v; }
  }
  return saw ? explicit : undefined;
}

const readMode = (form: FormData) => (str(form, "mode") === "update" ? "update" : "create");

async function staged(form: FormData, a: Actor) {
  const id = str(form, "stagingId");
  return id ? load(id, a.projectId, a.userId) : null;
}

function buildPreview(
  a: Actor, st: NonNullable<ReturnType<typeof load>>,
  sheetIndex: number, mapping: ColumnMap | undefined,
  mode: "create" | "update", overrides: Record<number, string | null>
): ScheduleImportState {
  const sheet = st.sheets[sheetIndex];
  const header = sheet.rows[0] ?? [];
  const map = mapping ?? guessScheduleMapping(header);
  const { rows, counts, mappedColumns, fatal } = analyzeSchedule(a, sheet.rows, map, mode, overrides);

  return {
    stagingId: st.id,
    filename: st.filename,
    sheets: describe(st),
    sheetIndex,
    header,
    mapping: map,
    mode,
    mappedColumns,
    rows: rows.slice(0, PREVIEW_LIMIT),
    shown: Math.min(rows.length, PREVIEW_LIMIT),
    counts: { ...counts, total: rows.length, columns: header.length },
    error: fatal && !rows.length ? fatal : undefined,
    detail: fatal && rows.length ? [fatal] : undefined,
    ok: rows.length
      ? `${rows.length} activit${rows.length === 1 ? "y" : "ies"} read from "${sheet.name}" · ${mappedColumns} of ${header.length} columns mapped.`
      : undefined,
  };
}

export async function startScheduleImport(_prev: ScheduleImportState, form: FormData): Promise<ScheduleImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!can(a, "create_tasks")) return { error: "Your role can't import a schedule." };
  if (!allow(`schedule-stage:${a.userId}`, 40, 60 * 60_000)) {
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
    return { error: "Choose a .csv or .xlsx schedule export, or paste some rows." };
  }

  const st = load(id, a.projectId, a.userId);
  if (!st || !st.sheets.length) {
    discard(id);
    return { error: st?.unreadable ?? "Nothing readable in that file." };
  }

  return buildPreview(a, st, st.suggested, undefined, readMode(form), {});
}

export async function refineScheduleImport(_prev: ScheduleImportState, form: FormData): Promise<ScheduleImportState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;

  const st = await staged(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };
  if (!st.sheets.length) return { error: st.unreadable ?? "That file couldn't be read." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);
  return buildPreview(a, st, sheetIndex, readMapping(form), readMode(form), readOverrides(form));
}

export async function confirmScheduleImport(_prev: ScheduleState, form: FormData): Promise<ScheduleState> {
  const r = await actor(form);
  if ("fail" in r) return r.fail;
  const a = r.a;
  if (!allow(`schedule-import:${a.userId}`, 20, 60 * 60_000)) {
    return { error: "Too many imports in a row. Wait a few minutes." };
  }

  const st = await staged(form, a);
  if (!st) return { error: "That upload expired. Please choose the file again." };
  if (!st.sheets.length) return { error: st.unreadable ?? "That file couldn't be read." };

  const sheetIndex = Math.min(Math.max(0, Number(str(form, "sheetIndex")) || 0), st.sheets.length - 1);
  const sheet = st.sheets[sheetIndex];

  const res = commitSchedule(a, sheet.rows, {
    mapping: readMapping(form),
    mode: readMode(form),
    overrides: readOverrides(form),
    filename: st.filename,
    sheetName: sheet.name,
  });
  // A failed import wrote nothing, so the upload stays parked and the user can
  // fix the file and retry against the same preview.
  if ("error" in res) return res;

  discard(st.id);
  refresh();

  const detail: string[] = [];
  if (res.updated) detail.push(`${res.updated} existing activit${res.updated === 1 ? "y was" : "ies were"} refreshed in place.`);
  if (res.relationsMade) detail.push(`${res.relationsMade} logic link${res.relationsMade === 1 ? "" : "s"} created.`);
  if (res.assigned) detail.push(`${res.assigned} auto-assigned from the file — every one stays editable.`);
  if (res.unresolvedRefs.length) {
    detail.push(`Predecessors naming activities not in this schedule: ${res.unresolvedRefs.join(", ")}.`);
  }
  if (res.skipped) detail.push(`${res.skipped} row${res.skipped === 1 ? "" : "s"} skipped — nothing with an error is ever written.`);
  detail.push(...res.reasons);
  if (res.truncated) detail.push(res.truncated);

  return {
    ok: `Imported ${res.created} new activit${res.created === 1 ? "y" : "ies"}.`,
    detail: detail.length ? detail : undefined,
  };
}
