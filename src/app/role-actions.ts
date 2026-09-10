"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { actorFor, can, type Actor } from "@/lib/access";
import { createRole, updateRole, deleteRole, PERMISSIONS, type Permission } from "@/lib/roles";

export type RoleState = { error?: string; ok?: string };

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/** Checked boxes arrive as repeated fields; anything unknown is dropped. */
const perms = (f: FormData): Permission[] =>
  f.getAll("permissions").filter((p): p is Permission =>
    typeof p === "string" && (PERMISSIONS as readonly string[]).includes(p));

async function guard(form: FormData): Promise<{ a: Actor } | { fail: RoleState }> {
  const user = await currentUser();
  if (!user) redirect("/login");
  const projectId = str(form, "projectId");
  const a = projectId ? actorFor(projectId, user.id, user.name) : null;
  if (!a) return { fail: { error: "You don't have access to that project." } };
  if (!can(a, "manage_roles")) return { fail: { error: "Your role can't manage roles." } };
  return { a };
}

export async function newRole(_prev: RoleState, form: FormData): Promise<RoleState> {
  const g = await guard(form);
  if ("fail" in g) return g.fail;

  const res = createRole(g.a.ownerId, str(form, "name"), str(form, "description"), perms(form), str(form, "scope"));
  if ("error" in res) return res;

  revalidatePath("/dashboard", "layout");
  return { ok: "Role created." };
}

export async function saveRole(_prev: RoleState, form: FormData): Promise<RoleState> {
  const g = await guard(form);
  if ("fail" in g) return g.fail;

  const res = updateRole(g.a.ownerId, str(form, "roleId"), str(form, "name"),
    str(form, "description"), perms(form), str(form, "scope"));
  if ("error" in res) return res;

  revalidatePath("/dashboard", "layout");
  return { ok: "Role updated." };
}

export async function removeRole(form: FormData): Promise<void> {
  const g = await guard(form);
  if ("fail" in g) return;
  // Presets are protected in the query itself.
  deleteRole(g.a.ownerId, str(form, "roleId"));
  revalidatePath("/dashboard", "layout");
}
