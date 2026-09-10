import "server-only";
import { randomBytes } from "node:crypto";
import { db, now, tx } from "./db.ts";
import { cleanEmail, cleanPhone, cleanName } from "./auth.ts";
// Type-only, so this does not close the import cycle with tasks.ts at runtime.
import type { EventKind } from "./tasks.ts";

/**
 * Project-level audit line. Shares `task_events` with the task mutations —
 * it is one feed of "what happened on this project", and splitting people
 * changes into a second table would only mean merging them again on read.
 */
const evq = db.prepare(
  "INSERT INTO task_events (project_id, task_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)"
);
const logPeopleEvent = (projectId: string, kind: EventKind, actor: string | null, detail: string) =>
  evq.run(projectId, null, kind, actor, detail, now());

export type Project = {
  id: string; owner_id: string; name: string; code: string | null;
  description: string | null; location: string | null; client: string | null;
  start_date: string | null; planned_completion: string | null;
  created_at: number;
};

export type ProjectDraft = {
  name: unknown; code?: unknown; description?: unknown;
  location?: unknown; client?: unknown;
  startDate?: unknown; plannedCompletion?: unknown;
};

/** A person as they appear inside one project: identity + placement. */
export type Member = {
  id: string;            // person id
  hierarchy_level: number | null;   // 1 = reports to the account owner
  name: string;
  phone: string | null;
  email: string | null;
  discipline: string | null;
  user_id: string | null;        // set once they've signed up with this email
  role: string | null;           // free-text job title, per-project
  role_id: string | null;        // permission role, per-project
  parent_person_id: string | null;
};

export type Node = Member & { children: Node[]; depth: number };

export const MAX_ROWS = 500;
export const MAX_CSV_BYTES = 512 * 1024;
export const MAX_PROJECTS = 40;
const MAX_DEPTH = 10;

const newId = () => randomBytes(12).toString("hex");

// ---------------------------------------------------------------- projects

const pq = {
  insert: db.prepare(`INSERT INTO projects
    (id, owner_id, name, code, description, location, client, start_date, planned_completion, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  byOwner: db.prepare("SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at"),
  one: db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?"),
  count: db.prepare("SELECT count(*) c FROM projects WHERE owner_id = ?"),
  del: db.prepare("DELETE FROM projects WHERE id = ? AND owner_id = ?"),
};

export const listProjects = (ownerId: string) => pq.byOwner.all(ownerId) as Project[];
/** Scoped read — a project id from another account simply doesn't match. */
export const getProject = (id: string, ownerId: string) =>
  (pq.one.get(id, ownerId) as Project | undefined) ?? null;

const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export function createProject(ownerId: string, d: ProjectDraft):
  { ok: true; id: string } | { error: string } {
  const n = cleanName(d.name);
  if (!n) return { error: "Give the project a name." };
  if ((pq.count.get(ownerId) as { c: number }).c >= MAX_PROJECTS) {
    return { error: `You've reached the ${MAX_PROJECTS}-project limit.` };
  }

  // Dates are validated the same way task dates are, so a typo here can't land
  // an unparseable value in the row.
  const asDate = (v: unknown, label: string): string | null | { error: string } => {
    if (typeof v !== "string" || !v.trim()) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : { error: `That ${label} isn't a valid date.` };
  };
  const start = asDate(d.startDate, "start date");
  if (start && typeof start === "object") return start;
  const finish = asDate(d.plannedCompletion, "planned completion date");
  if (finish && typeof finish === "object") return finish;
  if (start && finish && finish < start) {
    return { error: "Planned completion is before the start date." };
  }

  const id = newId();
  try {
    pq.insert.run(id, ownerId, n, text(d.code, 40), text(d.description, 500),
      text(d.location, 120), text(d.client, 120), start, finish, now());
  } catch {
    return { error: "You already have a project with that name." };
  }
  return { ok: true, id };
}

