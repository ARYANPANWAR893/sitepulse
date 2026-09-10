"use client";

import { useActionState, useState } from "react";
import { Note, Spinner } from "@/components/import-ui";
import type { IntakeState } from "@/app/intake-actions";

/**
 * The field report view.
 *
 * Built around one obligation: a reader must be able to see *why* a match was
 * proposed, not just how confident it was. The flow reads top to bottom —
 * ORIGINAL, UNDERSTOOD AS, MATCHED ACTIVITIES, WHY — because that is the order
 * the questions arrive in, and because a proposal nobody can interrogate is
 * indistinguishable from a guess.
 */

const EMPTY: IntakeState = {};
type Action = (s: IntakeState, f: FormData) => Promise<IntakeState>;

export type Understood = {
  work: string | null;
  progress: number | null;
  status: string | null;
  date: string | null;
  datePhrase: string | null;
  location: string | null;
  discipline: string | null;
  quantity: number | null;
  unit: string | null;
  activityRef: string | null;
  people: string[];
  equipment: string[];
  materials: string[];
  context: string[];
  provider: string;
  model: string | null;
  ok: boolean;
  error: string | null;
};

export type CandidateView = {
  activityId: string;
  ref: string | null;
  title: string;
  wbsPath: string | null;
  discipline: string | null;
  location: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  assigneeName: string | null;
  rank: number;
  score: number;
  signals: { key: string; label: string; value: number; strength: string }[];
};

export type ReportView = {
  id: string;
  rawText: string;
  reportedAt: number;
  reportedByName: string | null;
  source: string;
  linkedActivityId: string | null;
  linkedActivityLabel: string | null;
  confidence: number | null;
  matchMethod: string | null;
  reviewState: string;
  applied: boolean;
  claimedProgress: number | null;
  understood: Understood | null;
  candidates: CandidateView[];
  outcome: "auto_link_proposed" | "review" | "no_candidates" | null;
  runAt: number | null;
  runCount: number;
  decisions: { decision: string; byName: string; automatic: boolean; note: string | null; at: number }[];
};

const inputCls =
  "w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-[0.88rem] text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-accent";

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const STRENGTH_TONE: Record<string, string> = {
  High: "text-accent-strong", Good: "text-accent-strong",
  Partial: "text-amber", Weak: "text-amber", None: "text-ink-soft",
};

/** Confidence as a ring — a number people are meant to weigh, not trust blindly. */
function ConfidenceDial({ score, size = 46 }: { score: number; size?: number }) {
  const pct = Math.round(score * 100);
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const tone = pct >= 80 ? "var(--accent)" : pct >= 50 ? "var(--amber)" : "var(--rust)";
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--paper-sunk)" strokeWidth="4" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="4"
          strokeLinecap="round" strokeDasharray={circ}
          strokeDashoffset={circ * (1 - score)}
          style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <span className="absolute font-mono text-[0.68rem] font-semibold tabular-nums" style={{ color: tone }}>
        {pct}
      </span>
    </span>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line py-1">
      <dt className="shrink-0 text-ink-soft">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{value}</dd>
    </div>
  );
}

/** A value the reader did not find. Said plainly, because a blank looks like a bug. */
const NotStated = () => <span className="text-ink-soft italic">not stated</span>;

