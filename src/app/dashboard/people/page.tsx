import { dashContext } from "@/lib/dash";
import { buildTree, flatten, PEOPLE_FIELDS } from "@/lib/people";
import { taskCountsByPerson } from "@/lib/tasks";
import { listRoles } from "@/lib/roles";
import { can, scopeOf } from "@/lib/access";
import {
  addTeamMember, changeManager, setPersonRole, removeTeamMember,
  startPeopleImport, refinePeopleImport, confirmPeopleImport,
} from "@/app/team-actions";
import { AddPerson, ImportPeople, PeopleTree, type PersonRow, type RoleOption } from "@/components/people-ui";
import { NoProject } from "@/components/project-switcher";

export const metadata = { title: "People — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { projects, project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  if (!can(actor, "view_people")) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
        <p className="font-display text-lg font-bold">Your role can&apos;t view people.</p>
        <p className="mt-1 text-[0.86rem] text-ink-soft">Ask a project admin to change your role.</p>
      </div>
    );
  }

  const flat = flatten(buildTree(actor.members));
  const counts = taskCountsByPerson(project.id);
  const roles = listRoles(actor.ownerId);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const scope = scopeOf(actor);

  // Everyone is visible; `canManage` is what's scoped by supervision.
  const rows: PersonRow[] = flat.map((n) => ({
    id: n.id, name: n.name, phone: n.phone, email: n.email,
    discipline: n.discipline, title: n.role,
    roleId: n.role_id,
    roleName: (n.role_id && roleById.get(n.role_id)?.name) || "Contributor",
    depth: n.depth + 1,
    reports: n.children.length,
    tasks: counts.get(n.id) ?? 0,
    parentId: n.parent_person_id,
    linked: Boolean(n.user_id),
    isSelf: n.id === actor.personId,
    canManage: actor.isOwner || scope.has(n.id),
  }));

  const roleOptions: RoleOption[] = roles.map((r) => ({ id: r.id, name: r.name, scope: r.scope }));

  return (
    <>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-wide">People</h1>
          <p className="mt-1 text-[0.9rem] text-ink-soft">
            {project.name} · {rows.length} on this project · you are{" "}
            <b className="text-accent-strong">{actor.role.name}</b>
            {actor.isOwner ? " (project owner)" : ` at depth ${actor.depth}`}
          </p>
        </div>
        {can(actor, "manage_people") && (
          <div className="flex flex-wrap gap-2">
            <AddPerson
              action={addTeamMember} rows={rows} roles={roleOptions} projectId={project.id}
              selfName={actor.name} canSetRole={can(actor, "assign_roles")}
            />
            <ImportPeople
              startAction={startPeopleImport} refineAction={refinePeopleImport}
              commitAction={confirmPeopleImport} projectId={project.id} fields={PEOPLE_FIELDS}
            />
          </div>
        )}
      </div>

      <PeopleTree
        rows={rows} roles={roleOptions} projectId={project.id} selfName={actor.name}
        moveAction={changeManager} roleAction={setPersonRole} removeAction={removeTeamMember}
        canManage={can(actor, "manage_people")} canSetRole={can(actor, "assign_roles")}
      />
    </>
  );
}