export function deleteProject(id: string, ownerId: string): boolean {
  // Memberships cascade; the people themselves stay on the roster.
  return getProject(id, ownerId) ? (pq.del.run(id, ownerId), true) : false;
}

// ---------------------------------------------------------------- roster

const rq = {
  insert: db.prepare("INSERT INTO people (id, owner_id, parent_id, name, phone, email, role, discipline, created_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)"),
  byId: db.prepare("SELECT * FROM people WHERE id = ? AND owner_id = ?"),
  byPhone: db.prepare("SELECT * FROM people WHERE owner_id = ? AND phone IS NOT NULL AND phone = ?"),
  byName: db.prepare("SELECT * FROM people WHERE owner_id = ? AND lower(name) = lower(?)"),
  all: db.prepare("SELECT * FROM people WHERE owner_id = ? ORDER BY name"),
};

export type RosterPerson = {
  id: string; name: string; phone: string | null; email: string | null;
  discipline: string | null; user_id: string | null;
};
export const listRoster = (ownerId: string) => rq.all.all(ownerId) as RosterPerson[];

const lq = {
  claimable: db.prepare("SELECT id FROM people WHERE lower(email) = lower(?) AND user_id IS NULL"),
  link: db.prepare("UPDATE people SET user_id = ? WHERE id = ? AND user_id IS NULL"),
  byUser: db.prepare("SELECT * FROM people WHERE user_id = ?"),
};

/**
 * Ties a person record to a login account by matching the email their manager
 * entered. This is what lets someone added to the tree actually sign in and see
 * their own tasks — without it the hierarchy would be records only.
 *
 * Safe to call repeatedly: it only ever fills a NULL user_id.
 */
export function linkPersonToUser(userId: string, email: string): number {
  let linked = 0;
  for (const row of lq.claimable.all(email) as { id: string }[]) {
    linked += lq.link.run(userId, row.id).changes ? 1 : 0;
  }
  return linked;
}

export const personRecordsFor = (userId: string) => lq.byUser.all(userId) as RosterPerson[];

// ---------------------------------------------------------------- membership

const mq = {
  place: db.prepare("INSERT INTO memberships (project_id, person_id, parent_person_id, role, created_at) VALUES (?, ?, ?, ?, ?)"),
  members: db.prepare(`
    SELECT p.id, p.name, p.phone, p.email, p.discipline, p.user_id,
           m.role, m.parent_person_id, m.role_id, m.hierarchy_level
    FROM memberships m JOIN people p ON p.id = m.person_id
    WHERE m.project_id = ? ORDER BY p.name`),
  setRole: db.prepare("UPDATE memberships SET role_id = ? WHERE project_id = ? AND person_id = ?"),
  setLevel: db.prepare("UPDATE memberships SET hierarchy_level = ? WHERE project_id = ? AND person_id = ?"),
  rawLinks: db.prepare("SELECT person_id, parent_person_id FROM memberships WHERE project_id = ?"),
  one: db.prepare("SELECT * FROM memberships WHERE project_id = ? AND person_id = ?"),
  count: db.prepare("SELECT count(*) c FROM memberships WHERE project_id = ?"),
  setParent: db.prepare("UPDATE memberships SET parent_person_id = ? WHERE project_id = ? AND person_id = ?"),
  reparentChildren: db.prepare("UPDATE memberships SET parent_person_id = ? WHERE project_id = ? AND parent_person_id = ?"),
  remove: db.prepare("DELETE FROM memberships WHERE project_id = ? AND person_id = ?"),
};

/**
 * The few task columns membership lifecycle has to touch. Deliberately local:
 * tasks.ts already imports this module, so importing it back would close a
 * cycle for the sake of three statements.
 */
