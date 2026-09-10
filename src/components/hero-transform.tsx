"use client";

import { useEffect, useRef, useState } from "react";

type Outcome = "auto_link" | "review";

type Sample = {
  sender: string;
  text: string;
  activity: string;
  name: string;
  discipline: string;
  progress: number;
  confidence: number;
  outcome: Outcome;
  block: string;
  hash: string;
};

const SAMPLES: Sample[] = [
  {
    sender: "M. Rautela · North rack crew",
    text: "24 inch line on north rack welded through, about 60% done",
    activity: "OIL-PIP-2010",
    name: "24-inch pipeline — North rack",
    discipline: "Piping",
    progress: 60,
    confidence: 87,
    outcome: "auto_link",
    block: "04913",
    hash: "9f2c1a",
  },
  {
    sender: "S. Ekka · Unit-3 electrical",
    text: "cable tray erection in Unit-3 finished today",
    activity: "OIL-ELE-3010",
    name: "Cable tray erection — Unit 3",
    discipline: "Electrical",
    progress: 100,
    confidence: 83,
    outcome: "auto_link",
    block: "04914",
    hash: "b7d0e4",
  },
  {
    sender: "R. Kandpal · Civil crew",
    text: "earthing pit installation done",
    activity: "—",
    name: "No activity above the confidence floor",
    discipline: "Ambiguous",
    progress: 0,
    confidence: 41,
    outcome: "review",
    block: "04915",
    hash: "3e91af",
  },
];

const SIGNALS = [
  { key: "semantic", label: "semantic", weight: "0.50" },
  { key: "assignment", label: "assignment", weight: "0.20" },
  { key: "window", label: "schedule window", weight: "0.15" },
  { key: "discipline", label: "discipline", weight: "0.15" },
];

type Phase = "typing" | "sent" | "matching" | "resolved";

// The resolved state is the payoff, so it holds longest — the pending phases
// exist to explain how it got there, not to make anyone wait.
const PHASE_MS: Record<Phase, number> = {
  typing: 1600,
  sent: 500,
  matching: 1250,
  resolved: 4600,
};

const NEXT_PHASE: Record<Phase, Phase> = {
  typing: "sent",
  sent: "matching",
  matching: "resolved",
  resolved: "typing",
};

