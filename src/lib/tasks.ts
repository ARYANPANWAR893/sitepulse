import "server-only";
import { randomBytes } from "node:crypto";
import { db, now, tx } from "./db.ts";
import { parseCsv, type Member } from "./people.ts";
import { serialToDate } from "./xlsx.ts";
import type { PreviewRow, RowVerdict } from "./import-types.ts";
import { canAssignTo, canEditTask, can, scopeOf, type Actor } from "./access.ts";

export const STATUSES = ["not_started", "in_progress", "completed"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export const STATUS_LABELS: Record<Status, string> = {
  not_started: "Not started", in_progress: "In progress", completed: "Completed",
};
export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low", medium: "Medium", high: "High",
};

export const MAX_TASKS = 5000;
export const MAX_IMPORT_ROWS = 1000;

export type Task = {
  id: string; project_id: string;
  ref: string | null;                     // the file's own id, or a generated one
  title: string; description: string | null;
  status: Status; priority: Priority;
  progress: number;                       // 0-100
  start_date: string | null; due_date: string | null;
  assigned_to: string | null; assigned_by: string | null; created_by: string | null;
  created_at: number; updated_at: number;
};

/**
 * Every kind of project mutation worth a line in the audit feed.
 *
 * Listed rather than free-text so a new call site can't quietly invent a kind
 * the dashboard then fails to render — and so this file is the single answer to
 * "what do we record?".
 */
