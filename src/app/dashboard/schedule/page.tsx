import { dashContext } from "@/lib/dash";
import {
  listActivities, listRelations, buildWbsTree, flattenWbs, facetsOf,
  progressEventCounts, recentImports, SCHEDULE_FIELDS,
} from "@/lib/schedule";
import { assignableMembers, canEditTask, can } from "@/lib/access";
import {
  newActivity, editActivity, reportProgress, unlinkActivity,
  startScheduleImport, refineScheduleImport, confirmScheduleImport,
} from "@/app/schedule-actions";
import { reassignTask } from "@/app/task-actions";
import {
  ScheduleView, NewActivity,
  type ActivityRow, type WbsRow, type PersonOption,
} from "@/components/schedule-ui";
import { ImportSchedule } from "@/components/schedule-import";
import { NoProject } from "@/components/project-switcher";

export const metadata = { title: "Schedule — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  const activities = listActivities(project.id);
  const relations = listRelations(project.id);
  const reportCounts = progressEventCounts(project.id);
  const byId = new Map(activities.map((a) => [a.id, a]));
  const names = new Map(actor.members.map((m) => [m.id, m.name]));

  // Both directions of every edge, grouped once rather than queried per row.
  const preds = new Map<string, ActivityRow["predecessors"]>();
  const succs = new Map<string, ActivityRow["successors"]>();
  for (const r of relations) {
    const from = byId.get(r.predecessor_id);
    const to = byId.get(r.successor_id);
    if (!from || !to) continue;
    const asPred = { id: from.id, ref: from.ref, title: from.title, relationId: r.id };
    const asSucc = { id: to.id, ref: to.ref, title: to.title, relationId: r.id };
    (preds.get(to.id) ?? preds.set(to.id, []).get(to.id)!).push(asPred);
    (succs.get(from.id) ?? succs.set(from.id, []).get(from.id)!).push(asSucc);
  }

  const rows: ActivityRow[] = activities.map((a) => ({
    id: a.id,
    activityId: a.ref,
    title: a.title,
    description: a.description,
    wbs: a.wbs,
    wbsPath: a.wbs_path,
    discipline: a.discipline,
    location: a.location,
    status: a.status,
    progress: a.progress,
    plannedStart: a.start_date,
    plannedFinish: a.due_date,
    baselineStart: a.baseline_start,
    baselineFinish: a.baseline_finish,
    actualStart: a.actual_start,
    actualFinish: a.actual_finish,
    plannedDuration: a.planned_duration,
    notes: a.notes,
    origin: a.origin,
    assignedTo: a.assigned_to,
    assignedToName: a.assigned_to ? (names.get(a.assigned_to) ?? "—") : null,
    canEdit: canEditTask(actor, a),
    reportCount: reportCounts.get(a.id) ?? 0,
    predecessors: preds.get(a.id) ?? [],
    successors: succs.get(a.id) ?? [],
  }));

  const wbs: WbsRow[] = flattenWbs(buildWbsTree(activities))
    .map(({ code, label, level, count }) => ({ code, label, level, count }));
  const { disciplines, locations } = facetsOf(activities);

  const people: PersonOption[] = assignableMembers(actor)
    .map((m) => ({ id: m.id, name: m.name, role: m.role }));

  const lastImport = recentImports(project.id, 1)[0];

  return (
    <>
      <header className="mb-5">
        <p className="font-mono text-[0.72rem] tracking-widest text-accent-strong uppercase">
          {project.name}{project.code ? ` · ${project.code}` : ""} · project controls
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-wide">Schedule</h1>
            <p className="mt-1 text-[0.86rem] text-ink-soft">
              {activities.length
                ? <>{activities.length} activities · {relations.length} logic links · you are {actor.role.name}</>
                : <>No activities yet · you are {actor.role.name}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {can(actor, "create_tasks") && (
              <NewActivity action={newActivity} projectId={project.id} people={people} />
            )}
          </div>
        </div>
        {lastImport && (
          <p className="mt-2 font-mono text-[0.72rem] text-ink-soft">
            Last import: {lastImport.filename ?? "pasted rows"}
            {lastImport.sheet_name ? ` · ${lastImport.sheet_name}` : ""} ·{" "}
            {lastImport.created_count} created, {lastImport.updated_count} updated,{" "}
            {lastImport.relations_made} links ·{" "}
            {new Date(lastImport.created_at).toLocaleString()}
          </p>
        )}
      </header>

      {can(actor, "create_tasks") && (
        <div className="mb-5">
          <ImportSchedule
            startAction={startScheduleImport}
            refineAction={refineScheduleImport}
            commitAction={confirmScheduleImport}
            projectId={project.id}
            people={people}
            fields={SCHEDULE_FIELDS}
            hasSchedule={activities.length > 0}
          />
        </div>
      )}

      <ScheduleView
        activities={rows}
        wbs={wbs}
        people={people}
        disciplines={disciplines}
        locations={locations}
        projectId={project.id}
        canAssign={can(actor, "assign_tasks")}
        editAction={editActivity}
        reportAction={reportProgress}
        reassignAction={reassignTask}
        unlinkAction={unlinkActivity}
      />

      <p className="mt-6 max-w-[80ch] font-mono text-[0.72rem] leading-relaxed text-ink-soft">
        An activity is what the schedule says should happen. A field report is a claim about
        it, stored separately and applied only once reviewed — so the schedule and what the
        field says can disagree without either being lost.
      </p>
    </>
  );
}
