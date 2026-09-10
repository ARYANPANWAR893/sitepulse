"use client";

import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  IconAssign,
  IconCapture,
  IconLink,
  IconVerify,
  IconAnalyze,
  IconShow,
  IconLearn,
} from "@/components/icons";

type Stage = {
  n: string;
  title: string;
  body: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const STAGES: Stage[] = [
  {
    n: "01",
    title: "Assign",
    body: "Every field crew is mapped to the L5/L6 activities it owns, so a report starts with a shortlist, not the whole schedule.",
    Icon: IconAssign,
  },
  {
    n: "02",
    title: "Capture",
    body: "Supervisors send progress in plain language over WhatsApp. No app to open, no forms, no activity codes to remember.",
    Icon: IconCapture,
  },
  {
    n: "03",
    title: "Link",
    body: "An LLM plus self-hosted embeddings match the text to one activity, scored on semantic fit, assignment, schedule window and discipline.",
    Icon: IconLink,
  },
  {
    n: "04",
    title: "Verify",
    body: "Below the confidence floor or too close to call? It routes to a planner — or a clarifying question goes back to the field.",
    Icon: IconVerify,
  },
  {
    n: "05",
    title: "Analyze",
    body: "Confirmed progress rolls into forecast completion dates and three separate risk flags: behind, at-risk, and critical-path.",
    Icon: IconAnalyze,
  },
  {
    n: "06",
    title: "Show",
    body: "Planners work a review queue. Clients get a read-only dashboard, structurally walled off. Auditors get the full hash chain.",
    Icon: IconShow,
  },
];

export function Pipeline() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [lit, setLit] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        if (reduced) {
          setLit(STAGES.length);
          return;
        }
        let i = 0;
        const step = () => {
          i += 1;
          setLit(i);
          if (i < STAGES.length) window.setTimeout(step, 420);
        };
        window.setTimeout(step, 260);
      },
      { threshold: 0.3 }
    );

    io.observe(node);
    return () => io.disconnect();
  }, []);

  const progress = STAGES.length > 1 ? (Math.max(lit - 1, 0) / (STAGES.length - 1)) * 100 : 0;

  return (
    <div ref={ref}>
      {/* rail */}
      <div className="relative mb-8 hidden md:block">
        <div className="absolute top-1/2 right-0 left-0 h-px -translate-y-1/2 bg-line-strong" />
        <div
          className="absolute top-1/2 left-0 h-px -translate-y-1/2 bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
        <div className="relative flex justify-between">
          {STAGES.map((s, i) => (
            <span
              key={s.n}
              className="h-3 w-3 rounded-full border-2 transition-colors duration-300"
              style={{
                background: i < lit ? "var(--accent)" : "var(--paper)",
                borderColor: i < lit ? "var(--accent)" : "var(--line-strong)",
              }}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {STAGES.map((s, i) => {
          const on = i < lit;
          return (
            <div
              key={s.n}
              className="group relative rounded-xl border bg-paper-raised p-4 transition-all duration-500"
              style={{
                opacity: on ? 1 : 0.4,
                transform: on ? "translateY(0)" : "translateY(10px)",
                borderColor: on
                  ? "color-mix(in srgb, var(--accent) 40%, transparent)"
                  : "var(--line)",
              }}
            >
              <div className="mb-3 flex items-center justify-between">
                <span
                  className="grid h-9 w-9 place-items-center rounded-lg transition-colors duration-500"
                  style={{
                    background: on ? "var(--accent-soft)" : "var(--paper-sunk)",
                    color: on ? "var(--accent-strong)" : "var(--ink-soft)",
                  }}
                >
                  <s.Icon width={18} height={18} />
                </span>
                <span className="font-mono text-[0.7rem] text-ink-soft">{s.n}</span>
              </div>
              <h3 className="mb-1 font-display text-lg font-bold tracking-wide">{s.title}</h3>
              <p className="text-[0.82rem] leading-relaxed text-ink-soft">{s.body}</p>
            </div>
          );
        })}
      </div>

      {/* Learn layer */}
      <div
        className="mt-4 flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-paper-sunk/50 p-4 transition-opacity duration-700"
        style={{ opacity: lit >= STAGES.length ? 1 : 0.4 }}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-soft text-amber">
          <IconLearn width={18} height={18} />
        </span>
        <div>
          <h3 className="mb-1 font-display text-lg font-bold tracking-wide">
            Learn{" "}
            <span className="font-mono text-[0.7rem] text-ink-soft">· institutional memory</span>
          </h3>
          <p className="text-[0.82rem] leading-relaxed text-ink-soft">
            Every correction a planner makes nudges future scoring by a bounded ±0.15 and feeds a
            discipline-sliced memory of how each kind of work has actually progressed on past jobs.
          </p>
        </div>
      </div>
    </div>
  );
}