export const EVENT_KINDS = [
  "created", "updated", "deleted", "imported",
  "assigned", "reassigned", "unassigned", "delegated",
  "status_changed", "progress_changed",
  "person_added", "person_moved", "person_removed", "role_changed",
  "activity_updated", "schedule_imported", "progress_reported",
  "evidence_added", "review_decided",
  "match_proposed", "match_auto_linked", "match_decided",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const newId = () => randomBytes(12).toString("hex");

const q = {
  insert: db.prepare(`INSERT INTO tasks
    (id, project_id, title, description, status, priority, progress, start_date, due_date, assigned_to, assigned_by, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byProject: db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC"),
  one: db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?"),
  count: db.prepare("SELECT count(*) c FROM tasks WHERE project_id = ?"),
  update: db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?,
    progress = ?, start_date = ?, due_date = ?, updated_at = ? WHERE id = ? AND project_id = ?`),
  assign: db.prepare("UPDATE tasks SET assigned_to = ?, assigned_by = ?, updated_at = ? WHERE id = ? AND project_id = ?"),
  del: db.prepare("DELETE FROM tasks WHERE id = ? AND project_id = ?"),
  event: db.prepare("INSERT INTO task_events (project_id, task_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)"),
  setRef: db.prepare("UPDATE tasks SET ref = ? WHERE id = ?"),
  // Monotonic — never derived from count(*), which reuses a number after a delete.
  nextSeq: db.prepare("UPDATE projects SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq"),
  refTaken: db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND ref = ?"),
  addAssignment: db.prepare(`INSERT INTO task_assignments
    (id, task_id, assigned_to, assigned_by, parent_assignment_id, assignment_type, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  history: db.prepare("SELECT * FROM task_assignments WHERE task_id = ? ORDER BY created_at, rowid"),
  head: db.prepare("SELECT * FROM task_assignments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
  allAssignments: db.prepare(`SELECT ta.* FROM task_assignments ta
    JOIN tasks t ON t.id = ta.task_id
    WHERE t.project_id = ? ORDER BY ta.created_at, ta.rowid`),
  delegatedTo: db.prepare(`SELECT DISTINCT task_id FROM task_assignments
    WHERE assigned_to = ? AND assignment_type = 'delegated'`),
  delegatedBy: db.prepare(`SELECT DISTINCT task_id FROM task_assignments
    WHERE assigned_by = ? AND assignment_type = 'delegated'`),
  events: db.prepare("SELECT * FROM task_events WHERE project_id = ? ORDER BY at DESC, id DESC LIMIT ?"),
  byAssignee: db.prepare("SELECT assigned_to, count(*) c FROM tasks WHERE project_id = ? AND assigned_to IS NOT NULL GROUP BY assigned_to"),
};

export const listTasks = (projectId: string) => q.byProject.all(projectId) as Task[];
export const getTask = (id: string, projectId: string) =>
  (q.one.get(id, projectId) as Task | undefined) ?? null;
export const countTasks = (projectId: string) => (q.count.get(projectId) as { c: number }).c;

/** Task count per assignee, for the People page. One query, not one per person. */
export function taskCountsByPerson(projectId: string): Map<string, number> {
  const rows = q.byAssignee.all(projectId) as { assigned_to: string; c: number }[];
  return new Map(rows.map((r) => [r.assigned_to, r.c]));
}

/** What kind of move this was. */
export type AssignmentType = "initial" | "delegated" | "reassigned" | "unassigned";

/**
 * Where the decision came from — orthogonal to the type above.
 *
 * `auto` is the one that matters: it marks an assignee the importer worked out
 * from a name in the file rather than one a human chose, so "which of these did
 * the system decide?" is answerable after the fact. Every one of them stays
 * editable; this only records provenance.
 */
export type AssignmentSource = "manual" | "auto" | "import" | "delegation";

export type Assignment = {
  id: string; task_id: string;
  assigned_to: string | null; assigned_by: string | null;
  parent_assignment_id: string | null;
  assignment_type: AssignmentType;
  source: AssignmentSource | null;        // null on rows written before this column
  created_at: number;
};

/** The full chain, oldest first. This is what the task detail renders. */
export const assignmentHistory = (taskId: string) =>
  q.history.all(taskId) as Assignment[];

/** Every chain in the project, grouped by task — one query, not one per row. */
export function assignmentsByTask(projectId: string): Map<string, Assignment[]> {
  const out = new Map<string, Assignment[]>();
  for (const r of q.allAssignments.all(projectId) as Assignment[]) {
    const list = out.get(r.task_id);
    if (list) list.push(r); else out.set(r.task_id, [r]);
  }
  return out;
}

export const currentAssignment = (taskId: string) =>
  (q.head.get(taskId) as Assignment | undefined) ?? null;

export const taskIdsDelegatedTo = (personId: string) =>
  new Set((q.delegatedTo.all(personId) as { task_id: string }[]).map((r) => r.task_id));
export const taskIdsDelegatedBy = (personId: string) =>
  new Set((q.delegatedBy.all(personId) as { task_id: string }[]).map((r) => r.task_id));

/**
 * Appends to the chain instead of replacing it. `parent_assignment_id` points at
 * whatever was current, so "Amit → Rahul" is still readable after Rahul hands
 * the task to Karan.
 *
 * Nothing in this module ever UPDATEs or DELETEs a row in `task_assignments` —
 * the table is append-only by construction, which is what makes the chain a
 * history rather than a cache of the current state.
 */
function recordAssignment(
  taskId: string, to: string | null, by: string | null,
  type: AssignmentType, source: AssignmentSource
): void {
  const parent = currentAssignment(taskId);
  q.addAssignment.run(newId(), taskId, to, by, parent?.id ?? null, type, source, now());
}

/**
 * The chain flattened into the questions the UI actually asks of it.
 *
 * `original` is the first person the task ever landed on, which survives any
 * number of later moves — that is the whole reason the table appends.
 */
export type AssignmentSummary = {
  original: string | null;          // first assignee, ever
  current: string | null;           // who holds it now
  assignedBy: string | null;        // who made the move that put it there
  source: AssignmentSource | null;  // how that move was decided
  delegations: number;              // hand-offs down the tree
  changes: number;                  // total moves recorded
  chain: Assignment[];              // oldest first
};

export function assignmentSummary(taskId: string): AssignmentSummary {
  const chain = assignmentHistory(taskId);
  const first = chain.find((r) => r.assigned_to);
  const head = chain[chain.length - 1] ?? null;
  return {
    original: first?.assigned_to ?? null,
    current: head?.assigned_to ?? null,
    assignedBy: head?.assigned_by ?? null,
    source: head?.source ?? null,
    delegations: chain.filter((r) => r.assignment_type === "delegated").length,
    changes: chain.length,
    chain,
  };
}

/**
 * Human-readable id: project code (or initials) plus a monotonic sequence.
 *
 * Collisions are still possible when a file supplies its own refs, so the
 * counter advances until the ref is free rather than trusting the number.
 */
function makeRef(projectId: string, projectCode: string | null, nextSeq: () => number): string {
  const stem = (projectCode ?? "TSK").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TSK";
  for (let tries = 0; tries < 1000; tries++) {
    const ref = `${stem}-${String(nextSeq()).padStart(3, "0")}`;
    if (!q.refTaken.get(projectId, ref)) return ref;
  }
  // ponytail: 1000 collisions means the file is fighting us; fall back to a
  // guaranteed-unique suffix rather than looping forever.
  return `${stem}-${newId().slice(0, 8)}`;
}

/** Bumps and returns the project's task counter. */
const bumpSeq = (projectId: string) =>
  (q.nextSeq.get(projectId) as { task_seq: number }).task_seq;

export type TaskEvent = {
  id: number; project_id: string; task_id: string | null;
  kind: string; actor: string | null; detail: string | null; at: number;
};
export const recentEvents = (projectId: string, limit = 12) =>
  q.events.all(projectId, limit) as TaskEvent[];

const logEvent = (a: Actor, taskId: string | null, kind: EventKind, detail: string) =>
  q.event.run(a.projectId, taskId, kind, a.personId, detail, now());

// ---------------------------------------------------------------- validation

const clean = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** Accepts YYYY-MM-DD and the common DD/MM/YYYY and DD-MM-YYYY spreadsheet forms. */
export function cleanDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();

  let y: string, mo: string, d: string;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);

  if (iso) [, y, mo, d] = iso;
  // Day-first, because that is what an Indian site spreadsheet exports.
  else if (dmy) { y = dmy[3]; mo = dmy[2]; d = dmy[1]; }
  else return null;

  mo = mo.padStart(2, "0");
  d = d.padStart(2, "0");
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  // Round-trip check rejects 31/02 and friends, which Date would roll over.
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}

/** A spreadsheet cell may be ISO text, day-first text, or an Excel serial. */
export function readDate(v: string): string | null {
  const iso = cleanDate(v);
  if (iso) return iso;
  const n = Number(v.trim());
  return Number.isFinite(n) && n > 20000 ? serialToDate(n) : null;
}

const asStatus = (v: unknown): Status => {
  const s = String(v ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (STATUSES as readonly string[]).includes(s) ? (s as Status) : "not_started";
};
const PRIORITY_SYNONYMS: Record<string, Priority> = {
  normal: "medium", standard: "medium", moderate: "medium", "2": "medium",
  critical: "high", urgent: "high", severe: "high", "1": "high",
  minor: "low", trivial: "low", "3": "low",
};
const asPriority = (v: unknown): Priority => {
  const s = String(v ?? "").trim().toLowerCase();
  if ((PRIORITIES as readonly string[]).includes(s)) return s as Priority;
  return PRIORITY_SYNONYMS[s] ?? "medium";
};

/** True when the cell said something we simply didn't recognise. */
const priorityUnknown = (v: string) => {
  const s = v.trim().toLowerCase();
  return Boolean(s) && !(PRIORITIES as readonly string[]).includes(s) && !(s in PRIORITY_SYNONYMS);
};

/** 0-100, or null when the field wasn't part of the submission. */
export function cleanProgress(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

export type Draft = {
  title: unknown; description?: unknown; status?: unknown; priority?: unknown;
  progress?: unknown;
  startDate?: unknown; dueDate?: unknown; assignedTo?: unknown;
};

// ---------------------------------------------------------------- mutations

export function createTask(a: Actor, d: Draft): { ok: true; id: string } | { error: string } {
  if (!can(a, "create_tasks")) return { error: "Your role can't create tasks." };
  if (countTasks(a.projectId) >= MAX_TASKS) return { error: `This project has hit the ${MAX_TASKS}-task limit.` };

  const title = clean(d.title, 200);
  if (!title) return { error: "Give the task a name." };

  // Assignment is re-derived from the actor, never trusted from the form.
  const assignee = typeof d.assignedTo === "string" && d.assignedTo ? d.assignedTo : null;
  if (assignee && !canAssignTo(a, assignee)) {
    return { error: "You can't assign work to that person." };
  }

  const start = cleanDate(d.startDate);
  const due = cleanDate(d.dueDate);
  if (start && due && due < start) return { error: "The due date is before the start date." };

  const id = newId();
  const t = now();
  // Insert, ref, chain and event are one unit — a half-written task with no
  // history is worse than no task.
  tx(() => {
    q.insert.run(id, a.projectId, title, clean(d.description, 2000), asStatus(d.status), asPriority(d.priority),
      cleanProgress(d.progress) ?? 0, start, due, assignee, assignee ? a.personId : null, a.personId, t, t);
    q.setRef.run(makeRef(a.projectId, a.projectCode, () => bumpSeq(a.projectId)), id);
    logEvent(a, id, "created", title);
    if (assignee) {
      recordAssignment(id, assignee, a.personId, "initial", "manual");
      logEvent(a, id, "assigned", title);
    }
  });
  return { ok: true, id };
}

export function updateTask(a: Actor, taskId: string, d: Draft): { ok: true } | { error: string } {
  const task = getTask(taskId, a.projectId);
  if (!task) return { error: "That task isn't in this project." };
  if (!canEditTask(a, task)) return { error: "That task is outside what you supervise." };

  const title = clean(d.title, 200);
  if (!title) return { error: "Give the task a name." };
  const start = cleanDate(d.startDate);
  const due = cleanDate(d.dueDate);
  if (start && due && due < start) return { error: "The due date is before the start date." };

  const status = asStatus(d.status);
  // An omitted progress field means "leave it", not "reset to zero" — the quick
  // status control on the list posts no progress at all.
  const progress = cleanProgress(d.progress) ?? task.progress;

  tx(() => {
    q.update.run(title, clean(d.description, 2000), status, asPriority(d.priority),
      progress, start, due, now(), taskId, a.projectId);
    // Status and progress get their own events. Rolling them into "updated"
    // makes the feed useless for the question people actually ask of it.
    if (status !== task.status) {
      logEvent(a, taskId, "status_changed", `${task.title}: ${STATUS_LABELS[task.status]} → ${STATUS_LABELS[status]}`);
    }
    if (progress !== task.progress) {
      logEvent(a, taskId, "progress_changed", `${task.title}: ${task.progress}% → ${progress}%`);
    }
    if (status === task.status && progress === task.progress) logEvent(a, taskId, "updated", title);
  });
  return { ok: true };
}

export function assignTask(a: Actor, taskId: string, personId: string | null): { ok: true } | { error: string } {
  const task = getTask(taskId, a.projectId);
  if (!task) return { error: "That task isn't in this project." };
  if (!can(a, "assign_tasks")) return { error: "Your role can't assign tasks." };
  // Both ends must be in scope: the task you're moving, and who you're moving it to.
  if (!canEditTask(a, task)) return { error: "That task is outside what you supervise." };
  if (personId && !canAssignTo(a, personId)) return { error: "You can't assign work to that person." };
  // A re-save of the same assignee is not a move. Recording it would pad the
  // chain with entries that never changed anything.
  if (personId === task.assigned_to) {
    return { error: personId ? "That task is already assigned to them." : "That task is already unassigned." };
  }

  // "initial" only ever describes the first time a task lands on someone. After
  // an unassign, putting it back is a reassignment — the chain already has a
  // beginning and there can only be one.
  const everAssigned = assignmentHistory(taskId).some((r) => r.assigned_to);
  const type: AssignmentType =
    personId === null ? "unassigned" : everAssigned ? "reassigned" : "initial";

  tx(() => {
    q.assign.run(personId, personId ? a.personId : null, now(), taskId, a.projectId);
    recordAssignment(taskId, personId, a.personId, type, "manual");
    logEvent(a, taskId, personId === null ? "unassigned" : everAssigned ? "reassigned" : "assigned", task.title);
  });
  return { ok: true };
}

/**
 * Hand a task you currently hold to someone below you.
 *
 * Distinct from reassignment: delegation requires that the task is *yours* right
 * now, and it records `delegated` so the chain reads as a hand-off rather than an
 * administrative move. The previous holder is never erased.
 */
export function delegateTask(a: Actor, taskId: string, toPersonId: string):
  { ok: true } | { error: string } {
  const task = getTask(taskId, a.projectId);
  if (!task) return { error: "That task isn't in this project." };
  if (!can(a, "assign_tasks")) return { error: "Your role can't delegate tasks." };
  if (!a.personId) return { error: "The project owner holds no tasks to delegate." };
  if (task.assigned_to !== a.personId) return { error: "You can only delegate a task assigned to you." };
  if (toPersonId === a.personId) return { error: "That task is already yours." };
  if (!canAssignTo(a, toPersonId)) return { error: "That person is outside what you supervise." };

  tx(() => {
    q.assign.run(toPersonId, a.personId, now(), taskId, a.projectId);
    recordAssignment(taskId, toPersonId, a.personId, "delegated", "delegation");
    logEvent(a, taskId, "delegated", task.title);
  });
  return { ok: true };
}

/** Who this actor may hand their own work to — never includes themselves. */
export function delegationTargets(a: Actor): string[] {
  if (!can(a, "assign_tasks") || !a.personId) return [];
  return [...scopeOf(a)].filter((id) => id !== a.personId);
}

export function deleteTask(a: Actor, taskId: string): { ok: true } | { error: string } {
  const task = getTask(taskId, a.projectId);
  if (!task) return { error: "That task isn't in this project." };
  if (!canEditTask(a, task)) return { error: "That task is outside what you supervise." };

  tx(() => {
    // The event is written first and keeps task_id, which now dangles by design:
    // deleting the task must not delete the record that it existed. The column
    // has no foreign key precisely so this survives.
    logEvent(a, taskId, "deleted", task.ref ? `${task.ref} · ${task.title}` : task.title);
    q.del.run(taskId, a.projectId);
  });
  return { ok: true };
}

// ---------------------------------------------------------------- import

export type AnalyzedRow = PreviewRow;
export type { RowVerdict };

const ALIASES: Record<string, string> = {
  // A P6 export calls these different things again, so the mapping step exists.
  "activity id": "ref", "task id": "ref", id: "ref", ref: "ref", "wbs code": "ref",
  "task name": "title", task: "title", title: "title", name: "title",
  activity: "title", "activity name": "title",
  description: "description", detail: "description", notes: "description",
  "task description": "description", "activity description": "description",
  "start date": "startDate", start: "startDate", "planned start": "startDate",
  "planned start date": "startDate",
  "due date": "dueDate", due: "dueDate", finish: "dueDate", "end date": "dueDate",
  deadline: "dueDate", "planned finish": "dueDate", "planned finish date": "dueDate",
  priority: "priority",
  status: "status",
  "assigned to": "assignedTo", assignee: "assignedTo", owner: "assignedTo",
  assigned: "assignedTo", "assigned supervisor": "assignedTo",
  "responsible person": "assignedTo", responsible: "assignedTo", "l3 owner": "assignedTo",
};

/**
 * Parses and validates without writing anything — this is what the preview
 * renders. `commitImport` re-runs it rather than trusting a client round-trip,
 * so nothing can be smuggled past the checks between preview and confirm.
 */
export type ColumnMap = Record<number, string>;   // column index → field name

/** What the header row looks like it means, before the user adjusts it. */
export function guessMapping(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<string>();
  header.forEach((h, i) => {
    const field = ALIASES[h.trim().toLowerCase()];
    // First column to claim a field wins, so "Activity Name" doesn't lose to a
    // later "Name" column.
    if (field && !taken.has(field)) { map[i] = field; taken.add(field); }
  });
  return map;
}

export const IMPORTABLE_FIELDS = [
  ["", "— ignore"],
  ["ref", "Task ID"],
  ["title", "Task name"],
  ["description", "Description"],
  ["startDate", "Start date"],
  ["dueDate", "Due date"],
  ["priority", "Priority"],
  ["status", "Status"],
  ["assignedTo", "Assigned to"],
] as const;

export function analyzeImport(a: Actor, text: string, mapping?: ColumnMap) {
  return analyzeRows(a, parseCsv(text), mapping);
}

export function analyzeRows(a: Actor, raw: string[][], mapping?: ColumnMap): {
  rows: AnalyzedRow[]; counts: Record<RowVerdict, number>; fatal?: string;
} {
  const empty = { rows: [], counts: { valid: 0, warning: 0, error: 0 } };
  if (!raw.length) return { ...empty, fatal: "The file was empty." };

  const map = mapping ?? guessMapping(raw[0]);
  const header: string[] = [];
  for (const [idx, field] of Object.entries(map)) header[Number(idx)] = field;

  if (!header.includes("title")) {
    return { ...empty, fatal: "No column is mapped to Task name. Pick one in the mapping step." };
  }

  const byName = new Map<string, Member>();
  for (const m of a.members) byName.set(m.name.toLowerCase(), m);

  // Re-importing the same export is the normal way this gets used, so both
  // kinds of duplicate have to be caught: the file repeating itself, and the
  // file repeating what is already in the project.
  const existingRefs = new Set(
    (db.prepare("SELECT ref FROM tasks WHERE project_id = ? AND ref IS NOT NULL").all(a.projectId) as
      { ref: string }[]).map((r) => r.ref.toLowerCase())
  );
  const seenRef = new Map<string, number>();     // lower(ref) → line
  const seenTitle = new Map<string, number>();   // lower(title) → line

  const rows: AnalyzedRow[] = [];
  const counts: Record<RowVerdict, number> = { valid: 0, warning: 0, error: 0 };

  for (let i = 1; i < raw.length && i <= MAX_IMPORT_ROWS; i++) {
    const cells = raw[i];
    const get = (k: string) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };

    const messages: string[] = [];
    let verdict: RowVerdict = "valid";
    const fail = (m: string) => { messages.push(m); verdict = "error"; };
    const warn = (m: string) => { messages.push(m); if (verdict === "valid") verdict = "warning"; };

    const title = get("title").slice(0, 200);
    if (!title) fail("No task name");

    const ref = get("ref").slice(0, 40) || null;
    if (ref) {
      const key = ref.toLowerCase();
      if (seenRef.has(key)) fail(`Duplicate of row ${seenRef.get(key)} — task ID "${ref}" appears twice`);
      else if (existingRefs.has(key)) fail(`Task ID "${ref}" is already in this project`);
      else seenRef.set(key, i + 1);
    } else if (title) {
      // Without an id there is nothing definitive to match on: the same activity
      // name legitimately recurs across WBS branches. Flag it, don't refuse it.
      const key = title.toLowerCase();
      if (seenTitle.has(key)) warn(`Same name as row ${seenTitle.get(key)} — imported as a separate task`);
      else seenTitle.set(key, i + 1);
    }

    const startDate = get("startDate") ? readDate(get("startDate")) : null;
    if (get("startDate") && !startDate) warn(`Start date "${get("startDate")}" not understood — left blank`);
    const dueDate = get("dueDate") ? readDate(get("dueDate")) : null;
    if (get("dueDate") && !dueDate) warn(`Due date "${get("dueDate")}" not understood — left blank`);
    if (startDate && dueDate && dueDate < startDate) fail("Due date is before the start date");

    const rawPriority = get("priority");
    if (priorityUnknown(rawPriority)) warn(`Priority "${rawPriority}" not recognised — set to medium`);

    let assignedTo: string | null = null;
    let assignedToName: string | null = null;
    const who = get("assignedTo");
    if (who) {
      const match = byName.get(who.toLowerCase());
      if (!match) fail(`"${who}" isn't on this project`);
      else if (!canAssignTo(a, match.id)) fail(`You can't assign work to ${match.name}`);
      else { assignedTo = match.id; assignedToName = match.name; }
    }

    counts[verdict]++;
    rows.push({
      line: i + 1, verdict, messages, ref, title,
      description: get("description").slice(0, 2000) || null,
      status: asStatus(get("status")), priority: asPriority(rawPriority),
      startDate, dueDate, assignedTo, assignedToName,
    });
  }

  if (raw.length - 1 > MAX_IMPORT_ROWS) {
    return { rows, counts, fatal: `Only the first ${MAX_IMPORT_ROWS} rows were read.` };
  }
  return { rows, counts };
}

