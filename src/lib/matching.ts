import "server-only";
import type { FieldEvent } from "./llm/types.ts";
import { cosine, embedOne, tokenize } from "./llm/index.ts";
import { matchTextFor, type Activity } from "./schedule.ts";

/**
 * Scoring a field report against a schedule.
 *
 * The rule the whole file exists to honour: **never text similarity alone.** A
 * schedule is full of activities whose names differ by a location or a
 * kilometre post — "Trench excavation KP0-KP4" and "Trench excavation KP4-KP12"
 * are 95% the same string and completely different work. What separates them is
 * where, who, which discipline and when, so those are signals in their own
 * right rather than tie-breakers.
 *
 * Every signal returns 0..1, or null when the report simply doesn't say. A null
 * signal is *dropped from the weighting* rather than scored zero — a report
 * that mentions no location must not penalise every activity equally, it just
 * has one less thing to go on. The denominator shrinks with it, so confidence
 * reflects how much evidence there actually was.
 */

export const SIGNALS = [
  "semantic", "name", "description", "discipline",
  "location", "date", "assignment", "wbs", "activityRef",
] as const;
export type SignalName = (typeof SIGNALS)[number];

export type SignalScores = Partial<Record<SignalName, number>>;

export const SIGNAL_LABELS: Record<SignalName, string> = {
  semantic: "Semantic similarity",
  name: "Activity name",
  description: "Description",
  discipline: "Discipline",
  location: "Location",
  date: "Date compatibility",
  assignment: "Assignment",
  wbs: "Schedule context",
  activityRef: "Quoted activity ID",
};

/**
 * How much each signal counts.
 *
 * `activityRef` dominates on purpose: a report that quotes "OIL-1020" has told
 * us the answer, and no amount of disagreement elsewhere should out-vote it.
 * Everything else is deliberately close in magnitude — this is a weighted
 * opinion, not a formula anyone should trust to three decimal places.
 *
 * Override per-project or per-environment through `MATCH_WEIGHTS` (JSON). The
 * weights actually used are stored on every run, so a score can always be
 * reproduced even after they change.
 */
export const DEFAULT_WEIGHTS: Record<SignalName, number> = {
  activityRef: 6,
  semantic: 3,
  name: 2,
  location: 2,
  discipline: 1.5,
  date: 1.5,
  assignment: 1,
  wbs: 0.75,
  description: 0.75,
};

export type MatchConfig = {
  weights: Record<SignalName, number>;
  /** At or above this, the system may propose a link without being asked. */
  autoLinkAt: number;
  /** Below this, a candidate isn't worth showing. */
  floor: number;
  /** How many candidates to keep. */
  topN: number;
  /** Days either side of an activity's planned window that still count as on-time. */
  dateGraceDays: number;
};

export const DEFAULT_CONFIG: MatchConfig = {
  weights: DEFAULT_WEIGHTS,
  autoLinkAt: 0.8,
  floor: 0.25,
  topN: 5,
  dateGraceDays: 7,
};

export function loadConfig(): MatchConfig {
  const cfg = { ...DEFAULT_CONFIG, weights: { ...DEFAULT_WEIGHTS } };
  const num = (v: string | undefined, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  cfg.autoLinkAt = num(process.env.MATCH_AUTO_LINK_AT, 0, 1) ?? cfg.autoLinkAt;
  cfg.floor = num(process.env.MATCH_FLOOR, 0, 1) ?? cfg.floor;
  cfg.topN = num(process.env.MATCH_TOP_N, 1, 20) ?? cfg.topN;

  // A malformed MATCH_WEIGHTS must not take the matcher down with it.
  try {
    if (process.env.MATCH_WEIGHTS) {
      const parsed: unknown = JSON.parse(process.env.MATCH_WEIGHTS);
      if (parsed && typeof parsed === "object") {
        for (const k of SIGNALS) {
          const v = (parsed as Record<string, unknown>)[k];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) cfg.weights[k] = v;
        }
      }
    }
  } catch { /* keep the defaults */ }
  return cfg;
}

// ---------------------------------------------------------------- signals

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Jaccard over content words. Cheap, and unlike cosine it ignores length. */
export function tokenOverlap(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit);
}

/**
 * Do two place names refer to the same place?
 *
 * Site language is loose — "CDU", "near CDU", "CDU area", "Unit 3 / CDU" — so
 * containment counts, not just equality.
 */
export function placeMatch(reported: string | null, activity: string | null): number | null {
  if (!reported || !activity) return null;
  const a = norm(reported), b = norm(activity);
  if (!a || !b) return null;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const overlap = tokenOverlap(a, b);
  return overlap > 0 ? Math.min(0.8, overlap + 0.2) : 0;
}

/**
 * Is the reported date consistent with when this activity is meant to happen?
 *
 * Inside the planned window is a clean match. Outside it decays over the grace
 * period rather than falling off a cliff — work runs late, and a report two
 * days after a planned finish is still probably about that activity.
 */
