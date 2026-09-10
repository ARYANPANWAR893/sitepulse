import { dashContext } from "@/lib/dash";
import { listActivities } from "@/lib/schedule";
import { can } from "@/lib/access";
import {
  listReports, latestFieldEvent, latestRun, candidatesOf, decisionsFor,
  runsFor, toFieldEvent, readSignals,
} from "@/lib/intake";
import { SIGNAL_LABELS, describeSignal, type SignalName } from "@/lib/matching";
import { submitReport, resolveMatch, rematchReport, applyReport } from "@/app/intake-actions";
import { ReportsView, type ReportView, type CandidateView } from "@/components/reports-ui";
import { NoProject } from "@/components/project-switcher";

export const metadata = { title: "Field reports — SitePulse" };

export default async function Page({
  searchParams,
}: { searchParams: Promise<{ project?: string }> }) {
  const { project: wanted } = await searchParams;
  const { project, actor } = await dashContext(wanted);
  if (!project || !actor) return <NoProject />;

  const activities = new Map(listActivities(project.id).map((x) => [x.id, x]));
  const names = new Map(actor.members.map((m) => [m.id, m.name]));
  const who = (id: string | null) =>
    id === null ? (actor.isOwner ? "you" : "the project owner") : names.get(id) ?? "someone";

  const reports: ReportView[] = listReports(project.id, 100)
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => {
      const fe = latestFieldEvent(r.id);
      const run = latestRun(r.id);
      const linked = r.activity_id ? activities.get(r.activity_id) : undefined;

      const candidates: CandidateView[] = run
        ? candidatesOf(run.id).flatMap((c) => {
            const act = activities.get(c.activity_id);
            if (!act) return [];        // the activity was deleted since the run
            const signals = readSignals(c.signals);
            return [{
              activityId: act.id,
              ref: act.ref,
              title: act.title,
              wbsPath: act.wbs_path,
              discipline: act.discipline,
              location: act.location,
              plannedStart: act.start_date,
              plannedFinish: act.due_date,
              assigneeName: act.assigned_to ? names.get(act.assigned_to) ?? null : null,
              rank: c.rank,
              score: c.score,
              // Ordered strongest-first, so the reason that carried the match
              // is the first thing read.
              signals: (Object.entries(signals) as [SignalName, number][])
                .sort(([, x], [, y]) => y - x)
                .map(([key, value]) => ({
                  key, label: SIGNAL_LABELS[key] ?? key, value,
                  strength: describeSignal(value),
                })),
            }];
          })
        : [];

      return {
        id: r.id,
        rawText: r.raw_text ?? "",
        reportedAt: r.reported_at,
        reportedByName: r.reported_by ? names.get(r.reported_by) ?? null : null,
        source: r.source,
        linkedActivityId: r.activity_id,
        linkedActivityLabel: linked ? `${linked.ref ?? ""} ${linked.title}`.trim() : null,
        confidence: r.confidence,
        matchMethod: r.match_method,
        reviewState: r.review_state,
        applied: r.applied === 1,
        claimedProgress: r.progress,
        understood: fe
          ? {
              ...toFieldEvent(fe),
              provider: fe.provider,
              model: fe.model,
              ok: fe.ok === 1,
              error: fe.error,
            }
          : null,
        candidates,
        outcome: run?.outcome ?? null,
        runAt: run?.created_at ?? null,
        runCount: runsFor(r.id).length,
        decisions: decisionsFor(r.id).map((d) => ({
          decision: d.decision,
          byName: who(d.decided_by),
          automatic: d.automatic === 1,
          note: d.note,
          at: d.created_at,
        })),
      };
    });

  const pending = reports.filter((r) => !r.linkedActivityId).length;

  return (
    <>
      <header className="mb-5">
        <p className="font-mono text-[0.72rem] tracking-widest text-accent-strong uppercase">
          {project.name}{project.code ? ` · ${project.code}` : ""} · intelligence
        </p>
        <h1 className="mt-1 font-display text-3xl font-bold tracking-wide">Field reports</h1>
        <p className="mt-1 text-[0.86rem] text-ink-soft">
          {reports.length
            ? <>{reports.length} report{reports.length === 1 ? "" : "s"} · {pending} awaiting a decision · {activities.size} activities to match against</>
            : <>Nothing reported yet · {activities.size} activities to match against</>}
        </p>
      </header>

      <ReportsView
        reports={reports}
        projectId={project.id}
        canReview={can(actor, "edit_tasks")}
        submitAction={submitReport}
        resolveAction={resolveMatch}
        rematchAction={rematchReport}
        applyAction={applyReport}
      />

      <p className="mt-6 max-w-[80ch] font-mono text-[0.72rem] leading-relaxed text-ink-soft">
        SitePulse proposes; it does not decide. A match links a report to an activity and
        stops there — the schedule only moves when someone accepts the claim, and both acts
        are recorded separately with who did them and why.
      </p>
    </>
  );
}