/** Writes every non-error row. Re-validates from the source text by design. */
/** CSV convenience wrapper; the xlsx path calls commitRows with parsed rows. */
export function commitImport(a: Actor, text: string, mapping?: ColumnMap, overrides?: Record<number, string | null>) {
  return commitRows(a, parseCsv(text), mapping, overrides);
}

export type CommitResult = {
  added: number;
  skipped: number;
  assigned: number;          // rows that landed on someone
  unassigned: number;        // imported, but nobody to give them to
  reasons: string[];         // why rows were skipped, deduplicated and counted
  truncated?: string;        // set when the file was longer than we read
};

export function commitRows(
  a: Actor, raw: string[][], mapping?: ColumnMap, overrides?: Record<number, string | null>
): CommitResult | { error: string } {
  if (!can(a, "create_tasks")) return { error: "Your role can't create tasks." };
  const { rows, fatal } = analyzeRows(a, raw, mapping);
  if (fatal && !rows.length) return { error: fatal };

  // The preview lets the user re-point an assignee before importing. Every
  // override is re-checked here — the preview is a convenience, not authority.
  const overridden = new Set<number>();
  if (overrides) {
    for (const r of rows) {
      if (!(r.line in overrides)) continue;
      const to = overrides[r.line];
      if (to && !canAssignTo(a, to)) {
        r.verdict = "error";
        r.messages.push("You can't assign work to that person.");
        continue;
      }
      if (to !== r.assignedTo) overridden.add(r.line);
      r.assignedTo = to;
      if (r.verdict === "error" && r.messages.every((m) => /assign/i.test(m))) {
        r.verdict = "valid";                 // the override fixed the only problem
        r.messages = [];
      }
    }
  }

  const room = MAX_TASKS - countTasks(a.projectId);
  const reasons = new Map<string, number>();
  const note = (why: string) => reasons.set(why, (reasons.get(why) ?? 0) + 1);
  let added = 0, skipped = 0, assigned = 0;
  const t = now();

  // One transaction for the whole batch. A throw on row 400 of 653 used to
  // leave the first 399 written with no way to tell how far it got; now the
  // import either lands whole or not at all.
  try {
    tx(() => {
      for (const r of rows) {
        if (r.verdict === "error") { skipped++; note(r.messages[0] ?? "Row had errors"); continue; }
        if (added >= room) { skipped++; note(`Project task limit (${MAX_TASKS}) reached`); continue; }

        const id = newId();
        q.insert.run(id, a.projectId, r.title, r.description, r.status, r.priority, 0,
          r.startDate, r.dueDate, r.assignedTo, r.assignedTo ? a.personId : null, a.personId, t, t);
        // A ref supplied by the file is kept only while it is actually free —
        // analyzeRows already errors on a clash, and this is the backstop that
        // keeps the unique index from aborting the whole batch.
        const wanted = r.ref && !q.refTaken.get(a.projectId, r.ref) ? r.ref : null;
        q.setRef.run(wanted ?? makeRef(a.projectId, a.projectCode, () => bumpSeq(a.projectId)), id);

        if (r.assignedTo) {
          // Auto-assignment from the file is a real assignment, so it starts the
          // chain — and is marked `auto` unless the user re-pointed it in the
          // preview, which makes it their decision.
          recordAssignment(id, r.assignedTo, a.personId, "initial",
            overridden.has(r.line) ? "manual" : "auto");
          assigned++;
        }
        added++;
      }

      if (added) {
        q.event.run(a.projectId, null, "imported", a.personId,
          `Imported ${added} task${added === 1 ? "" : "s"}, ${assigned} auto-assigned`, t);
      }
    });
  } catch (e) {
    // The transaction is already rolled back; nothing was written.
    return { error: `The import failed and nothing was saved. ${(e as Error).message}` };
  }

  return {
    added, skipped, assigned, unassigned: added - assigned,
    reasons: [...reasons].map(([why, n]) => (n > 1 ? `${why} (${n} rows)` : why)),
    truncated: fatal,
  };
}