function UnderstoodPanel({ u }: { u: Understood }) {
  const stated = (v: string | number | null, suffix = "") =>
    v === null || v === "" ? <NotStated /> : <>{v}{suffix}</>;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <p className="font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Understood as</p>
        <span className="font-mono text-[0.68rem] text-ink-soft">
          {u.provider}{u.model ? ` · ${u.model}` : ""}
        </span>
      </div>
      {!u.ok && (
        <p className="mb-2 rounded-md bg-amber-soft px-2.5 py-1.5 text-[0.76rem] text-amber">
          The model didn&apos;t answer usably ({u.error}), so this is the rule-based reading.
        </p>
      )}
      <dl className="grid gap-x-6 text-[0.85rem] sm:grid-cols-2">
        <Row label="Work" value={stated(u.work)} />
        <Row label="Progress" value={stated(u.progress, "%")} />
        <Row label="Location" value={stated(u.location)} />
        <Row label="Discipline" value={stated(u.discipline)} />
        <Row label="Date" value={u.date ? <>{u.date}{u.datePhrase ? <span className="ml-1.5 font-mono text-[0.7rem] text-ink-soft">“{u.datePhrase}”</span> : null}</> : <NotStated />} />
        <Row label="Status" value={stated(u.status?.replace(/_/g, " ") ?? null)} />
        <Row label="Quantity" value={u.quantity !== null ? <>{u.quantity} {u.unit ?? ""}</> : <NotStated />} />
        <Row label="Activity ID quoted" value={stated(u.activityRef)} />
      </dl>
      {([["People", u.people], ["Equipment", u.equipment], ["Materials", u.materials], ["Context", u.context]] as const)
        .filter(([, list]) => list.length > 0)
        .map(([label, list]) => (
          <div key={label} className="mt-2 flex flex-wrap items-baseline gap-1.5">
            <span className="font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">{label}</span>
            {list.map((x) => (
              <span key={x} className="rounded-full bg-paper-sunk px-2 py-0.5 text-[0.76rem] text-ink">{x}</span>
            ))}
          </div>
        ))}
      <p className="mt-2 font-mono text-[0.7rem] text-ink-soft">
        Anything the report didn&apos;t say is left blank rather than guessed.
      </p>
    </div>
  );
}

function WhyPanel({ c }: { c: CandidateView }) {
  return (
    <div className="rounded-lg border border-line bg-paper-sunk/40 p-3">
      <p className="mb-2 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Why this match?</p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {c.signals.map((s) => (
          <li key={s.key} className="flex items-baseline justify-between gap-2 text-[0.82rem]">
            <span className="text-ink-soft">{s.label}</span>
            <span className="flex items-center gap-2">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-paper-sunk">
                <span className="block h-full rounded-full bg-accent-strong" style={{ width: `${s.value * 100}%` }} />
              </span>
              <span className={`w-14 text-right font-mono text-[0.72rem] ${STRENGTH_TONE[s.strength]}`}>
                {s.strength}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.72rem] leading-snug text-ink-soft">
        Signals the report said nothing about are left out of the score entirely, so a
        short report is matched on less evidence and scores lower for it.
      </p>
    </div>
  );
}