const tq = {
  heldBy: db.prepare("SELECT id, title FROM tasks WHERE project_id = ? AND assigned_to = ?"),
  unassign: db.prepare("UPDATE tasks SET assigned_to = NULL, assigned_by = NULL, updated_at = ? WHERE id = ? AND project_id = ?"),
  head: db.prepare("SELECT id FROM task_assignments WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
  chain: db.prepare(`INSERT INTO task_assignments
    (id, task_id, assigned_to, assigned_by, parent_assignment_id, assignment_type, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
};

export const listMembers = (projectId: string) => mq.members.all(projectId) as Member[];
export const countMembers = (projectId: string) => (mq.count.get(projectId) as { c: number }).c;
export const isMember = (projectId: string, personId: string) =>
  Boolean(mq.one.get(projectId, personId));

export type Draft = {
  name: string; phone?: string | null; email?: string | null;
  role?: string | null; discipline?: string | null;
  parentId?: string | null; roleId?: string | null;
  /** Who is doing this, for the audit line. Optional — the owner has no person row. */
  actorPersonId?: string | null;
};

/** Permission role for one person on one project. */
export function setMemberRole(
  projectId: string, personId: string, roleId: string | null, actorPersonId: string | null = null
): void {
  const before = (mq.one.get(projectId, personId) as { role_id: string | null } | undefined)?.role_id ?? null;
  if (before === roleId) return;                       // no-op, nothing to record
  tx(() => {
    mq.setRole.run(roleId, projectId, personId);
    const name = (db.prepare("SELECT name FROM people WHERE id = ?").get(personId) as { name: string } | undefined)?.name ?? "Someone";
    const role = roleId
      ? (db.prepare("SELECT name FROM roles WHERE id = ?").get(roleId) as { name: string } | undefined)?.name ?? "a custom role"
      : "no role";
    logPeopleEvent(projectId, "role_changed", actorPersonId, `${name} → ${role}`);
  });
}

const trimTo = (v: unknown, n: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;

/**
 * Adds someone to a project, reusing their roster identity when we already know
 * them — matched on phone first, then exact name. That is what makes "the same
 * person, a different manager on another project" work without retyping them.
 */
export function addMember(ownerId: string, projectId: string, d: Draft):
  { ok: true; id: string } | { error: string } {
  if (!getProject(projectId, ownerId)) return { error: "That project isn't yours." };

  const name = cleanName(d.name);
  if (!name) return { error: "Every person needs a name." };
  if (countMembers(projectId) >= MAX_ROWS) return { error: `This project has hit the ${MAX_ROWS}-person limit.` };

  const phone = d.phone ? cleanPhone(d.phone) : null;
  if (d.phone && !phone) return { error: `"${String(d.phone).slice(0, 20)}" isn't a valid phone number.` };
  const email = d.email ? cleanEmail(d.email) : null;
  if (d.email && !email) return { error: `"${String(d.email).slice(0, 30)}" isn't a valid email.` };

  // A parent from the client is only trusted after confirming they're in THIS project.
  let parentId: string | null = null;
  if (d.parentId) {
    if (!isMember(projectId, d.parentId)) return { error: "That manager isn't on this project." };
    if (depthOf(d.parentId, listMembers(projectId)) >= MAX_DEPTH) {
      return { error: `The chain can't go deeper than ${MAX_DEPTH} levels.` };
    }
    parentId = d.parentId;
  }

  const existing =
    (phone ? (rq.byPhone.get(ownerId, phone) as RosterPerson | undefined) : undefined) ??
    (rq.byName.get(ownerId, name) as RosterPerson | undefined);

  let personId: string;
  if (existing) {
    personId = existing.id;
    if (isMember(projectId, personId)) return { error: `${name} is already on this project.` };
  } else {
    personId = newId();
  }

  const isNew = !existing;
  tx(() => {
    if (isNew) rq.insert.run(personId, ownerId, name, phone, email, trimTo(d.discipline, 60), now());
    mq.place.run(projectId, personId, parentId, trimTo(d.role, 60), now());
    if (d.roleId) mq.setRole.run(d.roleId, projectId, personId);
    recomputeLevels(projectId);
    logPeopleEvent(projectId, "person_added", d.actorPersonId ?? null,
      parentId ? `${name} added under an existing member` : `${name} added at top level`);
  });
  return { ok: true, id: personId };
}

/** Removes someone from ONE project. Their reports move up a level; the person
 *  stays on the roster and keeps any placement on other projects. */
export function removeMember(
  projectId: string, personId: string, ownerId: string, actorPersonId: string | null = null
): { ok: true; released: number } | { error: string } {
  if (!getProject(projectId, ownerId)) return { error: "That project isn't yours." };
  const row = mq.one.get(projectId, personId) as { parent_person_id: string | null } | undefined;
  if (!row) return { error: "That person isn't on this project." };
  const name = (rq.byId.get(personId, ownerId) as { name: string } | undefined)?.name ?? "Someone";

  let released = 0;
  tx(() => {
    // Order matters. Releasing has to happen while they are still a member,
    // because the assignee guard trigger checks membership on write — and
    // leaving the tasks pointing at a non-member is exactly the orphan the
    // trigger exists to prevent.
    released = releaseTasksOf(projectId, personId, actorPersonId);
    mq.reparentChildren.run(row.parent_person_id, projectId, personId);
    mq.remove.run(projectId, personId);
    recomputeLevels(projectId);
    logPeopleEvent(projectId, "person_removed", actorPersonId,
      released ? `${name} removed — ${released} task${released === 1 ? "" : "s"} returned to the pool`
               : `${name} removed from the project`);
  });
  return { ok: true, released };
}

/**
 * Hand back every task someone holds on this project.
 *
 * Appends to the assignment chain rather than blanking the column, so the
 * history still explains where the work went and why.
 */
function releaseTasksOf(projectId: string, personId: string, actorPersonId: string | null): number {
  const held = tq.heldBy.all(projectId, personId) as { id: string; title: string }[];
  const t = now();
  for (const task of held) {
    const parent = tq.head.get(task.id) as { id: string } | undefined;
    tq.unassign.run(t, task.id, projectId);
    tq.chain.run(newId(), task.id, null, actorPersonId, parent?.id ?? null, "unassigned", "manual", t);
    evq.run(projectId, task.id, "unassigned", actorPersonId,
      `${task.title} — assignee left the project`, t);
  }
  return held.length;
}

/**
 * Re-parent within one project.
 *
 * Cycle guard is the whole point: without it you can put someone under their own
 * report, and buildTree would then drop that entire branch — the people would
 * silently vanish from the page rather than error.
 */
export function setManager(
  projectId: string, personId: string, newParentId: string | null, ownerId: string,
  actorPersonId: string | null = null
): { ok: true } | { error: string } {
  if (!getProject(projectId, ownerId)) return { error: "That project isn't yours." };
  if (!isMember(projectId, personId)) return { error: "That person isn't on this project." };

  if (newParentId) {
    if (newParentId === personId) return { error: "Someone can't report to themselves." };
    if (!isMember(projectId, newParentId)) return { error: "That manager isn't on this project." };

    const members = listMembers(projectId);
    if (descendantsOf(personId, members).has(newParentId)) {
      return { error: "That would create a loop — they already report to this person." };
    }
    // Depth of the new parent, plus the branch hanging off the person.
    if (depthOf(newParentId, members) + 1 + heightOf(personId, members) > MAX_DEPTH) {
      return { error: `That would push the chain past ${MAX_DEPTH} levels.` };
    }
  }

  const who = (rq.byId.get(personId, ownerId) as { name: string } | undefined)?.name ?? "Someone";
  const boss = newParentId
    ? (rq.byId.get(newParentId, ownerId) as { name: string } | undefined)?.name ?? "another member"
    : null;

  tx(() => {
    mq.setParent.run(newParentId, projectId, personId);
    recomputeLevels(projectId);
    logPeopleEvent(projectId, "person_moved", actorPersonId,
      boss ? `${who} now reports to ${boss}` : `${who} moved to top level`);
  });
  return { ok: true };
}

function depthOf(id: string, members: Member[]): number {
  const byId = new Map(members.map((m) => [m.id, m]));
  let d = 0, cur = byId.get(id);
  while (cur?.parent_person_id && d <= MAX_DEPTH + 1) { cur = byId.get(cur.parent_person_id); d++; }
  return d;
}

/** Longest chain hanging below someone. */
function heightOf(id: string, members: Member[]): number {
  const kids = members.filter((m) => m.parent_person_id === id);
  return kids.length ? 1 + Math.max(...kids.map((k) => heightOf(k.id, members))) : 0;
}

export function descendantsOf(id: string, members: Member[]): Set<string> {
  const out = new Set<string>();
  const walk = (pid: string) => {
    for (const m of members) {
      if (m.parent_person_id === pid && !out.has(m.id)) { out.add(m.id); walk(m.id); }
    }
  };
  walk(id);
  return out;
}

/** Who this person may legally be moved under: anyone but themselves and their
 *  own descendants. Used to build the picker, so the UI can't offer a loop. */
export function validManagers(personId: string, members: Member[]): Member[] {
  const banned = descendantsOf(personId, members);
  banned.add(personId);
  return members.filter((m) => !banned.has(m.id));
}

/**
 * Recomputes every stored depth in a project.
 *
 * Depth is derived from `parent_person_id`, so it is written rather than typed —
 * spec section 7. It is stored (not computed on read) so it can be queried and
 * displayed cheaply, and refreshed after anything that reshapes the tree.
 * Anyone caught in a cycle keeps a null level rather than looping forever.
 */
export function recomputeLevels(projectId: string): void {
  const links = mq.rawLinks.all(projectId) as { person_id: string; parent_person_id: string | null }[];
  const parent = new Map(links.map((l) => [l.person_id, l.parent_person_id]));

  const level = new Map<string, number | null>();
  const resolve = (id: string, seen: Set<string>): number | null => {
    if (level.has(id)) return level.get(id)!;
    if (seen.has(id)) return null;                 // cycle — leave it unranked
    seen.add(id);
    const up = parent.get(id) ?? null;
    const value = up === null || !parent.has(up) ? 1 : (() => {
      const d = resolve(up, seen);
      return d === null ? null : d + 1;
    })();
    level.set(id, value);
    return value;
  };

  for (const { person_id } of links) resolve(person_id, new Set());
  for (const [id, d] of level) mq.setLevel.run(d, projectId, id);
}

// ---------------------------------------------------------------- tree

export function buildTree(members: Member[]): Node[] {
  const byId = new Map<string, Node>();
  for (const m of members) byId.set(m.id, { ...m, children: [], depth: 0 });

  const roots: Node[] = [];
  const seen = new Set<string>();
  for (const node of byId.values()) {
    const parent = node.parent_person_id ? byId.get(node.parent_person_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);            // a dangling parent degrades to a root
  }

  const sort = (nodes: Node[], depth: number) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) { n.depth = depth; seen.add(n.id); sort(n.children, depth + 1); }
  };
  sort(roots, 0);

  // Belt and braces: anyone stranded by a cycle is surfaced at the top rather
  // than silently disappearing. setManager should make this unreachable.
  for (const node of byId.values()) {
    if (!seen.has(node.id)) { node.depth = 0; node.children = []; roots.push(node); }
  }
  return roots;
}