export function HeroTransform() {
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [typed, setTyped] = useState("");
  const [reduced, setReduced] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sample = SAMPLES[idx];

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // phase driver
  useEffect(() => {
    timer.current = setTimeout(
      () => {
        const next = NEXT_PHASE[phase];
        if (next === "typing") setIdx((i) => (i + 1) % SAMPLES.length);
        setPhase(next);
      },
      reduced ? Math.min(PHASE_MS[phase], 2200) : PHASE_MS[phase]
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase, reduced]);

  // typewriter for the incoming message
  useEffect(() => {
    if (phase !== "typing" || reduced) {
      setTyped(sample.text);
      return;
    }
    setTyped("");
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTyped(sample.text.slice(0, i));
      if (i >= sample.text.length) clearInterval(id);
    }, 34);
    return () => clearInterval(id);
  }, [phase, idx, sample.text, reduced]);

  const showResult = phase === "resolved";
  const isReview = sample.outcome === "review";
  const progressPhase = phase === "matching" || phase === "resolved";

  return (
    <div className="relative w-full max-w-[440px]">
      {/* connector glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] opacity-70 blur-2xl"
        style={{
          background:
            "radial-gradient(60% 50% at 50% 40%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 70%)",
        }}
      />

      {/* Incoming message */}
      <div className="rounded-2xl border border-line-strong bg-paper-raised p-4 shadow-[var(--shadow-raised)]">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[0.7rem] tracking-wider text-ink-soft uppercase">
            WhatsApp · field report
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[0.7rem] text-ink-soft">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                phase === "typing" ? "bg-amber" : "bg-accent"
              }`}
            />
            {phase === "typing" ? "typing" : "delivered"}
          </span>
        </div>
        <div className="rounded-xl rounded-tl-sm bg-paper-sunk px-3.5 py-2.5">
          <div className="mb-1 font-mono text-[0.68rem] text-ink-soft">{sample.sender}</div>
          <p className="min-h-[2.7rem] text-[0.95rem] leading-snug text-ink">
            {typed}
            {phase === "typing" && !reduced && (
              <span className="caret ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 bg-accent" />
            )}
          </p>
        </div>
      </div>

      {/* Pipe */}
      <div className="relative mx-auto flex h-14 w-px justify-center">
        <span className="absolute inset-0 w-px bg-line-strong" />
        {!reduced && (
          <span
            className="absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-accent"
            style={{
              animation: "sp-float 1.4s ease-in-out infinite",
              boxShadow: "0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent)",
            }}
          />
        )}
      </div>

      {/* SitePulse resolver */}
      <div className="relative overflow-hidden rounded-2xl border border-accent/40 bg-paper-raised shadow-[var(--shadow-raised)]">
        <div className="flex items-center justify-between border-b border-line bg-accent-soft/60 px-4 py-2">
          <span className="font-display text-sm font-bold tracking-wide text-accent-strong uppercase">
            SitePulse · link
          </span>
          <span className="font-mono text-[0.7rem] text-accent-strong">
            {phase === "matching"
              ? "scoring 240 activities…"
              : showResult
                ? isReview
                  ? "escalated"
                  : "auto-linked"
                : "idle"}
          </span>
        </div>

        {/* scanning bar */}
        <div className="h-0.5 w-full bg-paper-sunk">
          <div
            className={`h-full bg-accent transition-[width] duration-700 ease-out ${
              phase === "matching" ? "sheen" : ""
            }`}
            style={{
              width:
                phase === "typing"
                  ? "0%"
                  : phase === "sent"
                    ? "12%"
                    : phase === "matching"
                      ? "68%"
                      : "100%",
            }}
          />
        </div>

        <div className="space-y-3 p-4">
          {/* signal chips */}
          <div className="flex flex-wrap gap-1.5">
            {SIGNALS.map((s, i) => (
              <span
                key={s.key}
                className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-[0.68rem] transition-all duration-500"
                style={{
                  opacity: progressPhase ? 1 : 0.35,
                  transform: progressPhase ? "translateY(0)" : "translateY(3px)",
                  transitionDelay: `${i * 90}ms`,
                  color: progressPhase ? "var(--accent-strong)" : "var(--ink-soft)",
                  borderColor: progressPhase
                    ? "color-mix(in srgb, var(--accent) 45%, transparent)"
                    : "var(--line)",
                }}
              >
                {s.label}
                <span className="text-ink-soft">{s.weight}</span>
              </span>
            ))}
          </div>

          {/* Result card. Pending phases render a skeleton at the same height so
              the panel never collapses and never looks empty. */}
          <div className="relative rounded-xl border border-line bg-paper p-3">
            {!showResult && (
              <div className="space-y-2" aria-hidden>
                <div className="flex justify-end">
                  <span className="font-mono text-[0.66rem] tracking-wide text-ink-soft uppercase">
                    {phase === "matching" ? "scoring" : "waiting"}
                  </span>
                </div>
                <div className="h-3 w-2/3 animate-pulse rounded bg-paper-sunk" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-paper-sunk" />
              </div>
            )}

            <div
              className="transition-all duration-500"
              style={{
                opacity: showResult ? 1 : 0,
                transform: showResult ? "translateY(0)" : "translateY(8px)",
                position: showResult ? "static" : "absolute",
                inset: showResult ? undefined : 12,
              }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span
                  className={`font-mono text-[0.82rem] font-medium ${
                    isReview ? "text-amber" : "text-accent-strong"
                  }`}
                >
                  {sample.activity}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[0.66rem] tracking-wide uppercase ${
                    isReview ? "bg-amber-soft text-amber" : "bg-accent-soft text-accent-strong"
                  }`}
                >
                  {isReview ? "planner review" : "confirmed"}
                </span>
              </div>
              <p className="mb-3 text-[0.9rem] leading-snug text-ink">{sample.name}</p>

              <div className="grid grid-cols-2 gap-3 text-[0.78rem]">
                <Field label="Progress">{isReview ? "— pending" : `${sample.progress}%`}</Field>
                <Field label="Discipline">{sample.discipline}</Field>
              </div>

              {/* confidence meter */}
              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between font-mono text-[0.7rem] text-ink-soft">
                  <span>composite confidence</span>
                  <span className={isReview ? "text-amber" : "text-accent-strong"}>
                    {showResult ? `0.${sample.confidence}` : "0.00"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper-sunk">
                  <div
                    className="h-full rounded-full transition-[width] duration-[900ms] ease-out"
                    style={{
                      width: showResult ? `${sample.confidence}%` : "0%",
                      background: isReview ? "var(--amber)" : "var(--accent)",
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between font-mono text-[0.66rem] text-ink-soft">
                  <span>floor 0.62</span>
                  <span>{isReview ? "below floor → human" : "auto-link ≥ 0.80"}</span>
                </div>
              </div>

              {/* audit line */}
              <div className="mt-3 flex items-center gap-2 border-t border-line pt-2 font-mono text-[0.66rem] text-ink-soft">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink-soft/50" />
                audit&nbsp;·&nbsp;block #{sample.block}&nbsp;·&nbsp;sha256 {sample.hash}…&nbsp;·&nbsp;append-only
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-mono text-[0.64rem] tracking-wide text-ink-soft uppercase">{label}</div>
      <div className="text-ink">{children}</div>
    </div>
  );
}