export function dateCompatibility(
  reported: string | null, a: Pick<Activity, "start_date" | "due_date" | "actual_start" | "actual_finish">,
  graceDays: number
): number | null {
  if (!reported) return null;
  const start = a.actual_start ?? a.start_date;
  const finish = a.due_date ?? a.actual_finish;
  if (!start && !finish) return null;

  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const t = day(reported);
  if (!Number.isFinite(t)) return null;

  const lo = start ? day(start) : -Infinity;
  const hi = finish ? day(finish) : Infinity;
  if (t >= lo && t <= hi) return 1;

  const off = t < lo ? lo - t : t - hi;
  if (off <= graceDays) return 1 - (off / graceDays) * 0.6;   // 1 → 0.4 across the grace window
  // Beyond grace, decay slowly rather than to zero: a schedule can be stale.
  return Math.max(0, 0.4 - (off - graceDays) / 120);
}

export type MatchInput = {
  event: FieldEvent;
  /** Who filed the report, if known — feeds the assignment signal. */
  reporterId: string | null;
  /** People the reporter supervises, so their crew's work counts too. */
  reporterScope: Set<string>;
  /** WBS branches this reporter has been talking about lately. */
  recentWbs: string[];
};

export type Scored = {
  activity: Activity;
  score: number;
  signals: SignalScores;
};

/** Scores one activity. Exported so the tests can pin individual signals. */
export function scoreActivity(
  input: MatchInput, activity: Activity, cfg: MatchConfig,
  reportVector: Float32Array, activityVector: Float32Array
): Scored {
  const { event } = input;
  const signals: SignalScores = {};

  signals.semantic = cosine(reportVector, activityVector);

  if (event.work) {
    signals.name = tokenOverlap(event.work, activity.title);
    if (activity.description) signals.description = tokenOverlap(event.work, activity.description);
  }

  const disc = placeMatch(event.discipline, activity.discipline);
  if (disc !== null) signals.discipline = disc;

  // A location may be written on the activity or only in its WBS path.
  const loc = placeMatch(event.location, activity.location)
    ?? placeMatch(event.location, activity.wbs_path);
  if (loc !== null) signals.location = loc;

  const date = dateCompatibility(event.date, activity, cfg.dateGraceDays);
  if (date !== null) signals.date = date;

  if (input.reporterId && activity.assigned_to) {
    signals.assignment = activity.assigned_to === input.reporterId ? 1
      : input.reporterScope.has(activity.assigned_to) ? 0.7
      : 0;
  }

  if (input.recentWbs.length && activity.wbs) {
    signals.wbs = input.recentWbs.some((w) => activity.wbs === w || activity.wbs!.startsWith(`${w}.`))
      ? 1 : 0;
  }

  if (event.activityRef && activity.ref) {
    signals.activityRef = norm(event.activityRef) === norm(activity.ref) ? 1 : 0;
  }

  // Weighted mean over the signals that actually fired. A report with little in
  // it scores on little, and the confidence says so.
  let total = 0, weight = 0;
  for (const k of SIGNALS) {
    const v = signals[k];
    if (v === undefined) continue;
    total += v * cfg.weights[k];
    weight += cfg.weights[k];
  }
  const score = weight > 0 ? total / weight : 0;
  return { activity, score: Math.max(0, Math.min(1, score)), signals };
}

/**
 * Rank every activity in the project against one report.
 *
 * ponytail: brute force over the whole schedule. 5000 activities × 256 floats
 * is a few milliseconds, and a pre-filter would only risk excluding the right
 * answer. Narrow it when a project needs more than one schedule's worth.
 */
export function rankCandidates(
  input: MatchInput, activities: Activity[], cfg: MatchConfig,
  vectors: Map<string, Float32Array>
): Scored[] {
  const reportText = [
    input.event.work, input.event.location, input.event.discipline,
    ...input.event.context,
  ].filter(Boolean).join(" · ");
  const reportVector = embedOne(reportText || "");

  const scored = activities.map((a) =>
    scoreActivity(input, a, cfg, reportVector, vectors.get(a.id) ?? embedOne(matchTextFor(a)))
  );

  scored.sort((x, y) =>
    y.score - x.score ||
    // Stable on ties, so a re-run of the same inputs ranks the same way.
    (x.activity.ref ?? x.activity.id).localeCompare(y.activity.ref ?? y.activity.id));

  return scored.filter((s) => s.score >= cfg.floor).slice(0, cfg.topN);
}

/** What should happen with this shortlist. */
export type Outcome = "auto_link_proposed" | "review" | "no_candidates";

export function decideOutcome(top: Scored | undefined, cfg: MatchConfig): Outcome {
  if (!top) return "no_candidates";
  return top.score >= cfg.autoLinkAt ? "auto_link_proposed" : "review";
}

/** Plain-language strength, for the "why this match" panel. */
export function describeSignal(v: number): "High" | "Good" | "Partial" | "Weak" | "None" {
  if (v >= 0.85) return "High";
  if (v >= 0.6) return "Good";
  if (v >= 0.35) return "Partial";
  if (v > 0) return "Weak";
  return "None";
}