export function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

// ---------------------------------------------------------------- CSV

/**
 * RFC4180-ish parser: quoted fields, escaped quotes, embedded commas and
 * newlines, CRLF or LF. Written out rather than pulled in as a dependency —
 * it's twenty lines and the alternative is a supply chain for one function.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const ALIASES: Record<string, string> = {
  name: "name", "full name": "name", person: "name", employee: "name",
  phone: "phone", mobile: "phone", "phone number": "phone", contact: "phone", number: "phone",
  email: "email", "e-mail": "email", "email address": "email",
  role: "role", designation: "role", title: "role", position: "role",
  discipline: "discipline", trade: "discipline", department: "discipline", dept: "discipline",
  "reports to": "reportsTo", manager: "reportsTo", "reports_to": "reportsTo",
  supervisor: "reportsTo", "reporting manager": "reportsTo",
};

export type ImportResult = { added: number; skipped: { row: number; why: string }[] };

export function importRows(ownerId: string, projectId: string, rows: string[][]): ImportResult {
  const skipped: { row: number; why: string }[] = [];
  if (!rows.length) return { added: 0, skipped: [{ row: 0, why: "The file was empty." }] };

  const header = rows[0].map((h) => ALIASES[h.trim().toLowerCase()] ?? "");
  if (!header.includes("name")) {
    return { added: 0, skipped: [{ row: 1, why: "No 'name' column found in the header row." }] };
  }

  const byName = new Map<string, string>();
  for (const m of listMembers(projectId)) byName.set(m.name.toLowerCase(), m.id);

  let added = 0;
  for (let i = 1; i < rows.length && i <= MAX_ROWS; i++) {
    const cells = rows[i];
    const get = (k: string) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };

    const name = get("name");
    if (!name) { skipped.push({ row: i + 1, why: "No name" }); continue; }

    const managerName = get("reportsTo").toLowerCase();
    const parentId = managerName ? (byName.get(managerName) ?? null) : null;
    if (managerName && !parentId) {
      skipped.push({ row: i + 1, why: `Manager "${get("reportsTo")}" not found — added at top level` });
    }

    const res = addMember(ownerId, projectId, {
      name, phone: get("phone") || null, email: get("email") || null,
      role: get("role") || null, discipline: get("discipline") || null, parentId,
    });
    if ("error" in res) { skipped.push({ row: i + 1, why: res.error }); continue; }

    byName.set(name.toLowerCase(), res.id);
    added++;
  }

  if (rows.length - 1 > MAX_ROWS) {
    skipped.push({ row: MAX_ROWS + 1, why: `Only the first ${MAX_ROWS} rows were read.` });
  }
  return { added, skipped };
}

// ---------------------------------------------------------------- people import preview

import type { PersonPreviewRow, RowVerdict } from "./import-types.ts";

export const PEOPLE_FIELDS = [
  ["", "— ignore"],
  ["name", "Name"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["title", "Job title"],
  ["discipline", "Discipline"],
  ["reportsTo", "Reports to"],
] as const;

const PEOPLE_ALIASES: Record<string, string> = {
  name: "name", "full name": "name", person: "name", employee: "name", "l3 owner": "name",
  phone: "phone", mobile: "phone", "phone number": "phone", contact: "phone", number: "phone",
  email: "email", "e-mail": "email", "email address": "email",
  role: "title", designation: "title", title: "title", position: "title", "l3 role": "title",
  discipline: "discipline", trade: "discipline", department: "discipline", dept: "discipline",
  "reports to": "reportsTo", manager: "reportsTo", reports_to: "reportsTo",
  supervisor: "reportsTo", "reporting manager": "reportsTo", "direct supervisor": "reportsTo",
};

export function guessPeopleMapping(header: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  const taken = new Set<string>();
  header.forEach((h, i) => {
    const f = PEOPLE_ALIASES[h.trim().toLowerCase()];
    if (f && !taken.has(f)) { map[i] = f; taken.add(f); }
  });
  return map;
}

/**
 * Validates a people upload without writing anything — spec section 8.
 *
 * `defaultParentId` is whoever is doing the importing, so a row with no
 * "Reports to" lands under them rather than being rejected.
 */
