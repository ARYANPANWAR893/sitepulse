import Link from "next/link";
import { dashContext } from "@/lib/dash";
import { listTasks, recentEvents, STATUS_LABELS, type Status, type EventKind } from "@/lib/tasks";
import { scopeOf, can } from "@/lib/access";
import { NoProject } from "@/components/project-switcher";

export const metadata = { title: "Dashboard — SitePulse" };

/** One entry per EVENT_KINDS member — an unlabelled kind shows as raw snake_case. */
const KIND_LABELS: Record<EventKind, string> = {
  created: "Task created", updated: "Task updated", deleted: "Task deleted",
  imported: "Tasks imported",
  assigned: "Task assigned", reassigned: "Task reassigned",
  unassigned: "Task unassigned", delegated: "Task delegated",
  status_changed: "Status changed", progress_changed: "Progress changed",
  person_added: "Person added", person_moved: "Reporting line changed",
  person_removed: "Person removed", role_changed: "Role changed",
  activity_updated: "Activity updated", schedule_imported: "Schedule imported",
  progress_reported: "Field report", evidence_added: "Evidence added",
  review_decided: "Report reviewed",
  match_proposed: "Match proposed", match_auto_linked: "Match auto-linked",
  match_decided: "Match decided",
};

function ago(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { user, projects, project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  const tasks = listTasks(project.id);
  const scope = scopeOf(actor);
  const byId = new Map(actor.members.map((m) => [m.id, m]));

  const mine = tasks.filter((t) => t.assigned_to === actor.personId);
  const open = mine.filter((t) => t.status !== "completed");
  const iAssigned = tasks.filter((t) => t.assigned_by === actor.personId && t.assigned_to !== actor.personId);
  const underMe = actor.isOwner ? actor.members.length : Math.max(0, scope.size - 1);

  const reportsTo = actor.isOwner
    ? "—"
    : (() => {
        const me = byId.get(actor.personId!);
        return me?.parent_person_id ? (byId.get(me.parent_person_id)?.name ?? "—") : user.name;
      })();

  const cards: [string, number, string][] = [
    ["Tasks assigned to me", mine.length, "Everything currently on your plate."],
    ["Open on my plate", open.length, "Not yet marked completed."],
    ["Tasks I assigned", iAssigned.length, "Handed to someone you supervise."],
    ["People under me", underMe, actor.isOwner ? "Everyone on the project." : `Reachable within your ${actor.role.scope} scope.`],
  ];

  const events = recentEvents(project.id, 10);

  return (
    <>

      <div className="mb-6">
        <p className="font-mono text-[0.72rem] tracking-widest text-accent-strong uppercase">
          {project.name}{project.code ? ` · ${project.code}` : ""}
        </p>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-wide">Hello, {actor.name}.</h1>
      </div>

      <dl className="mb-8 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Role", actor.role.name],
          ["Hierarchy level", actor.isOwner ? "Root (owner)" : `Depth ${actor.depth}`],
          ["Reports to", reportsTo],
          ["Assignment scope", actor.role.scope],
        ].map(([k, v]) => (
          <div key={k} className="bg-paper-raised p-4">
            <dt className="font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">{k}</dt>
            <dd className="mt-1 text-[0.92rem] text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, hint]) => (
          <Link
            key={label}
            href={`/dashboard/tasks?project=${project.id}`}
            className="rounded-xl border border-line bg-paper-raised p-5 transition-colors hover:border-accent"
          >
            <p className="font-mono text-[0.66rem] tracking-wider text-ink-soft uppercase">{label}</p>
            <p className="mt-2 font-display text-4xl font-bold tracking-tight">{value}</p>
            <p className="mt-1 text-[0.78rem] leading-snug text-ink-soft">{hint}</p>
          </Link>
        ))}
      </div>

      <section>
        <h2 className="mb-3 font-display text-2xl font-bold tracking-wide">Recent task activity</h2>
        {events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center">
            <p className="font-display text-lg font-bold">Nothing has happened yet.</p>
            <p className="mt-1 text-[0.86rem] text-ink-soft">
              {can(actor, "create_tasks")
                ? "Create a task or import your master list to get started."
                : "Activity will appear here once work is assigned."}
            </p>
            {can(actor, "create_tasks") && (
              <Link href={`/dashboard/tasks?project=${project.id}`} className="btn btn-primary mt-4">
                Go to tasks
              </Link>
            )}
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line">
            {events.map((e, i) => (
              <li key={e.id} className={`flex flex-wrap items-baseline gap-x-3 bg-paper-raised px-3 py-2.5 ${i ? "border-t border-line" : ""}`}>
                <span className="font-mono text-[0.7rem] tracking-wider text-accent-strong uppercase">
                  {KIND_LABELS[e.kind as EventKind] ?? e.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-[0.88rem] text-ink">{e.detail ?? "—"}</span>
                <span className="font-mono text-[0.72rem] text-ink-soft">
                  {e.actor ? (byId.get(e.actor)?.name ?? "someone") : user.name} · {ago(e.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 font-mono text-[0.72rem] text-ink-soft">
        Everyone on a project sees every task. Editing and assignment are scoped by supervision —
        statuses shown as <b>{STATUS_LABELS["not_started" as Status]}</b> / In progress / Completed.
      </p>
    </>
  );
}