function CandidateCard({
  c, best, reportId, projectId, resolveAction, linked,
}: {
  c: CandidateView; best: boolean; reportId: string; projectId: string;
  resolveAction: Action; linked: boolean;
}) {
  const [state, run, pending] = useActionState(resolveAction, EMPTY);
  const [open, setOpen] = useState(best);

  return (
    <li className={`rounded-xl border p-3 transition-colors ${
      linked ? "border-accent bg-accent-soft/30" : best ? "border-accent/50 bg-paper-raised" : "border-line bg-paper-raised"
    }`}>
      <Note s={state} />
      <div className="flex flex-wrap items-start gap-3">
        <ConfidenceDial score={c.score} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-[0.74rem] text-accent-strong">{c.ref ?? "—"}</span>
            <span className="font-semibold text-ink">{c.title}</span>
            {linked && (
              <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[0.64rem] text-on-accent">linked</span>
            )}
            {best && !linked && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[0.64rem] text-accent-strong">
                best match
              </span>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[0.7rem] text-ink-soft">
            {[c.wbsPath, c.discipline, c.location, c.assigneeName].filter(Boolean).join(" · ") || "—"}
          </p>
          <p className="font-mono text-[0.7rem] text-ink-soft">
            {c.plannedStart ?? "—"} → {c.plannedFinish ?? "—"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setOpen((v) => !v)}
            className="rounded-md px-2 py-1 font-mono text-[0.72rem] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent-strong">
            {open ? "Hide why" : "Why?"}
          </button>
          {!linked && (
            <form action={run}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="reportId" value={reportId} />
              <input type="hidden" name="activityId" value={c.activityId} />
              <input type="hidden" name="decision" value="linked" />
              <button disabled={pending} className="btn btn-primary disabled:opacity-70">
                {pending ? <><Spinner />Linking…</> : "Link"}
              </button>
            </form>
          )}
        </div>
      </div>
      {open && <div className="mt-3"><WhyPanel c={c} /></div>}
    </li>
  );
}

function ReportCard({
  r, projectId, resolveAction, rematchAction, applyAction, canReview,
}: {
  r: ReportView; projectId: string;
  resolveAction: Action; rematchAction: Action; applyAction: Action;
  canReview: boolean;
}) {
  const [rematchState, runRematch] = useActionState(rematchAction, EMPTY);
  const [applyState, runApply] = useActionState(applyAction, EMPTY);
  const [rejectState, runReject] = useActionState(resolveAction, EMPTY);
  const [open, setOpen] = useState(false);

  const badge = r.applied
    ? { text: "applied", cls: "bg-accent text-on-accent" }
    : r.linkedActivityId
      ? { text: "linked · not applied", cls: "bg-accent-soft text-accent-strong" }
      : r.outcome === "no_candidates"
        ? { text: "no match", cls: "bg-rust-soft text-rust" }
        : { text: "needs review", cls: "bg-amber-soft text-amber" };

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-paper-raised">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[0.92rem] leading-relaxed text-ink">“{r.rawText}”</p>
          <p className="mt-1 font-mono text-[0.7rem] text-ink-soft">
            {r.reportedByName ?? "unattributed"} · {when(r.reportedAt)} · via {r.source}
            {r.runCount > 1 ? ` · ${r.runCount} match runs` : ""}
          </p>
        </div>
        <span className={`rounded-full px-2.5 py-1 font-mono text-[0.66rem] ${badge.cls}`}>{badge.text}</span>
        {r.candidates[0] && <ConfidenceDial score={r.candidates[0].score} size={40} />}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="rounded-md px-2 py-1 font-mono text-[0.72rem] text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent-strong">
          {open ? "Close" : "Review"}
        </button>
      </div>

      {open && (
        <div className="space-y-5 border-t border-line bg-paper px-4 py-4">
          <Note s={rematchState} />
          <Note s={applyState} />
          <Note s={rejectState} />

          <div>
            <p className="mb-1 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Original report</p>
            <p className="rounded-lg border border-line bg-paper-sunk/40 px-3 py-2 text-[0.9rem] leading-relaxed text-ink">
              {r.rawText}
            </p>
          </div>

          <p aria-hidden className="text-center font-mono text-[0.8rem] text-ink-soft">↓</p>

          {r.understood
            ? <UnderstoodPanel u={r.understood} />
            : <p className="text-[0.84rem] text-ink-soft">This report hasn&apos;t been read yet.</p>}

          <p aria-hidden className="text-center font-mono text-[0.8rem] text-ink-soft">↓</p>

          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
                Matched activities
              </p>
              <form action={runRematch}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="reportId" value={r.id} />
                <button className="font-mono text-[0.72rem] text-ink-soft transition-colors hover:text-accent-strong">
                  Re-read and re-score
                </button>
              </form>
            </div>

            {r.candidates.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line-strong px-3 py-6 text-center text-[0.84rem] text-ink-soft">
                Nothing in this schedule scored high enough to propose. Link it by hand from
                the Schedule page, or import the activities this report is about.
              </p>
            ) : (
              <ul className="space-y-2">
                {r.candidates.map((c) => (
                  <CandidateCard
                    key={c.activityId} c={c} best={c.rank === 1}
                    reportId={r.id} projectId={projectId}
                    resolveAction={resolveAction}
                    linked={c.activityId === r.linkedActivityId}
                  />
                ))}
              </ul>
            )}
          </div>

          {/* The two acts, kept visibly apart. */}
          <div className="space-y-3 border-t border-line pt-4">
            {r.linkedActivityId && !r.applied && canReview && (
              <div className="rounded-lg border border-accent/40 bg-accent-soft/25 p-3">
                <p className="text-[0.85rem] text-ink">
                  Linked to <b>{r.linkedActivityLabel}</b>. The schedule has <b>not</b> changed.
                  {r.claimedProgress !== null && <> Accepting sets its progress to <b>{r.claimedProgress}%</b>.</>}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(["accepted", "rejected"] as const).map((d) => (
                    <form key={d} action={runApply}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="reportId" value={r.id} />
                      <input type="hidden" name="decision" value={d} />
                      <button className={d === "accepted" ? "btn btn-primary" : "btn btn-ghost"}>
                        {d === "accepted" ? "Apply to the activity" : "Reject the claim"}
                      </button>
                    </form>
                  ))}
                </div>
              </div>
            )}
            {r.applied && (
              <p className="font-mono text-[0.76rem] text-accent-strong">
                Applied to {r.linkedActivityLabel}.
              </p>
            )}
            {!r.linkedActivityId && r.candidates.length > 0 && (
              <form action={runReject} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="reportId" value={r.id} />
                <input type="hidden" name="decision" value="rejected" />
                <label className="min-w-[16rem] flex-1">
                  <span className="mb-1 block font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
                    None of these — why?
                  </span>
                  <input name="note" placeholder="e.g. the activity isn't in the schedule yet" className={inputCls} />
                </label>
                <button className="btn btn-ghost">Reject all</button>
              </form>
            )}
          </div>

          {r.decisions.length > 0 && (
            <div className="border-t border-line pt-3">
              <p className="mb-1 font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">Decision history</p>
              <ul className="space-y-0.5 font-mono text-[0.72rem] text-ink-soft">
                {r.decisions.map((d, i) => (
                  <li key={i}>
                    {d.decision}{d.automatic ? " (automatic)" : ""} · {d.byName} · {when(d.at)}
                    {d.note ? ` · ${d.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function ReportsView({
  reports, projectId, canReview, submitAction, resolveAction, rematchAction, applyAction,
}: {
  reports: ReportView[]; projectId: string; canReview: boolean;
  submitAction: Action; resolveAction: Action; rematchAction: Action; applyAction: Action;
}) {
  const [state, runSubmit, submitting] = useActionState(submitAction, EMPTY);
  const [filter, setFilter] = useState<"all" | "review" | "linked">("all");

  const shown = reports.filter((r) =>
    filter === "all" ? true
    : filter === "review" ? !r.linkedActivityId
    : Boolean(r.linkedActivityId));

  const needsReview = reports.filter((r) => !r.linkedActivityId).length;

  return (
    <div className="space-y-5">
      <form action={runSubmit} className="space-y-2 rounded-xl border border-line bg-paper-raised p-4">
        <label className="block">
          <span className="mb-1 block font-mono text-[0.62rem] tracking-wider text-ink-soft uppercase">
            New field report
          </span>
          <textarea name="text" rows={2} required
            placeholder="Foundation excavation 80% complete near CDU today. Crew moved to cable trench."
            className={inputCls} />
        </label>
        <input type="hidden" name="projectId" value={projectId} />
        <Note s={state} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={submitting} className="btn btn-primary disabled:opacity-70">
            {submitting ? <><Spinner />Reading…</> : "Read and match"}
          </button>
          <p className="text-[0.76rem] text-ink-soft">
            Plain language. It gets read, matched against the schedule and shown to you —
            nothing is linked or applied without a decision.
          </p>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {([["all", `All (${reports.length})`], ["review", `Needs review (${needsReview})`],
           ["linked", `Linked (${reports.length - needsReview})`]] as const).map(([v, label]) => (
          <button key={v} type="button" onClick={() => setFilter(v)}
            className={`rounded-md px-2.5 py-1 font-mono text-[0.74rem] transition-colors ${
              filter === v ? "bg-accent text-on-accent" : "text-ink-soft hover:bg-paper-sunk hover:text-ink"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-4 py-12 text-center">
          <p className="font-display text-lg font-bold">
            {reports.length === 0 ? "No field reports yet." : "Nothing in this view."}
          </p>
          <p className="mx-auto mt-1 max-w-[52ch] text-[0.86rem] text-ink-soft">
            {reports.length === 0
              ? "Paste what a supervisor actually said above. SitePulse reads it, proposes the schedule activity it belongs to, and shows you why."
              : "Try another filter."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {shown.map((r) => (
            <ReportCard key={r.id} r={r} projectId={projectId} canReview={canReview}
              resolveAction={resolveAction} rematchAction={rematchAction} applyAction={applyAction} />
          ))}
        </ul>
      )}
    </div>
  );
}