export function analyzePeopleRows(
  ownerId: string, projectId: string, raw: string[][],
  defaultParentId: string | null,
  inScope: (personId: string) => boolean,
  mapping?: Record<number, string>
): { rows: PersonPreviewRow[]; counts: Record<RowVerdict, number>; fatal?: string } {
  const empty = { rows: [], counts: { valid: 0, warning: 0, error: 0 } };
  if (!raw.length) return { ...empty, fatal: "The file was empty." };

  const map = mapping ?? guessPeopleMapping(raw[0]);
  const header: string[] = [];
  for (const [i, f] of Object.entries(map)) header[Number(i)] = f;
  if (!header.includes("name")) {
    return { ...empty, fatal: "No column is mapped to Name. Pick one in the mapping step." };
  }

  const existing = listMembers(projectId);
  const byName = new Map(existing.map((m) => [m.name.toLowerCase(), m.id]));
  const byPhone = new Map(existing.filter((m) => m.phone).map((m) => [m.phone!, m.id]));

  const nameCol = header.indexOf("name");
  // Pre-scan every name in the file. Without this, "reports to" could only
  // point *backwards*, so a manager listed below their report was rejected as
  // unknown — and a genuine loop was never reached.
  const inFile = new Set<string>();
  for (let i = 1; i < raw.length && i <= MAX_ROWS; i++) {
    const n = (raw[i]?.[nameCol] ?? "").trim().toLowerCase();
    if (n) inFile.add(n);
  }

  const rows: PersonPreviewRow[] = [];
  const counts: Record<RowVerdict, number> = { valid: 0, warning: 0, error: 0 };
  const seenInFile = new Map<string, number>();       // lower(name) → line

  for (let i = 1; i < raw.length && i <= MAX_ROWS; i++) {
    const cells = raw[i];
    const get = (k: string) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };

    const messages: string[] = [];
    let verdict: RowVerdict = "valid";
    const fail = (m: string) => { messages.push(m); verdict = "error"; };
    const warn = (m: string) => { messages.push(m); if (verdict === "valid") verdict = "warning"; };

    const name = cleanName(get("name")) ?? "";
    if (!name) fail("No name");

    const key = name.toLowerCase();
    if (name && seenInFile.has(key)) fail(`Duplicate of row ${seenInFile.get(key)} in this file`);
    else if (name) seenInFile.set(key, i + 1);

    const rawPhone = get("phone");
    const phone = rawPhone ? cleanPhone(rawPhone) : null;
    if (rawPhone && !phone) fail(`"${rawPhone.slice(0, 20)}" isn't a valid phone number`);

    const rawEmail = get("email");
    const email = rawEmail ? cleanEmail(rawEmail) : null;
    if (rawEmail && !email) fail(`"${rawEmail.slice(0, 30)}" isn't a valid email`);

    if (name && byName.has(key)) fail(`${name} is already on this project`);
    else if (phone && byPhone.has(phone)) warn("Matches someone already on the roster — they'll be reused");

    const rawParent = get("reportsTo");
    let reportsToId: string | null = null;
    let reportsToName: string | null = null;

    if (rawParent) {
      reportsToName = rawParent;
      const found = byName.get(rawParent.toLowerCase());
      if (found) {
        reportsToId = found;
        if (!inScope(found)) fail(`You can't add people under ${rawParent}`);
      } else if (!inFile.has(rawParent.toLowerCase())) {
        fail(`Manager "${rawParent}" isn't on this project or in this file`);
      }
      // else: another row in this file — wired up during the commit pass
    } else {
      reportsToId = defaultParentId;
      if (!defaultParentId) reportsToName = null;
    }

    counts[verdict]++;
    rows.push({
      line: i + 1, verdict, messages, name,
      phone, email,
      title: get("title") || null,
      discipline: get("discipline") || null,
      reportsToRaw: rawParent || null,
      reportsToId, reportsToName,
    });
  }

  // A cycle can only be formed by rows naming each other, so walk the proposed
  // edges once the whole file is known.
  // Cycles can only be judged once every row is known, so this runs last and
  // the tally is taken afterwards.
  flagCycles(rows);
  const recount: Record<RowVerdict, number> = { valid: 0, warning: 0, error: 0 };
  for (const r of rows) recount[r.verdict]++;
  void counts;

  const fatal = raw.length - 1 > MAX_ROWS ? `Only the first ${MAX_ROWS} rows were read.` : undefined;
  return { rows, counts: recount, fatal };
}

