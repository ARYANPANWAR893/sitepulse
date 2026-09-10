import "server-only";
import { randomBytes } from "node:crypto";
import { db, now, tx } from "./db.ts";
import type { Actor } from "./access.ts";
import { can } from "./access.ts";
import {
  listActivities, facetsOf, matchTextFor, recordProgressEvent,
  type Activity,
} from "./schedule.ts";
import {
  extractFieldEvent, getProvider, embedOne,
  type ExtractionContext, type FieldEvent, type LlmProvider,
} from "./llm/index.ts";
import {
  loadConfig, rankCandidates, decideOutcome,
  type MatchConfig, type Outcome, type Scored, type SignalScores,
} from "./matching.ts";

/**
 * Field report → understanding → shortlist → decision.
 *
 * The pipeline, and the one thing it will not do: **a score never changes the
 * schedule.** A high-confidence match proposes a *link* between a report and an
 * activity, and stops. Whether the activity's progress actually moves is a
 * separate, human, already-audited step (`decideProgressEvent` in schedule.ts).
 *
 * That separation is the point of the whole phase. The system is allowed to be
 * confident; it is not allowed to be unilateral.
 */

const newId = () => randomBytes(12).toString("hex");
const json = (v: unknown) => JSON.stringify(v);

const q = {
  addFieldEvent: db.prepare(`INSERT INTO field_events
    (id, project_id, report_id, work, progress, status, event_date, date_phrase,
     location, discipline, quantity, unit, activity_ref, people, equipment,
     materials, context, raw_text, provider, model, model_version, ok, error,
     raw_output, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  latestFieldEvent: db.prepare(
    "SELECT * FROM field_events WHERE report_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
  fieldEventsFor: db.prepare("SELECT * FROM field_events WHERE report_id = ? ORDER BY created_at DESC"),

  addRun: db.prepare(`INSERT INTO match_runs
    (id, project_id, report_id, field_event_id, provider, model, weights,
     considered, top_score, outcome, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  latestRun: db.prepare(
    "SELECT * FROM match_runs WHERE report_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"),
  runsFor: db.prepare("SELECT * FROM match_runs WHERE report_id = ? ORDER BY created_at DESC"),

  addCandidate: db.prepare(`INSERT INTO match_candidates
    (id, run_id, project_id, activity_id, rank, score, signals, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  candidatesOf: db.prepare("SELECT * FROM match_candidates WHERE run_id = ? ORDER BY rank"),

  addDecision: db.prepare(`INSERT INTO match_decisions
    (id, project_id, report_id, run_id, activity_id, decision, decided_by,
     automatic, score, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  decisionsFor: db.prepare("SELECT * FROM match_decisions WHERE report_id = ? ORDER BY created_at DESC"),

  linkReport: db.prepare(`UPDATE progress_events
    SET activity_id = ?, confidence = ?, match_method = ? WHERE id = ? AND project_id = ?`),
  // Only fills what is still empty. A number a person typed into the report
  // form outranks one a model read out of prose, so COALESCE keeps theirs.
  fillFromExtraction: db.prepare(`UPDATE progress_events SET
    progress      = COALESCE(progress, ?),
    status        = COALESCE(status, ?),
    actual_start  = COALESCE(actual_start, ?),
    actual_finish = COALESCE(actual_finish, ?),
    quantity      = COALESCE(quantity, ?),
    unit          = COALESCE(unit, ?)
    WHERE id = ? AND project_id = ?`),
  report: db.prepare("SELECT * FROM progress_events WHERE id = ? AND project_id = ?"),
  reportsIn: db.prepare(
    "SELECT * FROM progress_events WHERE project_id = ? ORDER BY reported_at DESC LIMIT ?"),
  recentWbs: db.prepare(`SELECT DISTINCT t.wbs FROM progress_events pe
    JOIN tasks t ON t.id = pe.activity_id
    WHERE pe.project_id = ? AND pe.reported_by IS ? AND t.wbs IS NOT NULL
    ORDER BY pe.reported_at DESC LIMIT 5`),
  event: db.prepare(
    "INSERT INTO task_events (project_id, task_id, kind, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?)"),
};

// ---------------------------------------------------------------- rows

export type FieldEventRow = {
  id: string; project_id: string; report_id: string;
  work: string | null; progress: number | null; status: string | null;
  event_date: string | null; date_phrase: string | null;
  location: string | null; discipline: string | null;
  quantity: number | null; unit: string | null; activity_ref: string | null;
  people: string | null; equipment: string | null; materials: string | null; context: string | null;
  raw_text: string; provider: string; model: string | null; model_version: string | null;
  ok: number; error: string | null; raw_output: string | null; created_at: number;
};

export type MatchRunRow = {
  id: string; project_id: string; report_id: string; field_event_id: string | null;
  provider: string; model: string | null; weights: string;
  considered: number; top_score: number | null; outcome: Outcome; created_at: number;
};

export type MatchCandidateRow = {
  id: string; run_id: string; project_id: string; activity_id: string;
  rank: number; score: number; signals: string; created_at: number;
};

export type MatchDecisionRow = {
  id: string; project_id: string; report_id: string; run_id: string | null;
  activity_id: string | null; decision: "linked" | "rejected" | "deferred" | "auto_linked";
  decided_by: string | null; automatic: number; score: number | null;
  note: string | null; created_at: number;
};

/** A stored list column, read back safely. Bad JSON becomes an empty list. */
export function readList(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function readSignals(v: string): SignalScores {
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" ? (parsed as SignalScores) : {};
  } catch { return {}; }
}

/** The stored row, back in the shape the matcher and the UI speak. */
export function toFieldEvent(row: FieldEventRow): FieldEvent {
  return {
    work: row.work, progress: row.progress,
    status: row.status as FieldEvent["status"],
    date: row.event_date, datePhrase: row.date_phrase,
    location: row.location, discipline: row.discipline,
    quantity: row.quantity, unit: row.unit, activityRef: row.activity_ref,
    people: readList(row.people), equipment: readList(row.equipment),
    materials: readList(row.materials), context: readList(row.context),
  };
}

// ---------------------------------------------------------------- context

/**
 * The project's own vocabulary, handed to the reader.
 *
 * This is what stops "CDU" being a guess: it is a location because this
 * schedule has one. An empty project gives an empty vocabulary and the reader
 * simply finds less, which is the correct failure.
 */
export function extractionContext(a: Actor, activities?: Activity[]): ExtractionContext {
  const rows = activities ?? listActivities(a.projectId);
  const { disciplines, locations } = facetsOf(rows);
  // WBS path segments are place names too — "Duliajan > Civil > Earthworks".
  const fromPaths = new Set<string>();
  for (const r of rows) {
    for (const seg of (r.wbs_path ?? "").split(">")) {
      const s = seg.trim();
      if (s.length > 1) fromPaths.add(s);
    }
  }
  return {
    now: now(),
    locations: [...new Set([...locations, ...fromPaths])],
    disciplines,
    people: a.members.map((m) => m.name),
    activityRefs: rows.map((r) => r.ref).filter((r): r is string => Boolean(r)),
  };
}

// ---------------------------------------------------------------- pipeline

export type IntakeResult = {
  reportId: string;
  fieldEventId: string;
  runId: string;
  event: FieldEvent;
  extractionOk: boolean;
  extractionError: string | null;
  provider: string;
  candidates: { activity: Activity; score: number; signals: SignalScores; rank: number }[];
  outcome: Outcome;
  /** Set only when the top score cleared the auto-link threshold. */
  proposed: { activityId: string; score: number } | null;
  autoLinked: boolean;
};

/**
 * Takes a raw report all the way to a shortlist.
 *
 * Extraction happens outside the transaction — it may hit the network, and a
 * database transaction has no business waiting on a model. Everything that
 * follows is written as one unit, so a report can never end up with an
 * extraction but no run, or a run with half its candidates.
 */
export async function ingestReport(
  a: Actor,
  input: { text: string; reportedBy?: string | null; source?: "manual" | "whatsapp" | "import" | "system" },
  opts: { provider?: LlmProvider; config?: MatchConfig; autoLink?: boolean } = {}
): Promise<IntakeResult | { error: string }> {
  const text = String(input.text ?? "").trim();
  if (!text) return { error: "The report is empty." };
  if (text.length > 4000) return { error: "That report is too long — 4000 characters is the limit." };

  const created = recordProgressEvent(a, {
    activityId: null,
    reportedBy: input.reportedBy ?? a.personId,
    source: input.source ?? "manual",
    rawText: text,
    matchMethod: null,
    reviewState: "pending",
  });
  if ("error" in created) return created;

  const run = await matchReport(a, created.id, opts);
  if ("error" in run) return run;
  return run;
}

/**
 * Reads a report and scores it. Safe to call again — every run appends.
 *
 * Re-running is expected: better model, changed weights, or a schedule that has
 * since been imported. Nothing from the previous run is destroyed, because the
 * decision a human made was made against *that* run and has to stay readable
 * next to it.
 */
export async function matchReport(
  a: Actor, reportId: string,
  opts: { provider?: LlmProvider; config?: MatchConfig; autoLink?: boolean } = {}
): Promise<IntakeResult | { error: string }> {
  const report = q.report.get(reportId, a.projectId) as
    { id: string; raw_text: string | null; reported_by: string | null } | undefined;
  if (!report) return { error: "That report isn't in this project." };

  const text = (report.raw_text ?? "").trim();
  if (!text) return { error: "That report has no text to read." };

  const cfg = opts.config ?? loadConfig();
  const provider = opts.provider ?? getProvider();
  const activities = listActivities(a.projectId);
  const ctx = extractionContext(a, activities);

  // Outside the transaction on purpose — this may go to the network.
  const extraction = await extractFieldEvent(text, ctx, provider);

  const scopeIds = new Set<string>();
  if (report.reported_by) {
    const { scopeOf } = await import("./access.ts");
    for (const id of scopeOf(a)) scopeIds.add(id);
  }
  const recentWbs = (q.recentWbs.all(a.projectId, report.reported_by) as { wbs: string }[])
    .map((r) => r.wbs);

  const vectors = new Map<string, Float32Array>();
  for (const act of activities) vectors.set(act.id, embedOne(matchTextFor(act)));

  const ranked: Scored[] = rankCandidates(
    { event: extraction.event, reporterId: report.reported_by, reporterScope: scopeIds, recentWbs },
    activities, cfg, vectors
  );
  const outcome = decideOutcome(ranked[0], cfg);
  const top = ranked[0];

  const fieldEventId = newId();
  const runId = newId();
  const t = now();
  // Auto-link is opt-in per call and off by default: proposing is the system's
  // job, linking is a decision.
  const autoLink = Boolean(opts.autoLink) && outcome === "auto_link_proposed" && Boolean(top);

  tx(() => {
    const ev = extraction.event;
    q.addFieldEvent.run(
      fieldEventId, a.projectId, reportId,
      ev.work, ev.progress, ev.status, ev.date, ev.datePhrase,
      ev.location, ev.discipline, ev.quantity, ev.unit, ev.activityRef,
      json(ev.people), json(ev.equipment), json(ev.materials), json(ev.context),
      text, extraction.provider, extraction.model, extraction.modelVersion,
      extraction.ok ? 1 : 0, extraction.error, extraction.raw, t
    );

    // The claim itself has to carry the understood numbers, or accepting it
    // later would apply nothing. The report row is what is claimed; the field
    // event is how it was read.
    const claimStatus = ev.status === "blocked" ? null : ev.status;
    q.fillFromExtraction.run(
      ev.progress, claimStatus,
      ev.status === "in_progress" || ev.status === "completed" ? ev.date : null,
      ev.status === "completed" ? ev.date : null,
      ev.quantity, ev.unit,
      reportId, a.projectId
    );

    q.addRun.run(runId, a.projectId, reportId, fieldEventId,
      extraction.provider, extraction.model, json(cfg.weights),
      activities.length, top?.score ?? null, outcome, t);

    ranked.forEach((c, i) => {
      q.addCandidate.run(newId(), runId, a.projectId, c.activity.id, i + 1,
        Number(c.score.toFixed(6)), json(c.signals), t);
    });

    if (autoLink && top) {
      // A link, and only a link. The activity's progress is untouched.
      q.linkReport.run(top.activity.id, top.score, `auto:${extraction.provider}`, reportId, a.projectId);
      q.addDecision.run(newId(), a.projectId, reportId, runId, top.activity.id,
        "auto_linked", a.personId, 1, top.score,
        `Auto-linked at ${(top.score * 100).toFixed(0)}% — schedule not changed`, t);
      q.event.run(a.projectId, top.activity.id, "match_auto_linked", a.personId,
        `Field report linked automatically at ${(top.score * 100).toFixed(0)}% confidence`, t);
    } else {
      q.event.run(a.projectId, null, "match_proposed", a.personId,
        top ? `${ranked.length} candidates, best ${(top.score * 100).toFixed(0)}%`
            : "No candidate cleared the floor", t);
    }
  });

  return {
    reportId, fieldEventId, runId,
    event: extraction.event,
    extractionOk: extraction.ok,
    extractionError: extraction.error,
    provider: extraction.provider,
    candidates: ranked.map((c, i) => ({ ...c, rank: i + 1 })),
    outcome,
    proposed: outcome === "auto_link_proposed" && top
      ? { activityId: top.activity.id, score: top.score } : null,
    autoLinked: autoLink,
  };
}

/**
 * A human's answer to a proposal.
 *
 * Links the report to an activity, or refuses. Still does not touch the
 * activity — accepting the *claim* is `decideProgressEvent`, deliberately a
 * second act, so "this report is about X" and "X is now 80% done" are never the
 * same click.
 */
export function decideMatch(
  a: Actor, reportId: string,
  decision: "linked" | "rejected" | "deferred",
  activityId: string | null, note?: string
): { ok: true } | { error: string } {
  if (!can(a, "edit_tasks")) return { error: "Your role can't review field reports." };
  const report = q.report.get(reportId, a.projectId) as { id: string } | undefined;
  if (!report) return { error: "That report isn't in this project." };

  if (decision === "linked") {
    if (!activityId) return { error: "Choose an activity to link to." };
    const activity = listActivities(a.projectId).find((x) => x.id === activityId);
    if (!activity) return { error: "That activity isn't in this project." };
  }

  const run = q.latestRun.get(reportId) as MatchRunRow | undefined;
  const score = activityId && run
    ? (q.candidatesOf.all(run.id) as MatchCandidateRow[]).find((c) => c.activity_id === activityId)?.score ?? null
    : null;
  const t = now();

  tx(() => {
    if (decision === "linked") {
      q.linkReport.run(activityId, score, "human", reportId, a.projectId);
    } else if (decision === "rejected") {
      q.linkReport.run(null, null, "human", reportId, a.projectId);
    }
    q.addDecision.run(newId(), a.projectId, reportId, run?.id ?? null, activityId,
      decision, a.personId, 0, score, note ?? null, t);
    q.event.run(a.projectId, activityId, "match_decided", a.personId,
      decision === "linked" ? "Field report linked to an activity"
      : decision === "rejected" ? "Proposed match rejected"
      : "Match deferred", t);
  });
  return { ok: true };
}

// ---------------------------------------------------------------- reads

export const latestFieldEvent = (reportId: string) =>
  (q.latestFieldEvent.get(reportId) as FieldEventRow | undefined) ?? null;
export const fieldEventsFor = (reportId: string) =>
  q.fieldEventsFor.all(reportId) as FieldEventRow[];
export const latestRun = (reportId: string) =>
  (q.latestRun.get(reportId) as MatchRunRow | undefined) ?? null;
export const runsFor = (reportId: string) => q.runsFor.all(reportId) as MatchRunRow[];
export const candidatesOf = (runId: string) => q.candidatesOf.all(runId) as MatchCandidateRow[];
export const decisionsFor = (reportId: string) =>
  q.decisionsFor.all(reportId) as MatchDecisionRow[];
export const getReport = (id: string, projectId: string) =>
  q.report.get(id, projectId) as
    { id: string; project_id: string; activity_id: string | null; reported_by: string | null;
      reported_at: number; source: string; raw_text: string | null; progress: number | null;
      confidence: number | null; match_method: string | null; review_state: string;
      applied: number } | undefined ?? null;
export const listReports = (projectId: string, limit = 100) =>
  q.reportsIn.all(projectId, limit) as ReturnType<typeof getReport>[];
