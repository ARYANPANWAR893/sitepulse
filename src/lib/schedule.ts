import "server-only";
import { randomBytes, createHash } from "node:crypto";
import { db, now, tx } from "./db.ts";
import { type Member } from "./people.ts";
import { can, canAssignTo, canEditTask, type Actor } from "./access.ts";
import { cleanDate as cleanIsoDate, readDate, createTask, type Status, type Priority } from "./tasks.ts";
import type { ActivityPreviewRow, RowVerdict } from "./import-types.ts";

/**
 * The schedule domain.
 *
 * An *activity* is a row of a real project schedule — a P6 or MS Project line
 * with an Activity ID, a WBS position, planned and baseline dates and logic
 * links. It is stored in the `tasks` table, which was extended rather than
 * replaced: see the note in db.ts for why. Everything here speaks the schedule
 * language; `tasks.ts` keeps the assignment and delegation machinery those rows
 * already had, unchanged.
 *
 * The split this module exists to hold:
 *
 *   activity        what the schedule says should happen
 *   assignment      who is responsible        (task_assignments, in tasks.ts)
 *   progress event  what the field claims happened
 *   evidence        the proof offered for a claim
 *   audit event     what changed              (task_events, in tasks.ts)
 *
 * A progress event is deliberately *not* an update to the activity. It is a
 * claim, it may be wrong, it may not match any activity at all, and it has to
 * survive review either way. Applying one to an activity is a separate, audited
 * step.
 */

const newId = () => randomBytes(12).toString("hex");

// ---------------------------------------------------------------- types