/** Marks every row caught in a reports-to loop within the uploaded file. */
function flagCycles(rows: PersonPreviewRow[]): void {
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));

  for (const start of rows) {
    if (start.verdict === "error") continue;
    const seen = new Set<string>([start.name.toLowerCase()]);
    let cur = start;
    while (cur.reportsToRaw) {
      const nextKey = cur.reportsToRaw.toLowerCase();
      const next = byName.get(nextKey);
      if (!next) break;                       // resolves to an existing member — no loop
      if (seen.has(nextKey)) {
        start.verdict = "error";
        start.messages.push(`Circular reporting line via "${cur.reportsToRaw}"`);
        break;
      }
      seen.add(nextKey);
      cur = next;
    }
  }
}

export type PeopleCommitResult = {
  added: number;
  skipped: number;
  linked: number;          // rows wired to a manager named in the same file
  reasons: string[];
  truncated?: string;
};

/**
 * Writes an analyzed people file.
 *
 * Two passes, because a file may name a manager listed below their own report:
 * create everyone first, then wire the in-file reporting lines. The whole thing
 * is one transaction — a half-imported team with dangling managers was the worst
 * failure mode this had, since the tree silently drops branches it can't root.
 */
export function commitPeopleRows(
  ownerId: string, projectId: string, raw: string[][],
  defaultParentId: string | null,
  inScope: (personId: string) => boolean,
  mapping?: Record<number, string>,
  actorPersonId: string | null = null
): PeopleCommitResult | { error: string } {
  const { rows, fatal } = analyzePeopleRows(ownerId, projectId, raw, defaultParentId, inScope, mapping);
  if (fatal && !rows.length) return { error: fatal };

  const reasons = new Map<string, number>();
  const note = (why: string) => reasons.set(why, (reasons.get(why) ?? 0) + 1);
  let added = 0, skipped = 0, linked = 0;

  try {
    tx(() => {
      const created = new Map<string, string>();

      for (const r of rows) {
        if (r.verdict === "error") { skipped++; note(r.messages[0] ?? "Row had errors"); continue; }
        const res = addMember(ownerId, projectId, {
          name: r.name, phone: r.phone, email: r.email,
          role: r.title, discipline: r.discipline,
          parentId: r.reportsToId, actorPersonId,
        });
        if ("error" in res) { skipped++; note(res.error); continue; }
        created.set(r.name.toLowerCase(), res.id);
        added++;
      }

      for (const r of rows) {
        if (r.verdict === "error" || !r.reportsToRaw || r.reportsToId) continue;
        const me = created.get(r.name.toLowerCase());
        const boss = created.get(r.reportsToRaw.toLowerCase());
        if (!me || !boss) continue;
        const res = setManager(projectId, me, boss, ownerId, actorPersonId);
        if ("error" in res) note(`${r.name}: ${res.error}`);
        else linked++;
      }

      recomputeLevels(projectId);
      if (added) {
        logPeopleEvent(projectId, "person_added", actorPersonId,
          `Imported ${added} ${added === 1 ? "person" : "people"}`);
      }
    });
  } catch (e) {
    return { error: `The import failed and nothing was saved. ${(e as Error).message}` };
  }

  return {
    added, skipped, linked,
    reasons: [...reasons].map(([why, n]) => (n > 1 ? `${why} (${n} rows)` : why)),
    truncated: fatal,
  };
}
