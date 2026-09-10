import { dashContext } from "@/lib/dash";
import { listRoles, PERMISSIONS, PERMISSION_LABELS, SCOPES, SCOPE_LABELS } from "@/lib/roles";
import { can } from "@/lib/access";
import { newRole, saveRole, removeRole } from "@/app/role-actions";
import { RoleList, type RoleCard } from "@/components/role-ui";
import { NoProject } from "@/components/project-switcher";

export const metadata = { title: "Roles & permissions — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { projects, project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  const roles: RoleCard[] = listRoles(actor.ownerId).map((r) => ({
    id: r.id, name: r.name, description: r.description,
    permissions: r.permissions, scope: r.scope, preset: Boolean(r.preset),
  }));

  return (
    <>

      <div className="mb-6">
        <h1 className="font-display text-3xl font-bold tracking-wide">Roles &amp; permissions</h1>
        <p className="mt-1 max-w-[70ch] text-[0.9rem] leading-relaxed text-ink-soft">
          A role decides <b>what</b> someone may do. Their position in the hierarchy decides{" "}
          <b>who</b> they may do it to. The two are independent — a Manager can sit at any depth,
          and depth on its own grants nothing.
        </p>
      </div>

      {!can(actor, "manage_roles") && (
        <p className="mb-5 rounded-md bg-paper-sunk px-3 py-2 text-[0.84rem] text-ink-soft">
          You can see how roles are configured, but your role can&apos;t change them.
        </p>
      )}

      <RoleList
        roles={roles}
        myRoleId={actor.role.id}
        myRoleName={actor.role.name}
        myScopeLabel={SCOPE_LABELS[actor.role.scope]}
        isOwner={actor.isOwner}
        allPermissions={[...PERMISSIONS]}
        permissionLabels={PERMISSION_LABELS}
        scopes={[...SCOPES]}
        scopeLabels={SCOPE_LABELS}
        projectId={project.id}
        canManage={can(actor, "manage_roles")}
        createAction={newRole}
        saveAction={saveRole}
        deleteAction={removeRole}
      />
    </>
  );
}