export type Activity = {
  id: string;
  project_id: string;
  /** The schedule's own Activity ID, e.g. "A1010". Unique within a project. */
  ref: string | null;
  title: string;
  description: string | null;
  status: Status;
  priority: Priority;
  progress: number;

  wbs: string | null;          // "1.2.3"
  wbs_path: string | null;     // "Unit 3 > Piping > Spooling"
  wbs_level: number | null;
  discipline: string | null;
  location: string | null;

  start_date: string | null;   // planned start
  due_date: string | null;     // planned finish
  baseline_start: string | null;
  baseline_finish: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  planned_duration: number | null;
  actual_duration: number | null;

  notes: string | null;
  origin: "manual" | "import" | null;
  import_id: string | null;

  assigned_to: string | null;
  assigned_by: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export const RELATION_TYPES = ["FS", "SS", "FF", "SF"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_LABELS: Record<RelationType, string> = {
  FS: "Finish → Start", SS: "Start → Start",
  FF: "Finish → Finish", SF: "Start → Finish",
};

export type Relation = {
  id: string; project_id: string;
  predecessor_id: string; successor_id: string;
  type: RelationType; lag_days: number; created_at: number;
};

export type ProgressEvent = {
  id: string; project_id: string;
  activity_id: string | null;
  reported_by: string | null;
  reported_at: number;
  source: "manual" | "whatsapp" | "import" | "system";
  raw_text: string | null;
  progress: number | null;
  status: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number | null;
  match_method: string | null;
  review_state: "pending" | "accepted" | "rejected" | "auto_accepted";
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_note: string | null;
  applied: number;
  created_at: number;
};

export type Evidence = {
  id: string; project_id: string;
  progress_event_id: string | null;
  activity_id: string | null;
  kind: "photo" | "document" | "message" | "link";
  uri: string | null; filename: string | null; mime: string | null;
  byte_size: number | null; sha256: string | null; caption: string | null;
  captured_at: number | null; created_by: string | null; created_at: number;
};

const ACTIVITY_COLS = `id, project_id, ref, title, description, status, priority, progress,
  wbs, wbs_path, wbs_level, discipline, location,
  start_date, due_date, baseline_start, baseline_finish, actual_start, actual_finish,
  planned_duration, actual_duration, notes, origin, import_id,
  assigned_to, assigned_by, created_by, created_at, updated_at`;

const q = {
  all: db.prepare(`SELECT ${ACTIVITY_COLS} FROM tasks WHERE project_id = ?
    ORDER BY CASE WHEN wbs IS NULL THEN 1 ELSE 0 END, wbs, ref, created_at`),
  one: db.prepare(`SELECT ${ACTIVITY_COLS} FROM tasks WHERE id = ? AND project_id = ?`),
  byRef: db.prepare(`SELECT ${ACTIVITY_COLS} FROM tasks WHERE project_id = ? AND ref = ?`),
  refMap: db.prepare("SELECT id, ref FROM tasks WHERE project_id = ? AND ref IS NOT NULL"),

  updateSchedule: db.prepare(`UPDATE tasks SET
    title = ?, description = ?, status = ?, priority = ?, progress = ?,
    wbs = ?, wbs_path = ?, wbs_level = ?, discipline = ?, location = ?,
    start_date = ?, due_date = ?, baseline_start = ?, baseline_finish = ?,
    actual_start = ?, actual_finish = ?, planned_duration = ?, actual_duration = ?,
    notes = ?, updated_at = ?
    WHERE id = ? AND project_id = ?`),
  stampImport: db.prepare("UPDATE tasks SET origin = ?, import_id = ? WHERE id = ?"),

  addRelation: db.prepare(`INSERT OR IGNORE INTO activity_relations
    (id, project_id, predecessor_id, successor_id, type, lag_days, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`),
  relationsOf: db.prepare(`SELECT * FROM activity_relations
    WHERE predecessor_id = ? OR successor_id = ?`),
  relationsIn: db.prepare("SELECT * FROM activity_relations WHERE project_id = ?"),
  dropRelation: db.prepare("DELETE FROM activity_relations WHERE id = ? AND project_id = ?"),

  addImport: db.prepare(`INSERT INTO schedule_imports
    (id, project_id, user_id, filename, sheet_name, mode, mapping, rows_read,
     created_count, updated_count, skipped_count, relations_made, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  importsOf: db.prepare("SELECT * FROM schedule_imports WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"),
  oneImport: db.prepare("SELECT * FROM schedule_imports WHERE id = ? AND project_id = ?"),

  addEvent: db.prepare(`INSERT INTO progress_events
    (id, project_id, activity_id, reported_by, reported_at, source, raw_text,
     progress, status, actual_start, actual_finish, quantity, unit,
     confidence, match_method, review_state, applied, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  eventsFor: db.prepare("SELECT * FROM progress_events WHERE activity_id = ? ORDER BY reported_at DESC"),
  pendingIn: db.prepare(`SELECT * FROM progress_events
    WHERE project_id = ? AND review_state = 'pending' ORDER BY reported_at DESC LIMIT ?`),
  eventCounts: db.prepare(`SELECT activity_id, count(*) c FROM progress_events
    WHERE project_id = ? AND activity_id IS NOT NULL GROUP BY activity_id`),
  decideEvent: db.prepare(`UPDATE progress_events
    SET review_state = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, applied = ?
    WHERE id = ? AND project_id = ?`),
  oneEvent: db.prepare("SELECT * FROM progress_events WHERE id = ? AND project_id = ?"),

  addEvidence: db.prepare(`INSERT INTO evidence
    (id, project_id, progress_event_id, activity_id, kind, uri, filename, mime,
     byte_size, sha256, caption, captured_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  evidenceFor: db.prepare("SELECT * FROM evidence WHERE activity_id = ? ORDER BY created_at DESC"),

  putEmbedding: db.prepare(`INSERT INTO activity_embeddings
    (activity_id, project_id, model, dims, vector, text_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      model = excluded.model, dims = excluded.dims, vector = excluded.vector,
      text_hash = excluded.text_hash, created_at = excluded.created_at`),
  embeddingsIn: db.prepare("SELECT * FROM activity_embeddings WHERE project_id = ?"),
  staleEmbeddings: db.prepare(`SELECT t.id, t.ref, t.title, t.description, t.wbs_path, t.discipline
    FROM tasks t LEFT JOIN activity_embeddings e ON e.activity_id = t.id
    WHERE t.project_id = ? AND (e.activity_id IS NULL OR e.text_hash != ?)`),

  event: db.prepare("INSERT INTO task_events (project_id, task_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)"),
};

// ---------------------------------------------------------------- reads

export const listActivities = (projectId: string) => q.all.all(projectId) as Activity[];

export const getActivity = (id: string, projectId: string) =>
  (q.one.get(id, projectId) as Activity | undefined) ?? null;

export const activityByRef = (projectId: string, ref: string) =>
  (q.byRef.get(projectId, ref) as Activity | undefined) ?? null;

/**
 * The filter set the schedule view drives.
 *
 * Applied in memory rather than as SQL: a project is capped at 5000 activities,
 * the page already loads them for the WBS tree, and a second round trip per
 * keystroke buys nothing at that size. The shape is what matters — it is the
 * same predicate set the matcher will need to narrow candidates.
 */
export type ActivityFilter = {
  query?: string;
  wbs?: string;            // prefix match, so "1.2" catches "1.2.3"
  status?: string;
  assignee?: string;       // person id, or "unassigned"
  discipline?: string;
  location?: string;
};

export function filterActivities(rows: Activity[], f: ActivityFilter): Activity[] {
  const needle = f.query?.trim().toLowerCase();
  return rows.filter((a) => {
    if (f.wbs && !(a.wbs === f.wbs || a.wbs?.startsWith(`${f.wbs}.`))) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.discipline && a.discipline !== f.discipline) return false;
    if (f.location && a.location !== f.location) return false;
    if (f.assignee === "unassigned" ? a.assigned_to !== null : f.assignee && a.assigned_to !== f.assignee) return false;
    if (needle) {
      const hay = `${a.ref ?? ""} ${a.title} ${a.wbs_path ?? ""} ${a.discipline ?? ""} ${a.location ?? ""}`;
      if (!hay.toLowerCase().includes(needle)) return false;
    }
    return true;
  });
}

/** The distinct values behind each filter control, taken from the data itself. */
export function facetsOf(rows: Activity[]) {
  const pick = (get: (a: Activity) => string | null) =>
    [...new Set(rows.map(get).filter((v): v is string => Boolean(v)))].sort();
  return {
    disciplines: pick((a) => a.discipline),
    locations: pick((a) => a.location),
  };
}

// ---------------------------------------------------------------- WBS

export type WbsNode = {
  code: string;            // "1.2"
  label: string;           // the last segment of the path, or the code
  level: number;
  count: number;           // activities at or below this node
  children: WbsNode[];
};

/** Depth of a dotted code. "1.2.3" is level 3; a blank code has no level. */
export function wbsLevel(code: string | null): number | null {
  if (!code) return null;
  const parts = code.split(".").filter(Boolean);
  return parts.length || null;
}

/**
 * Builds the WBS tree from the codes present on the activities.
 *
 * Intermediate nodes are synthesised: a schedule that jumps from "1" to "1.2.1"
 * still needs a "1.2" to hang it under, and P6 exports routinely omit summary
 * rows. Labels come from the matching segment of `wbs_path` when there is one.
 */
export function buildWbsTree(rows: Activity[]): WbsNode[] {
  const nodes = new Map<string, WbsNode>();
  // A code's depth and its path's depth routinely disagree — "1.3" with the
  // path "Duliajan > Piping > Testing" is two levels of code and three of name.
  // Front-aligned segments name the summary levels correctly; the last segment
  // names the leaf. Both are collected and chosen between once the tree exists.
  const leafLabel = new Map<string, string>();

  const ensure = (code: string, label: string): WbsNode => {
    const found = nodes.get(code);
    if (found) {
      if (found.label === code && label !== code) found.label = label;
      return found;
    }
    const node: WbsNode = { code, label, level: code.split(".").length, count: 0, children: [] };
    nodes.set(code, node);
    return node;
  };

  for (const a of rows) {
    if (!a.wbs) continue;
    const parts = a.wbs.split(".").filter(Boolean);
    const labels = (a.wbs_path ?? "").split(">").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const code = parts.slice(0, i + 1).join(".");
      ensure(code, labels[i] ?? code).count++;
    }
    const deepest = parts.join(".");
    if (labels.length) leafLabel.set(deepest, labels[labels.length - 1]);
  }

  const roots: WbsNode[] = [];
  for (const node of nodes.values()) {
    const dot = node.code.lastIndexOf(".");
    const parent = dot > 0 ? nodes.get(node.code.slice(0, dot)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // A node with children is a summary level and keeps its front-aligned name;
  // a node with none is a leaf and takes the tail of the path.
  for (const node of nodes.values()) {
    if (node.children.length) continue;
    const tail = leafLabel.get(node.code);
    if (tail) node.label = tail;
  }

  const byCode = (a: WbsNode, b: WbsNode) =>
    a.code.localeCompare(b.code, undefined, { numeric: true });
  const sort = (list: WbsNode[]) => {
    list.sort(byCode);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

export function flattenWbs(nodes: WbsNode[]): WbsNode[] {
  return nodes.flatMap((n) => [n, ...flattenWbs(n.children)]);
}

// ---------------------------------------------------------------- relations

/**
 * Parses a predecessor/successor cell.
 *
 * P6 exports write these as a comma or semicolon separated list, optionally with
 * a relationship type and lag: "A1010, A1020FS+2, A1030SS-1". Bare ids are the
 * common case and default to Finish→Start with no lag.
 */
export function parseRelationCell(cell: string): { ref: string; type: RelationType; lag: number }[] {
  if (!cell?.trim()) return [];
  const out: { ref: string; type: RelationType; lag: number }[] = [];

  for (const piece of cell.split(/[,;\n]/)) {
    const s = piece.trim();
    if (!s) continue;

    // A lag is only read when a relationship type introduces it, or when the
    // sign is a "+". Activity IDs routinely contain hyphens — "CIV-100",
    // "B-999" — and a rule that treated any trailing -N as a lag turned
    // "B-999" into activity "B" with a lag of -999.
    const typed = /^(.+?)\s*(FS|SS|FF|SF)\s*([+-]\s*\d+(?:\.\d+)?)?\s*(?:d|days?)?$/i.exec(s);
    if (typed) {
      out.push({
        ref: typed[1].trim(),
        type: typed[2].toUpperCase() as RelationType,
        lag: typed[3] ? Math.round(Number(typed[3].replace(/\s+/g, ""))) : 0,
      });
      continue;
    }

    const plusLag = /^(.+?)\s*\+\s*(\d+(?:\.\d+)?)\s*(?:d|days?)?$/i.exec(s);
    if (plusLag) {
      out.push({ ref: plusLag[1].trim(), type: "FS", lag: Math.round(Number(plusLag[2])) });
      continue;
    }

    // Everything else is the id, verbatim.
    out.push({ ref: s, type: "FS", lag: 0 });
  }
  return out;
}

export type ActivityRelations = {
  predecessors: (Relation & { other: Activity })[];
  successors: (Relation & { other: Activity })[];
};

export function relationsFor(activityId: string, projectId: string): ActivityRelations {
  const rows = q.relationsOf.all(activityId, activityId) as Relation[];
  const out: ActivityRelations = { predecessors: [], successors: [] };
  for (const r of rows) {
    const otherId = r.predecessor_id === activityId ? r.successor_id : r.predecessor_id;
    const other = getActivity(otherId, projectId);
    if (!other) continue;
    if (r.successor_id === activityId) out.predecessors.push({ ...r, other });
    else out.successors.push({ ...r, other });
  }
  return out;
}

/** Every edge in the project, for callers that need the whole graph at once. */
export const listRelations = (projectId: string) => q.relationsIn.all(projectId) as Relation[];

export function linkActivities(
  projectId: string, predecessorId: string, successorId: string,
  type: RelationType = "FS", lag = 0
): { ok: true } | { error: string } {
  if (predecessorId === successorId) return { error: "An activity can't depend on itself." };
  const a = getActivity(predecessorId, projectId);
  const b = getActivity(successorId, projectId);
  if (!a || !b) return { error: "Both activities must be in this project." };
  // A cycle in the logic makes any forward pass non-terminating, so refuse it
  // at the point of creation rather than discovering it during a schedule run.
  if (reaches(successorId, predecessorId, projectId)) {
    return { error: `That would create a loop — ${b.ref ?? b.title} already leads to ${a.ref ?? a.title}.` };
  }
  q.addRelation.run(newId(), projectId, predecessorId, successorId, type, lag, now());
  return { ok: true };
}

export const unlinkActivities = (relationId: string, projectId: string) =>
  q.dropRelation.run(relationId, projectId).changes > 0;

/** Can `from` get to `to` by following successors? Used as the cycle guard. */
function reaches(from: string, to: string, projectId: string): boolean {
  const edges = listRelations(projectId);
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.predecessor_id);
    if (list) list.push(e.successor_id);
    else next.set(e.predecessor_id, [e.successor_id]);
  }
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

// ---------------------------------------------------------------- progress events

export type ProgressDraft = {
  activityId: string | null;
  reportedBy?: string | null;
  source?: ProgressEvent["source"];
  rawText?: string | null;
  progress?: number | null;
  status?: string | null;
  actualStart?: string | null;
  actualFinish?: string | null;
  quantity?: number | null;
  unit?: string | null;
  /** Set by a matcher. Null while a human is the only thing choosing. */
  confidence?: number | null;
  matchMethod?: string | null;
  reviewState?: ProgressEvent["review_state"];
};

/**
 * Records a claim about an activity. Does not change the activity.
 *
 * Separating the two is the point: the field says 60%, the schedule says 40%,
 * and until someone decides, both facts have to exist at once.
 */
export function recordProgressEvent(a: Actor, d: ProgressDraft): { ok: true; id: string } | { error: string } {
  if (d.activityId) {
    const activity = getActivity(d.activityId, a.projectId);
    if (!activity) return { error: "That activity isn't in this project." };
  }
  const pct = d.progress === null || d.progress === undefined ? null
    : Math.min(100, Math.max(0, Math.round(d.progress)));

  const id = newId();
  const t = now();
  tx(() => {
    q.addEvent.run(id, a.projectId, d.activityId ?? null, d.reportedBy ?? a.personId, t,
      d.source ?? "manual", d.rawText ?? null, pct, d.status ?? null,
      d.actualStart ?? null, d.actualFinish ?? null,
      d.quantity ?? null, d.unit ?? null,
      d.confidence ?? null, d.matchMethod ?? "manual",
      d.reviewState ?? "pending", 0, t);
    q.event.run(a.projectId, d.activityId, "progress_reported", a.personId,
      d.rawText?.slice(0, 160) ?? (pct !== null ? `${pct}% reported` : "progress reported"), t);
  });
  return { ok: true, id };
}

export const progressEventsFor = (activityId: string) =>
  q.eventsFor.all(activityId) as ProgressEvent[];

export const pendingProgressEvents = (projectId: string, limit = 50) =>
  q.pendingIn.all(projectId, limit) as ProgressEvent[];

export function progressEventCounts(projectId: string): Map<string, number> {
  const rows = q.eventCounts.all(projectId) as { activity_id: string; c: number }[];
  return new Map(rows.map((r) => [r.activity_id, r.c]));
}

/**
 * Accept or reject a claim.
 *
 * Accepting is what moves the activity, and it does so inside the same
 * transaction that marks the event applied — so a claim can never read as
 * accepted while the activity it referred to was left untouched.
 */
export function decideProgressEvent(
  a: Actor, eventId: string, decision: "accepted" | "rejected", note?: string
): { ok: true } | { error: string } {
  const ev = q.oneEvent.get(eventId, a.projectId) as ProgressEvent | undefined;
  if (!ev) return { error: "That report isn't in this project." };
  if (ev.review_state !== "pending") return { error: "That report has already been reviewed." };
  if (!can(a, "edit_tasks")) return { error: "Your role can't review field reports." };

  const activity = ev.activity_id ? getActivity(ev.activity_id, a.projectId) : null;
  if (decision === "accepted" && !activity) {
    return { error: "Point the report at an activity before accepting it." };
  }
  if (activity && !canEditTask(a, activity)) {
    return { error: "That activity is outside what you supervise." };
  }

  tx(() => {
    let applied = 0;
    if (decision === "accepted" && activity) {
      const progress = ev.progress ?? activity.progress;
      const status = (ev.status as Status) ?? activity.status;
      q.updateSchedule.run(
        activity.title, activity.description, status, activity.priority, progress,
        activity.wbs, activity.wbs_path, activity.wbs_level, activity.discipline, activity.location,
        activity.start_date, activity.due_date, activity.baseline_start, activity.baseline_finish,
        ev.actual_start ?? activity.actual_start, ev.actual_finish ?? activity.actual_finish,
        activity.planned_duration, activity.actual_duration, activity.notes,
        now(), activity.id, a.projectId
      );
      applied = 1;
      if (progress !== activity.progress) {
        q.event.run(a.projectId, activity.id, "progress_changed", a.personId,
          `${activity.title}: ${activity.progress}% → ${progress}% (from a field report)`, now());
      }
    }
    q.decideEvent.run(decision, a.personId, now(), note ?? null, applied, eventId, a.projectId);
    q.event.run(a.projectId, ev.activity_id, "review_decided", a.personId,
      `Field report ${decision}${applied ? " and applied" : ""}`, now());
  });
  return { ok: true };
}

// ---------------------------------------------------------------- evidence

export type EvidenceDraft = {
  progressEventId?: string | null;
  activityId?: string | null;
  kind: Evidence["kind"];
  uri?: string | null; filename?: string | null; mime?: string | null;
  byteSize?: number | null; sha256?: string | null; caption?: string | null;
  capturedAt?: number | null;
};

export function attachEvidence(a: Actor, d: EvidenceDraft): { ok: true; id: string } | { error: string } {
  if (d.activityId && !getActivity(d.activityId, a.projectId)) {
    return { error: "That activity isn't in this project." };
  }
  const id = newId();
  const t = now();
  tx(() => {
    q.addEvidence.run(id, a.projectId, d.progressEventId ?? null, d.activityId ?? null,
      d.kind, d.uri ?? null, d.filename ?? null, d.mime ?? null,
      d.byteSize ?? null, d.sha256 ?? null, d.caption ?? null,
      d.capturedAt ?? null, a.personId, t);
    q.event.run(a.projectId, d.activityId ?? null, "evidence_added", a.personId,
      d.caption ?? d.filename ?? d.kind, t);
  });
  return { ok: true, id };
}

export const evidenceFor = (activityId: string) => q.evidenceFor.all(activityId) as Evidence[];

// ---------------------------------------------------------------- embeddings

/**
 * The text an activity would be matched on.
 *
 * Assembled in one place so the vector, the hash that decides staleness and any
 * future keyword fallback all describe the same thing. Nothing embeds yet —
 * this is the seam the matcher will attach to.
 */
export function matchTextFor(a: Pick<Activity, "ref" | "title" | "description" | "wbs_path" | "discipline">): string {
  return [a.ref, a.title, a.wbs_path, a.discipline, a.description]
    .filter(Boolean).join(" · ");
}

export const matchTextHash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Stores a vector for an activity. Float32 in, bytes out. */
export function putEmbedding(
  activityId: string, projectId: string, model: string, vector: Float32Array, text: string
): void {
  q.putEmbedding.run(activityId, projectId, model, vector.length,
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    matchTextHash(text), now());
}

export type StoredEmbedding = { activity_id: string; dims: number; vector: Float32Array };

export function embeddingsIn(projectId: string): StoredEmbedding[] {
  const rows = q.embeddingsIn.all(projectId) as
    { activity_id: string; dims: number; vector: Uint8Array }[];
  return rows.map((r) => ({
    activity_id: r.activity_id,
    dims: r.dims,
    vector: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dims),
  }));
}

/**
 * Activities whose stored vector is missing or describes older text.
 *
 * Takes the hash of the *current* text per row, so a schedule of 5000 where two
 * titles changed re-embeds two, not 5000.
 */
export function activitiesNeedingEmbedding(projectId: string): { id: string; text: string }[] {
  const rows = q.staleEmbeddings.all(projectId, "") as
    (Pick<Activity, "id" | "ref" | "title" | "description" | "wbs_path" | "discipline">)[];
  const stored = new Map(
    (db.prepare("SELECT activity_id, text_hash FROM activity_embeddings WHERE project_id = ?")
      .all(projectId) as { activity_id: string; text_hash: string }[])
      .map((r) => [r.activity_id, r.text_hash])
  );
  const out: { id: string; text: string }[] = [];
  for (const r of rows) {
    const text = matchTextFor(r);
    if (stored.get(r.id) !== matchTextHash(text)) out.push({ id: r.id, text });
  }
  return out;
}

// ---------------------------------------------------------------- import metadata

export type ScheduleImport = {
  id: string; project_id: string; user_id: string;
  filename: string | null; sheet_name: string | null;
  mode: "create" | "update"; mapping: string | null;
  rows_read: number; created_count: number; updated_count: number;
  skipped_count: number; relations_made: number; created_at: number;
};

export const recentImports = (projectId: string, limit = 10) =>
  q.importsOf.all(projectId, limit) as ScheduleImport[];

export const getImport = (id: string, projectId: string) =>
  (q.oneImport.get(id, projectId) as ScheduleImport | undefined) ?? null;

// ---------------------------------------------------------------- editing

export type ActivityPatch = {
  title?: unknown; description?: unknown; status?: unknown; priority?: unknown;
  progress?: unknown; wbs?: unknown; wbsPath?: unknown;
  discipline?: unknown; location?: unknown;
  plannedStart?: unknown; plannedFinish?: unknown;
  baselineStart?: unknown; baselineFinish?: unknown;
  actualStart?: unknown; actualFinish?: unknown;
  plannedDuration?: unknown; actualDuration?: unknown;
  notes?: unknown;
};


// ---------------------------------------------------------------- editing

const trim = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const pct = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(String(v).replace(/%/g, "").trim()));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

/** Whole days. P6 writes "12", "12d", "12 days"; MS Project sometimes "12 edays". */
export function readDuration(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:e?d|days?|hrs?|h)?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = Math.round(Number(m[1]));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Edits the schedule fields of an activity.
 *
 * Assignment is *not* here — it stays in tasks.ts behind the scope checks and
 * the append-only chain, so no schedule edit can quietly move ownership.
 */
export function updateActivity(
  a: Actor, activityId: string, p: ActivityPatch
): { ok: true } | { error: string } {
  const before = getActivity(activityId, a.projectId);
  if (!before) return { error: "That activity isn't in this project." };
  if (!canEditTask(a, before)) return { error: "That activity is outside what you supervise." };

  const title = trim(p.title, 200) ?? before.title;
  if (!title) return { error: "Give the activity a name." };

  const plannedStart = "plannedStart" in p ? cleanIsoDate(p.plannedStart) : before.start_date;
  const plannedFinish = "plannedFinish" in p ? cleanIsoDate(p.plannedFinish) : before.due_date;
  if (plannedStart && plannedFinish && plannedFinish < plannedStart) {
    return { error: "Planned finish is before planned start." };
  }
  const actualStart = "actualStart" in p ? cleanIsoDate(p.actualStart) : before.actual_start;
  const actualFinish = "actualFinish" in p ? cleanIsoDate(p.actualFinish) : before.actual_finish;
  if (actualStart && actualFinish && actualFinish < actualStart) {
    return { error: "Actual finish is before actual start." };
  }

  const wbs = "wbs" in p ? trim(p.wbs, 60) : before.wbs;
  const status = (p.status && STATUS_SET.has(String(p.status)) ? String(p.status) : before.status) as Status;
  const progress = "progress" in p ? (pct(p.progress) ?? before.progress) : before.progress;

  tx(() => {
    q.updateSchedule.run(
      title, "description" in p ? trim(p.description, 2000) : before.description,
      status, before.priority, progress,
      wbs, "wbsPath" in p ? trim(p.wbsPath, 400) : before.wbs_path, wbsLevel(wbs),
      "discipline" in p ? trim(p.discipline, 60) : before.discipline,
      "location" in p ? trim(p.location, 120) : before.location,
      plannedStart, plannedFinish,
      "baselineStart" in p ? cleanIsoDate(p.baselineStart) : before.baseline_start,
      "baselineFinish" in p ? cleanIsoDate(p.baselineFinish) : before.baseline_finish,
      actualStart, actualFinish,
      "plannedDuration" in p ? readDuration(p.plannedDuration) : before.planned_duration,
      "actualDuration" in p ? readDuration(p.actualDuration) : before.actual_duration,
      "notes" in p ? trim(p.notes, 2000) : before.notes,
      now(), activityId, a.projectId
    );
    if (status !== before.status) {
      q.event.run(a.projectId, activityId, "status_changed", a.personId,
        `${title}: ${before.status} → ${status}`, now());
    }
    if (progress !== before.progress) {
      q.event.run(a.projectId, activityId, "progress_changed", a.personId,
        `${title}: ${before.progress}% → ${progress}%`, now());
    }
    q.event.run(a.projectId, activityId, "activity_updated", a.personId, title, now());
  });
  return { ok: true };
}

// ---------------------------------------------------------------- import
//
// The schedule importer. Wider than the task importer it grew out of, and with
// one behaviour the old one had no concept of: a schedule is re-issued weekly,
// so re-importing must be able to *update* matched Activity IDs rather than
// refusing them as duplicates.

export const SCHEDULE_FIELDS = [
  ["", "— ignore"],
  ["activityId", "Activity ID"],
  ["title", "Activity name"],
  ["description", "Description"],
  ["wbs", "WBS code"],
  ["wbsPath", "WBS path"],
  ["discipline", "Discipline"],
  ["location", "Location"],
  ["plannedStart", "Planned start"],
  ["plannedFinish", "Planned finish"],
  ["baselineStart", "Baseline start"],
  ["baselineFinish", "Baseline finish"],
  ["actualStart", "Actual start"],
  ["actualFinish", "Actual finish"],
  ["plannedDuration", "Duration"],
  ["predecessors", "Predecessors"],
  ["successors", "Successors"],
  ["progress", "Progress %"],
  ["status", "Status"],
  ["assignedTo", "Assignee"],
  ["notes", "Notes"],
] as const;

/**
 * Header aliases.
 *
 * Drawn from what P6, MS Project and hand-kept trackers actually write. The
 * mapping step exists because no two exports agree, so this only needs to make
 * the common case land without intervention.
 */
const ALIASES: Record<string, string> = {
  "activity id": "activityId", "activity code": "activityId", "task id": "activityId",
  id: "activityId", ref: "activityId", "unique id": "activityId", "act id": "activityId",
  "activity name": "title", "task name": "title", activity: "title", task: "title",
  name: "title", title: "title", "activity description": "title",
  description: "description", notes: "notes", remarks: "notes", comment: "notes",
  detail: "description", details: "description",
  wbs: "wbs", "wbs code": "wbs", "wbs id": "wbs", "wbs number": "wbs",
  "wbs path": "wbsPath", "wbs name": "wbsPath", "wbs hierarchy": "wbsPath",
  "wbs description": "wbsPath", outline: "wbsPath",
  discipline: "discipline", trade: "discipline", "activity type": "discipline",
  department: "discipline", dept: "discipline", craft: "discipline",
  location: "location", area: "location", zone: "location", unit: "location", site: "location",
  "planned start": "plannedStart", "start": "plannedStart", "start date": "plannedStart",
  "early start": "plannedStart", "scheduled start": "plannedStart", "planned start date": "plannedStart",
  "planned finish": "plannedFinish", finish: "plannedFinish", "finish date": "plannedFinish",
  "early finish": "plannedFinish", "end date": "plannedFinish", "due date": "plannedFinish",
  "scheduled finish": "plannedFinish", "planned finish date": "plannedFinish",
  "baseline start": "baselineStart", "bl start": "baselineStart", "target start": "baselineStart",
  "baseline finish": "baselineFinish", "bl finish": "baselineFinish", "target finish": "baselineFinish",
  "actual start": "actualStart", "act start": "actualStart",
  "actual finish": "actualFinish", "act finish": "actualFinish",
  duration: "plannedDuration", "original duration": "plannedDuration",
  "planned duration": "plannedDuration", "orig dur": "plannedDuration", od: "plannedDuration",
  predecessors: "predecessors", predecessor: "predecessors", preds: "predecessors",
  "predecessor id": "predecessors", "depends on": "predecessors",
  successors: "successors", successor: "successors", succs: "successors",
  "successor id": "successors",
  progress: "progress", "% complete": "progress", "percent complete": "progress",
  "pct complete": "progress", complete: "progress", "physical % complete": "progress",
  status: "status", "activity status": "status",
  "assigned to": "assignedTo", assignee: "assignedTo", owner: "assignedTo",
  responsible: "assignedTo", "responsible person": "assignedTo",
  "l3 owner": "assignedTo", "assigned supervisor": "assignedTo", "resource": "assignedTo",
};

export type ColumnMap = Record<number, string>;

export function guessScheduleMapping(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const taken = new Set<string>();
  header.forEach((h, i) => {
    const field = ALIASES[h.trim().toLowerCase()];
    // First column to claim a field wins, so "Activity Name" isn't stolen by a
    // later bare "Name".
    if (field && !taken.has(field)) { map[i] = field; taken.add(field); }
  });
  return map;
}

export const MAX_ACTIVITIES = 5000;
export const MAX_IMPORT_ROWS = 2000;

const STATUS_SET = new Set(["not_started", "in_progress", "completed"]);

const STATUS_SYNONYMS: Record<string, Status> = {
  "not started": "not_started", notstarted: "not_started", planned: "not_started",
  new: "not_started", pending: "not_started", "to do": "not_started", todo: "not_started",
  "in progress": "in_progress", inprogress: "in_progress", started: "in_progress",
  active: "in_progress", wip: "in_progress", ongoing: "in_progress", "in-progress": "in_progress",
  complete: "completed", completed: "completed", done: "completed", finished: "completed",
  closed: "completed",
};

/** Reads a status cell; anything unrecognised is inferred from progress instead. */
export function readStatus(v: string, progress: number | null): Status {
  const s = v.trim().toLowerCase();
  if (STATUS_SET.has(s.replace(/[\s-]+/g, "_"))) return s.replace(/[\s-]+/g, "_") as Status;
  if (STATUS_SYNONYMS[s]) return STATUS_SYNONYMS[s];
  // A schedule that carries % complete but no status column is normal.
  if (progress !== null) return progress >= 100 ? "completed" : progress > 0 ? "in_progress" : "not_started";
  return "not_started";
}

export type ScheduleAnalysis = {
  rows: ActivityPreviewRow[];
  counts: Record<string, number>;
  /** How many columns the header actually mapped, for the preview's summary. */
  mappedColumns: number;
  /**
   * Which fields the file actually carries.
   *
   * Load-bearing in update mode: a re-issue that only carries Activity ID and
   * % Complete must refresh those and leave WBS, discipline and the baseline
   * alone. Writing every column would blank whatever the file omitted, which is
   * how a progress update silently destroys a schedule.
   */
  mappedFields: Set<string>;
  fatal?: string;
};

/**
 * Validates a sheet without writing anything.
 *
 * Re-run on commit rather than trusting the preview, so nothing can be edited
 * into validity between the two steps. Every row comes back with an `action`,
 * which is what lets the preview say "412 new, 241 updated" before the user
 * commits to it.
 */
export function analyzeSchedule(
  a: Actor, raw: string[][], mapping?: ColumnMap,
  mode: "create" | "update" = "create",
  overrides: Record<number, string | null> = {}
): ScheduleAnalysis {
  const empty = {
    rows: [] as ActivityPreviewRow[],
    counts: { valid: 0, warning: 0, error: 0, create: 0, update: 0 },
    mappedColumns: 0,
    mappedFields: new Set<string>(),
  };
  if (!raw.length) return { ...empty, fatal: "The file was empty." };

  const map = mapping ?? guessScheduleMapping(raw[0]);
  const header: string[] = [];
  for (const [idx, field] of Object.entries(map)) header[Number(idx)] = field;
  const mappedColumns = Object.values(map).filter(Boolean).length;
  const mappedFields = new Set(Object.values(map).filter(Boolean));

  // What a file must carry depends on what it is for. A new schedule needs
  // names; a weekly re-issue is matched on Activity ID and may legitimately
  // carry nothing but progress.
  if (mode === "create" && !header.includes("title")) {
    return { ...empty, mappedColumns, mappedFields, fatal: "No column is mapped to Activity name. Pick one in the mapping step." };
  }
  if (mode === "update" && !header.includes("activityId")) {
    return {
      ...empty, mappedColumns, mappedFields,
      fatal: "Update mode matches on Activity ID, and no column is mapped to it. Pick one, or switch to New schedule.",
    };
  }

  const byName = new Map<string, Member>();
  for (const m of a.members) byName.set(m.name.toLowerCase(), m);

  // Activity IDs already in the project decide create-vs-update, and in create
  // mode they are what makes a row a duplicate.
  const existing = new Map(
    (q.refMap.all(a.projectId) as { id: string; ref: string }[])
      .map((r) => [r.ref.toLowerCase(), r.id])
  );
  const seenId = new Map<string, number>();       // lower(activity id) -> line
  const seenTitle = new Map<string, number>();

  const rows: ActivityPreviewRow[] = [];
  const counts: Record<string, number> = { valid: 0, warning: 0, error: 0, create: 0, update: 0 };
  const limit = Math.min(raw.length - 1, MAX_IMPORT_ROWS);

  for (let i = 1; i <= limit; i++) {
    const cells = raw[i] ?? [];
    const get = (k: string) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };

    // Two lists rather than a mutable verdict: the verdict is derived at the
    // end, and errors read first in the preview, which is the order a person
    // fixing the file wants them in.
    const errors: string[] = [];
    const warnings: string[] = [];
    const fail = (m: string) => errors.push(m);
    const warn = (m: string) => warnings.push(m);

    const title = get("title").slice(0, 200);
    // Only a row that will create something needs a name of its own; an update
    // row keeps the name already on the activity.
    if (!title && !(mode === "update" && get("activityId"))) fail("No activity name");

    // --- identity ---------------------------------------------------------
    const activityId = get("activityId").slice(0, 40) || null;
    let action: ActivityPreviewRow["action"] = "create";

    if (activityId) {
      const key = activityId.toLowerCase();
      if (seenId.has(key)) {
        fail(`Duplicate of row ${seenId.get(key)} — Activity ID "${activityId}" appears twice in this file`);
      } else {
        seenId.set(key, i + 1);
        if (existing.has(key)) {
          if (mode === "update") action = "update";
          else fail(`Activity ID "${activityId}" is already in this schedule — switch to Update mode to refresh it`);
        }
      }
    } else {
      if (mode === "update") warn("No Activity ID — imported as a new activity, not matched");
      const key = title.toLowerCase();
      // Without an id there is nothing definitive to match on, and the same
      // activity name legitimately recurs across WBS branches.
      if (title && seenTitle.has(key)) warn(`Same name as row ${seenTitle.get(key)} — kept as a separate activity`);
      else if (title) seenTitle.set(key, i + 1);
    }

    // --- dates ------------------------------------------------------------
    const date = (field: string, label: string): string | null => {
      const cell = get(field);
      if (!cell) return null;
      const parsed = readDate(cell);
      if (!parsed) { warn(`${label} "${cell.slice(0, 20)}" not understood — left blank`); return null; }
      return parsed;
    };
    const plannedStart = date("plannedStart", "Planned start");
    const plannedFinish = date("plannedFinish", "Planned finish");
    const baselineStart = date("baselineStart", "Baseline start");
    const baselineFinish = date("baselineFinish", "Baseline finish");
    const actualStart = date("actualStart", "Actual start");
    const actualFinish = date("actualFinish", "Actual finish");

    if (plannedStart && plannedFinish && plannedFinish < plannedStart) {
      fail("Planned finish is before planned start");
    }
    if (actualStart && actualFinish && actualFinish < actualStart) {
      fail("Actual finish is before actual start");
    }

    const rawDuration = get("plannedDuration");
    const plannedDuration = rawDuration ? readDuration(rawDuration) : null;
    if (rawDuration && plannedDuration === null) {
      warn(`Duration "${rawDuration.slice(0, 20)}" not understood — left blank`);
    }

    // --- progress and status ---------------------------------------------
    const rawProgress = get("progress");
    const progress = rawProgress ? pct(rawProgress) : null;
    if (rawProgress && progress === null) warn(`Progress "${rawProgress.slice(0, 20)}" not understood — left blank`);
    const status = readStatus(get("status"), progress);
    if (progress === 100 && status !== "completed") {
      warn("100% complete but the status column disagrees — status kept as given");
    }

    // --- WBS --------------------------------------------------------------
    const wbs = get("wbs").slice(0, 60) || null;
    if (wbs && !/^\w+(\.\w+)*$/.test(wbs)) {
      warn(`WBS "${wbs.slice(0, 20)}" isn't a dotted code — kept as text, tree grouping may be off`);
    }

    // --- logic ------------------------------------------------------------
    const predecessors = parseRelationCell(get("predecessors")).map((r) => r.ref);
    const successors = parseRelationCell(get("successors")).map((r) => r.ref);
    if (activityId && (predecessors.includes(activityId) || successors.includes(activityId))) {
      warn("Lists itself as its own predecessor or successor — that link is dropped");
    }

    // --- assignment -------------------------------------------------------
    let assignedTo: string | null = null;
    let assignedToName: string | null = null;
    const who = get("assignedTo");
    if (who) {
      const match = byName.get(who.toLowerCase());
      if (!match) warn(`"${who.slice(0, 40)}" isn't on this project — imported unassigned`);
      else if (!canAssignTo(a, match.id)) fail(`You can't assign work to ${match.name}`);
      else { assignedTo = match.id; assignedToName = match.name; }
    }
    // The preview lets the user re-point an assignee; re-checked here, and
    // again at commit, because the preview is a convenience not an authority.
    if (i + 1 in overrides) {
      const to = overrides[i + 1];
      if (to && !canAssignTo(a, to)) fail("You can't assign work to that person.");
      else {
        assignedTo = to;
        assignedToName = to ? (a.members.find((m) => m.id === to)?.name ?? null) : null;
      }
    }

    const verdict: RowVerdict = errors.length ? "error" : warnings.length ? "warning" : "valid";
    if (verdict === "error") action = "skip";
    counts[verdict]++;
    if (action !== "skip") counts[action]++;

    rows.push({
      line: i + 1, verdict, messages: [...errors, ...warnings], action,
      activityId, title,
      description: get("description").slice(0, 2000) || null,
      wbs, wbsPath: get("wbsPath").slice(0, 400) || null,
      discipline: get("discipline").slice(0, 60) || null,
      location: get("location").slice(0, 120) || null,
      status, progress,
      plannedStart, plannedFinish, baselineStart, baselineFinish,
      actualStart, actualFinish, plannedDuration,
      predecessors, successors,
      notes: get("notes").slice(0, 2000) || null,
      assignedTo, assignedToName,
    });
  }

  const fatal = raw.length - 1 > MAX_IMPORT_ROWS
    ? `The file has ${raw.length - 1} rows; only the first ${MAX_IMPORT_ROWS} were read.`
    : undefined;
  return { rows, counts, mappedColumns, mappedFields, fatal };
}

export type ScheduleCommitResult = {
  importId: string;
  created: number;
  updated: number;
  skipped: number;
  assigned: number;
  relationsMade: number;
  unresolvedRefs: string[];   // logic links naming an activity we never saw
  reasons: string[];
  truncated?: string;
};

const insertActivity = db.prepare(`INSERT INTO tasks
  (id, project_id, ref, title, description, status, priority, progress,
   wbs, wbs_path, wbs_level, discipline, location,
   start_date, due_date, baseline_start, baseline_finish, actual_start, actual_finish,
   planned_duration, actual_duration, notes, origin, import_id,
   assigned_to, assigned_by, created_by, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const chainRow = db.prepare(`INSERT INTO task_assignments
  (id, task_id, assigned_to, assigned_by, parent_assignment_id, assignment_type, source, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

const headOfChain = db.prepare(
  "SELECT id FROM task_assignments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
);
const currentAssignee = db.prepare("SELECT assigned_to FROM tasks WHERE id = ?");
const setAssignee = db.prepare(
  "UPDATE tasks SET assigned_to = ?, assigned_by = ?, updated_at = ? WHERE id = ? AND project_id = ?"
);
const bumpSeq = db.prepare("UPDATE projects SET task_seq = task_seq + 1 WHERE id = ? RETURNING task_seq");
const refTaken = db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND ref = ?");
const countActivities = db.prepare("SELECT count(*) c FROM tasks WHERE project_id = ?");

/**
 * Writes an analyzed schedule.
 *
 * Three passes inside one transaction:
 *
 *   1. create or update every non-error row, recording the Activity ID it landed on
 *   2. resolve predecessor/successor refs against the whole project, not just this file,
 *      so a link into last week's import still connects
 *   3. write the import record
 *
 * All of it is one unit. A schedule that half-imported would be worse than one
 * that did not import at all: the WBS would have holes, the logic would dangle,
 * and there would be no way to tell how far it got.
 */
export function commitSchedule(
  a: Actor, raw: string[][], opts: {
    mapping?: ColumnMap;
    mode?: "create" | "update";
    overrides?: Record<number, string | null>;
    filename?: string | null;
    sheetName?: string | null;
  } = {}
): ScheduleCommitResult | { error: string } {
  if (!can(a, "create_tasks")) return { error: "Your role can't import a schedule." };

  const mode = opts.mode ?? "create";
  const { rows, mappedFields, fatal } = analyzeSchedule(a, raw, opts.mapping, mode, opts.overrides ?? {});
  if (fatal && !rows.length) return { error: fatal };

  const reasons = new Map<string, number>();
  const note = (why: string) => reasons.set(why, (reasons.get(why) ?? 0) + 1);

  const importId = newId();
  let created = 0, updated = 0, skipped = 0, assigned = 0, relationsMade = 0;
  const unresolved = new Set<string>();

  try {
    tx(() => {
      const room = MAX_ACTIVITIES - (countActivities.get(a.projectId) as { c: number }).c;
      // Activity ID -> row id, for pass 2. Seeded with everything already in the
      // project so links can point at activities from an earlier import.
      const byRef = new Map(
        (q.refMap.all(a.projectId) as { id: string; ref: string }[])
          .map((r) => [r.ref.toLowerCase(), r.id])
      );
      const t = now();

      // --- pass 1: rows -------------------------------------------------
      for (const r of rows) {
        if (r.action === "skip") { skipped++; note(r.messages[0] ?? "Row had errors"); continue; }

        if (r.action === "update") {
          const id = byRef.get((r.activityId ?? "").toLowerCase());
          if (!id) { skipped++; note("Activity vanished between preview and import"); continue; }
          const before = getActivity(id, a.projectId);
          if (!before) { skipped++; note("Activity vanished between preview and import"); continue; }

          // Only columns the file actually carries are written. A mapped column
          // that happens to be blank *does* clear the field — that is an
          // explicit instruction; an absent column is not.
          const keep = <T,>(field: string, incoming: T, existing: T) =>
            mappedFields.has(field) ? incoming : existing;

          const wbs = keep("wbs", r.wbs, before.wbs);
          q.updateSchedule.run(
            keep("title", r.title, before.title),
            keep("description", r.description, before.description),
            // Status is inferred from progress when the file has neither, so it
            // is only written when one of the two was actually supplied.
            mappedFields.has("status") || mappedFields.has("progress") ? r.status : before.status,
            before.priority,
            keep("progress", r.progress ?? 0, before.progress),
            wbs, keep("wbsPath", r.wbsPath, before.wbs_path), wbsLevel(wbs),
            keep("discipline", r.discipline, before.discipline),
            keep("location", r.location, before.location),
            keep("plannedStart", r.plannedStart, before.start_date),
            keep("plannedFinish", r.plannedFinish, before.due_date),
            keep("baselineStart", r.baselineStart, before.baseline_start),
            keep("baselineFinish", r.baselineFinish, before.baseline_finish),
            keep("actualStart", r.actualStart, before.actual_start),
            keep("actualFinish", r.actualFinish, before.actual_finish),
            keep("plannedDuration", r.plannedDuration, before.planned_duration),
            before.actual_duration,
            keep("notes", r.notes, before.notes),
            t, id, a.projectId
          );
          q.stampImport.run("import", importId, id);
          if (applyAssignee(a, id, r.assignedTo, t)) assigned++;
          updated++;
          continue;
        }

        if (created >= room) { skipped++; note(`Project limit of ${MAX_ACTIVITIES} activities reached`); continue; }

        const id = newId();
        // A ref the file supplied is kept only while it is genuinely free; the
        // unique index would otherwise abort the whole batch on one clash.
        const ref = r.activityId && !refTaken.get(a.projectId, r.activityId)
          ? r.activityId
          : nextRef(a.projectId, a.projectCode);

        insertActivity.run(
          id, a.projectId, ref, r.title, r.description, r.status, "medium", r.progress ?? 0,
          r.wbs, r.wbsPath, wbsLevel(r.wbs), r.discipline, r.location,
          r.plannedStart, r.plannedFinish, r.baselineStart, r.baselineFinish,
          r.actualStart, r.actualFinish, r.plannedDuration, null, r.notes,
          "import", importId,
          r.assignedTo, r.assignedTo ? a.personId : null, a.personId, t, t
        );
        if (r.assignedTo) {
          // An assignee the importer worked out from a name is a real
          // assignment, so it opens the chain — marked `auto` so it stays
          // distinguishable from one a person chose.
          chainRow.run(newId(), id, r.assignedTo, a.personId, null, "initial", "auto", t);
          assigned++;
        }
        if (ref) byRef.set(ref.toLowerCase(), id);
        if (r.activityId) byRef.set(r.activityId.toLowerCase(), id);
        created++;
      }

      // --- pass 2: logic ------------------------------------------------
      for (const r of rows) {
        if (r.action === "skip") continue;
        const selfId = byRef.get((r.activityId ?? "").toLowerCase());
        if (!selfId) continue;

        for (const raw of r.predecessors) {
          const other = byRef.get(raw.toLowerCase());
          if (!other) { unresolved.add(raw); continue; }
          if (other === selfId) continue;
          relationsMade += Number(q.addRelation.run(newId(), a.projectId, other, selfId, "FS", 0, t).changes);
        }
        for (const raw of r.successors) {
          const other = byRef.get(raw.toLowerCase());
          if (!other) { unresolved.add(raw); continue; }
          if (other === selfId) continue;
          relationsMade += Number(q.addRelation.run(newId(), a.projectId, selfId, other, "FS", 0, t).changes);
        }
      }

      // --- pass 3: provenance -------------------------------------------
      q.addImport.run(importId, a.projectId, a.userId, opts.filename ?? null,
        opts.sheetName ?? null, mode,
        opts.mapping ? JSON.stringify(opts.mapping) : null,
        rows.length, created, updated, skipped, relationsMade, t);

      q.event.run(a.projectId, null, "schedule_imported", a.personId,
        `${created} new, ${updated} updated, ${relationsMade} logic links`, t);
    });
  } catch (e) {
    return { error: `The import failed and nothing was saved. ${(e as Error).message}` };
  }

  return {
    importId, created, updated, skipped, assigned, relationsMade,
    unresolvedRefs: [...unresolved].slice(0, 20),
    reasons: [...reasons].map(([why, n]) => (n > 1 ? `${why} (${n} rows)` : why)),
    truncated: fatal,
  };
}

/**
 * Points an existing activity at a new assignee during an update import.
 *
 * Goes through the same append-only chain a manual reassignment does, so a
 * re-issued schedule that moves work between crews leaves the same trail.
 * Returns whether anything actually changed.
 */
function applyAssignee(a: Actor, activityId: string, to: string | null, t: number): boolean {
  const current = (currentAssignee.get(activityId) as { assigned_to: string | null }).assigned_to;
  if (to === null || to === current) return false;
  const parent = headOfChain.get(activityId) as { id: string } | undefined;
  setAssignee.run(to, a.personId, t, activityId, a.projectId);
  chainRow.run(newId(), activityId, to, a.personId, parent?.id ?? null,
    current ? "reassigned" : "initial", "auto", t);
  return true;
}

/** Generated Activity ID, for a row the file gave no id of its own. */
function nextRef(projectId: string, code: string | null): string {
  const stem = (code ?? "ACT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "ACT";
  for (let tries = 0; tries < 1000; tries++) {
    const seq = (bumpSeq.get(projectId) as { task_seq: number }).task_seq;
    const ref = `${stem}-${String(seq).padStart(4, "0")}`;
    if (!refTaken.get(projectId, ref)) return ref;
  }
  return `${stem}-${newId().slice(0, 8)}`;
}

/**
 * Creates one activity by hand.
 *
 * Delegates the identity, permission, ref and chain work to `createTask` — the
 * same path the New Task form has always used — then applies the schedule
 * fields. One transaction, so an activity never exists without them.
 */
export function createActivity(
  a: Actor, d: { title: unknown; assignedTo?: unknown } & ActivityPatch
): { ok: true; id: string } | { error: string } {
  let out: { ok: true; id: string } | { error: string } = { error: "Nothing was created." };
  try {
    tx(() => {
      const made = createTask(a, {
        title: d.title,
        description: d.description,
        status: d.status,
        priority: d.priority,
        progress: d.progress,
        startDate: d.plannedStart,
        dueDate: d.plannedFinish,
        assignedTo: d.assignedTo,
      });
      if ("error" in made) { out = made; return; }
      const patched = updateActivity(a, made.id, { ...d, title: d.title });
      if ("error" in patched) { out = patched; throw new Error(patched.error); }
      q.stampImport.run("manual", null, made.id);
      out = { ok: true, id: made.id };
    });
  } catch {
    // The transaction rolled back; `out` already carries the reason.
  }
  return out;
}
