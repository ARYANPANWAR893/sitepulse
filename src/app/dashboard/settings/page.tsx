import Link from "next/link";
import { dashContext } from "@/lib/dash";
import { countMembers } from "@/lib/people";
import { countTasks } from "@/lib/tasks";
import { removeProject } from "@/app/team-actions";
import { DeleteProject } from "@/components/project-ui";

export const metadata = { title: "Project settings — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { user, projects, project, actor } = await dashContext(wanted);
  const owned = project ? project.owner_id === user.id : false;

  return (
    <>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-wide">Project settings</h1>
          <p className="mt-1 text-[0.9rem] text-ink-soft">
            {projects.length} project{projects.length === 1 ? "" : "s"} on this account.
          </p>
        </div>
      </div>

      {project ? (
        <div className="space-y-6">
          <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Project", project.name],
              ["Code", project.code ?? "—"],
              ["People", String(countMembers(project.id))],
              ["Tasks", String(countTasks(project.id))],
            ].map(([k, v]) => (
              <div key={k} className="bg-paper-raised p-4">
                <dt className="font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">{k}</dt>
                <dd className="mt-1 text-[0.95rem] text-ink">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="rounded-xl border border-line bg-paper-raised p-5">
            <h2 className="font-display text-lg font-bold tracking-wide">Your standing here</h2>
            {actor ? (
              <dl className="mt-3 grid gap-x-8 gap-y-2 text-[0.88rem] sm:grid-cols-2">
                <div className="flex justify-between border-b border-line pb-1.5">
                  <dt className="text-ink-soft">Role</dt><dd className="text-accent-strong">{actor.role.name}</dd>
                </div>
                <div className="flex justify-between border-b border-line pb-1.5">
                  <dt className="text-ink-soft">Assignment scope</dt>
                  <dd className="font-mono text-[0.8rem]">{actor.role.scope}</dd>
                </div>
                <div className="flex justify-between border-b border-line pb-1.5">
                  <dt className="text-ink-soft">Hierarchy depth</dt>
                  <dd className="font-mono text-[0.8rem]">{actor.isOwner ? "root (owner)" : actor.depth}</dd>
                </div>
                <div className="flex justify-between border-b border-line pb-1.5">
                  <dt className="text-ink-soft">Permissions</dt>
                  <dd className="font-mono text-[0.8rem]">{actor.role.permissions.length}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-[0.88rem] text-ink-soft">You have no standing on this project.</p>
            )}
            <p className="mt-4 text-[0.8rem] leading-relaxed text-ink-soft">
              Depth and role are independent: depth decides <em>who</em> you can reach, your role
              decides <em>what</em> you may do. A Manager can sit at any level.{" "}
              <Link href={`/dashboard/roles?project=${project.id}`} className="text-accent-strong underline underline-offset-2">
                Roles &amp; permissions
              </Link>
            </p>
          </div>

          {owned && projects.length > 1 && (
            <div className="rounded-xl border border-dashed border-line-strong p-5">
              <h2 className="font-display text-lg font-bold tracking-wide">Danger zone</h2>
              <p className="mt-1 mb-4 text-[0.84rem] text-ink-soft">
                Deleting a project removes its reporting structure and all of its tasks.
                People stay on your roster and on any other project.
              </p>
              <DeleteProject action={removeProject} projectId={project.id} name={project.name} />
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-14 text-center">
          <p className="font-display text-xl font-bold">No project yet.</p>
          <p className="mt-1 text-[0.88rem] text-ink-soft">
            Use <b>+ New project</b> in the sidebar — people, hierarchy and tasks all live inside one.
          </p>
        </div>
      )}
    </>
  );
}
