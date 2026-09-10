import "server-only";
import { randomBytes } from "node:crypto";
import { db, now } from "./db.ts";
import { cleanName } from "./auth.ts";

/**
 * Permissions come from the role. Hierarchy decides *who* you may act on.
 * Neither is inferred from depth — a Manager can sit at any level.
 */
export const PERMISSIONS = [
  "view_tasks", "create_tasks", "edit_tasks", "assign_tasks",
  "view_people", "manage_people", "manage_roles", "assign_roles",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  view_tasks: "View tasks",
  create_tasks: "Create tasks",
  edit_tasks: "Edit tasks",
  assign_tasks: "Assign tasks",
  view_people: "View people",
  manage_people: "Manage people",
  manage_roles: "Manage roles",
  assign_roles: "Assign roles",
};

/** How far down the tree a role may reach. Orthogonal to the permission list. */
export const SCOPES = ["none", "self", "direct", "subtree"] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_LABELS: Record<Scope, string> = {
  none: "Cannot assign",
  self: "Self only",
  direct: "Direct reports",
  subtree: "All subordinates",
};

export type Role = {
  id: string; owner_id: string; name: string; description: string | null;
  permissions: string; scope: Scope; preset: number; created_at: number;
};

export type RoleView = Omit<Role, "permissions"> & { permissions: Permission[] };

const PRESETS: { name: string; description: string; permissions: Permission[]; scope: Scope }[] = [
  { name: "Owner", description: "Full control of the project, its people and its roles.",
    permissions: [...PERMISSIONS], scope: "subtree" },
  { name: "Project Admin", description: "Runs the project day to day, including roles.",
    permissions: [...PERMISSIONS], scope: "subtree" },
  { name: "Manager", description: "Plans and assigns work anywhere below them.",
    permissions: ["view_tasks", "create_tasks", "edit_tasks", "assign_tasks", "view_people", "manage_people"],
    scope: "subtree" },
  { name: "Supervisor", description: "Assigns work to their own direct reports.",
    permissions: ["view_tasks", "create_tasks", "edit_tasks", "assign_tasks", "view_people"],
    scope: "direct" },
  { name: "Contributor", description: "Raises and works their own tasks.",
    permissions: ["view_tasks", "create_tasks", "edit_tasks"], scope: "self" },
  { name: "Viewer", description: "Read-only access to the project.",
    permissions: ["view_tasks"], scope: "none" },
];

const q = {
  byOwner: db.prepare("SELECT * FROM roles WHERE owner_id = ? ORDER BY preset DESC, name"),
  one: db.prepare("SELECT * FROM roles WHERE id = ? AND owner_id = ?"),
  byName: db.prepare("SELECT * FROM roles WHERE owner_id = ? AND name = ?"),
  insert: db.prepare("INSERT INTO roles (id, owner_id, name, description, permissions, scope, preset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  update: db.prepare("UPDATE roles SET name = ?, description = ?, permissions = ?, scope = ? WHERE id = ? AND owner_id = ?"),
  del: db.prepare("DELETE FROM roles WHERE id = ? AND owner_id = ? AND preset = 0"),
  count: db.prepare("SELECT count(*) c FROM roles WHERE owner_id = ?"),
};

const newId = () => randomBytes(12).toString("hex");

export const cleanPermissions = (raw: unknown): Permission[] => {
  const list = Array.isArray(raw) ? raw : [];
  return PERMISSIONS.filter((p) => list.includes(p));
};

const view = (r: Role): RoleView => {
  let parsed: unknown = [];
  try { parsed = JSON.parse(r.permissions); } catch { parsed = []; }
  return { ...r, permissions: cleanPermissions(parsed) };
};

/** Seeded lazily on first read, so an account always has the presets available. */
export function listRoles(ownerId: string): RoleView[] {
  if ((q.count.get(ownerId) as { c: number }).c === 0) {
    const t = now();
    for (const p of PRESETS) {
      q.insert.run(newId(), ownerId, p.name, p.description, JSON.stringify(p.permissions), p.scope, 1, t);
    }
  }
  return (q.byOwner.all(ownerId) as Role[]).map(view);
}

export function getRole(id: string, ownerId: string): RoleView | null {
  const r = q.one.get(id, ownerId) as Role | undefined;
  return r ? view(r) : null;
}

export function roleByName(ownerId: string, name: string): RoleView | null {
  const r = q.byName.get(ownerId, name) as Role | undefined;
  return r ? view(r) : null;
}

/** The role handed to someone when none is chosen. */
export const defaultRole = (ownerId: string): RoleView => {
  listRoles(ownerId);
  return roleByName(ownerId, "Contributor")!;
};

export function createRole(
  ownerId: string, name: unknown, description: unknown, permissions: unknown, scope: unknown
): { ok: true; id: string } | { error: string } {
  const n = cleanName(name);
  if (!n) return { error: "Give the role a name." };
  const sc = SCOPES.includes(scope as Scope) ? (scope as Scope) : "self";
  const perms = cleanPermissions(permissions);
  const id = newId();
  try {
    q.insert.run(id, ownerId, n, typeof description === "string" ? description.trim().slice(0, 240) : null,
      JSON.stringify(perms), sc, 0, now());
  } catch {
    return { error: "You already have a role with that name." };
  }
  return { ok: true, id };
}

export function updateRole(
  ownerId: string, id: string, name: unknown, description: unknown, permissions: unknown, scope: unknown
): { ok: true } | { error: string } {
  const existing = getRole(id, ownerId);
  if (!existing) return { error: "That role doesn't exist." };
  const n = cleanName(name);
  if (!n) return { error: "Give the role a name." };
  // Presets keep their identity but their permissions stay editable.
  const finalName = existing.preset ? existing.name : n;
  const sc = SCOPES.includes(scope as Scope) ? (scope as Scope) : existing.scope;
  try {
    q.update.run(finalName, typeof description === "string" ? description.trim().slice(0, 240) : existing.description,
      JSON.stringify(cleanPermissions(permissions)), sc, id, ownerId);
  } catch {
    return { error: "You already have a role with that name." };
  }
  return { ok: true };
}

export const deleteRole = (ownerId: string, id: string) =>
  Boolean(q.del.run(id, ownerId).changes);
