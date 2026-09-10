import { dashContext } from "@/lib/dash";
import {
  listTasks, assignmentsByTask, taskIdsDelegatedTo, taskIdsDelegatedBy, delegationTargets,
} from "@/lib/tasks";
import { assignableMembers, canEditTask, can } from "@/lib/access";
import {
  newTask, editTask, reassignTask, setTaskStatus, removeTask,
  startImport, refineImport, confirmImport, delegate,
} from "@/app/task-actions";
import {
  CreateTask, ImportTasks, TaskTable,
  type Person, type TaskRow, type HistoryEntry,
} from "@/components/task-ui";
import { NoProject } from "@/components/project-switcher";
import { buildTree, flatten, listRoster } from "@/lib/people";
import { IMPORTABLE_FIELDS } from "@/lib/tasks";

export const metadata = { title: "Tasks — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { projects, project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  const tasks = listTasks(project.id);
  const byId = new Map(actor.members.map((m) => [m.id, m]));
  // History has to outlive membership. Someone removed from the project is gone
  // from `actor.members`, and naming them from there turned every past entry of
  // theirs into "someone" — which is exactly the record the chain exists to keep.
  const nameOf = new Map(listRoster(actor.ownerId).map((p) => [p.id, p.name]));
  const history = assignmentsByTask(project.id);
  const toMe = actor.personId ? taskIdsDelegatedTo(actor.personId) : new Set<string>();
  const byMe = actor.personId ? taskIdsDelegatedBy(actor.personId) : new Set<string>();

  // A null actor on an assignment means the project owner made it.
  const who = (personId: string | null): string => {
    if (personId === null) return actor.isOwner ? "you" : "the project owner";
    if (personId === actor.personId) return "you";
    return nameOf.get(personId) ?? "someone";
  };

  const rows: TaskRow[] = tasks.map((t) => {
    const chain = history.get(t.id) ?? [];
    return {
      id: t.id, ref: t.ref, title: t.title, description: t.description,
      status: t.status, priority: t.priority, progress: t.progress,
      startDate: t.start_date, dueDate: t.due_date,
      assignedTo: t.assigned_to,
      assignedToName: t.assigned_to ? (nameOf.get(t.assigned_to) ?? "—") : null,
      assignedByName: t.assigned_by !== null || t.assigned_to ? who(t.assigned_by) : null,
      createdByName: who(t.created_by),
      canEdit: canEditTask(actor, t),
      isMine: Boolean(actor.personId) && t.assigned_to === actor.personId,
      iAssigned: chain.some((h) => h.assigned_by === actor.personId && h.assigned_to !== actor.personId),
      delegatedToMe: toMe.has(t.id),
      delegatedByMe: byMe.has(t.id),
      // The first entry that landed on someone is the original assignee, and it
      // stays reportable however many times the task has moved since.
      originalName: (() => {
        const first = chain.find((h) => h.assigned_to);
        return first ? (nameOf.get(first.assigned_to!) ?? "someone") : null;
      })(),
      history: chain.map<HistoryEntry>((h) => ({
        toName: h.assigned_to ? (nameOf.get(h.assigned_to) ?? "someone") : null,
        byName: who(h.assigned_by),
        type: h.assignment_type,
        source: h.source,
        at: h.created_at,
      })),
    };
  });

  // Depth comes from the real tree so the pickers read as a slice of the
  // hierarchy rather than a flat list of everyone.
  const depth = new Map(flatten(buildTree(actor.members)).map((n) => [n.id, n.depth]));
  const toPerson = (id: string): Person => {
    const m = byId.get(id)!;
    return { id: m.id, name: m.name, role: m.role, depth: depth.get(m.id) ?? 0 };
  };

  const people: Person[] = assignableMembers(actor).map((m) => toPerson(m.id));
  const delegateTo: Person[] = delegationTargets(actor).map(toPerson);

  return (
    <>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-wide">Tasks</h1>
          <p className="mt-1 text-[0.9rem] text-ink-soft">
            {project.name} · {tasks.length} task{tasks.length === 1 ? "" : "s"} · you are{" "}
            <b className="text-accent-strong">{actor.role.name}</b>
            {actor.isOwner ? " (project owner)" : ` at depth ${actor.depth}`}
          </p>
        </div>
        {can(actor, "create_tasks") && (
          <div className="flex flex-wrap gap-2">
            <CreateTask
              action={newTask} people={people} projectId={project.id}
              selfId={actor.personId} canAssign={can(actor, "assign_tasks")}
            />
            <ImportTasks
              startAction={startImport} refineAction={refineImport} commitAction={confirmImport}
              projectId={project.id} people={people} fields={IMPORTABLE_FIELDS}
            />
          </div>
        )}
      </div>

      {!can(actor, "view_tasks") ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
          <p className="font-display text-lg font-bold">Your role can&apos;t view tasks.</p>
          <p className="mt-1 text-[0.86rem] text-ink-soft">Ask a project admin to change your role.</p>
        </div>
      ) : (
        <TaskTable
          tasks={rows} people={people} delegateTargets={delegateTo}
          projectId={project.id} selfId={actor.personId}
          statusAction={setTaskStatus} reassignAction={reassignTask}
          editAction={editTask} delegateAction={delegate} deleteAction={removeTask}
          canAssign={can(actor, "assign_tasks")}
        />
      )}
    </>
  );
}
