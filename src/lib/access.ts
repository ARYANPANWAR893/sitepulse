import "server-only";
import { db } from "./db.ts";
import { listMembers, descendantsOf, type Member } from "./people.ts";
import { listRoles, getRole, roleByName, type Permission, type RoleView, type Scope } from "./roles.ts";

/**
 * Who the authenticated user is *inside one project*, and what they may do.
 *
 * Everything downstream resolves from this — never from a role name, depth, or
 * id sent by the client. Two kinds of actor:
 *
 *  - the account owner, who is the implicit root of every project they own and
 *    has no `people` row (personId === null);
 *  - a person whose record has been linked to a login account (people.user_id).
 */
export type Actor = {
  userId: string;
  ownerId: string;
  projectId: string;
  projectCode: string | null;
  personId: string | null;   // null = account owner acting as the root
  name: string;
  role: RoleView;
  depth: number;             // 0 for the root
  isOwner: boolean;
  members: Member[];
};

const linked = db.prepare(`
  SELECT p.id, p.name FROM people p
  JOIN memberships m ON m.person_id = p.id
  WHERE p.user_id = ? AND m.project_id = ?`);

const roleOfMember = db.prepare("SELECT role_id FROM memberships WHERE project_id = ? AND person_id = ?");

/** Resolve the caller's standing in a project, or null if they have none. */
export function actorFor(projectId: string, userId: string, userName: string): Actor | null {
  // Owner path: the project row itself is the proof of ownership.
  const owned = db.prepare("SELECT * FROM projects WHERE id = ? AND owner_id = ?").get(projectId, userId) as
    { id: string; owner_id: string; code: string | null } | undefined;

  if (owned) {
    const roles = listRoles(userId);
    const owner = roles.find((r) => r.name === "Owner")!;
    return {
      userId, ownerId: userId, projectId, projectCode: owned.code, personId: null, name: userName,
      role: owner, depth: 0, isOwner: true, members: listMembers(projectId),
    };
  }

  // Member path: a person record linked to this login, placed on this project.
  const me = linked.get(userId, projectId) as { id: string; name: string } | undefined;
  if (!me) return null;

  const project = db.prepare("SELECT owner_id, code FROM projects WHERE id = ?").get(projectId) as
    { owner_id: string; code: string | null } | undefined;
  if (!project) return null;

  const members = listMembers(projectId);
  const rid = (roleOfMember.get(projectId, me.id) as { role_id: string | null } | undefined)?.role_id;
  const role =
    (rid ? getRole(rid, project.owner_id) : null) ??
    roleByName(project.owner_id, "Contributor") ??
    listRoles(project.owner_id)[0];

  return {
    userId, ownerId: project.owner_id, projectId, projectCode: project.code,
    personId: me.id, name: me.name,
    role, depth: depthOf(me.id, members), isOwner: false, members,
  };
}

function depthOf(id: string, members: Member[]): number {
  const byId = new Map(members.map((m) => [m.id, m]));
  let d = 1, cur = byId.get(id);          // depth 1 = a direct report of the owner
  while (cur?.parent_person_id && d < 64) { cur = byId.get(cur.parent_person_id); d++; }
  return d;
}

export const can = (a: Actor, p: Permission) => a.role.permissions.includes(p);

/**
 * The people this actor may assign to or edit against.
 *
 * Always includes themselves. The owner reaches the whole project; everyone else
 * reaches exactly as far as their role's scope allows — which is what stops
 * assignment leaking sideways across the tree.
 */
export function scopeOf(a: Actor): Set<string> {
  if (a.isOwner) return new Set(a.members.map((m) => m.id));

  const out = new Set<string>();
  if (!a.personId) return out;
  out.add(a.personId);

  const scope: Scope = a.role.scope;
  // A "none" scope can't assign at all — not even to itself.
  if (scope === "none") return new Set<string>();
  if (scope === "self") return out;

  if (scope === "direct") {
    for (const m of a.members) if (m.parent_person_id === a.personId) out.add(m.id);
    return out;
  }
  for (const id of descendantsOf(a.personId, a.members)) out.add(id);
  return out;
}

/** Members the actor may pick in an "Assign to" control. */
export function assignableMembers(a: Actor): Member[] {
  if (!can(a, "assign_tasks")) {
    // Without assign_tasks you can still be handed your own work by create_tasks.
    return a.members.filter((m) => m.id === a.personId);
  }
  const scope = scopeOf(a);
  return a.members.filter((m) => scope.has(m.id));
}

export const canAssignTo = (a: Actor, personId: string | null): boolean => {
  if (personId === null) return can(a, "assign_tasks") || a.isOwner;
  return scopeOf(a).has(personId);
};

/**
 * Visibility is deliberately broad — everyone in the project sees every task.
 * Editing is what's scoped.
 */
export function canEditTask(a: Actor, task: { assigned_to: string | null; created_by: string | null }): boolean {
  if (!can(a, "edit_tasks")) return false;
  if (a.isOwner) return true;
  if (task.assigned_to && scopeOf(a).has(task.assigned_to)) return true;
  // An unassigned task is editable by whoever raised it.
  return !task.assigned_to && task.created_by === a.personId;
}

/**
 * Guard for any route that needs a project: resolves ownership and standing.
 *
 * This used to pre-check that *some* project with the id existed, which was
 * `(mine || anyone's) ? …`, i.e. always true for a real id and dead weight
 * otherwise. `actorFor` is the only check that matters — it returns null unless
 * the caller owns the project or is placed on it.
 */
export const requireActor = actorFor;
