import { SiteHeader } from "@/components/site-header";
import { currentUser } from "@/lib/session";
import { HeroTransform } from "@/components/hero-transform";
import { Pipeline } from "@/components/pipeline";
import { Reveal } from "@/components/reveal";
import {
  IconArrowRight,
  IconGitHub,
  IconSpark,
  IconVerify,
  IconChain,
  IconAlert,
  IconUser,
  IconCapture,
  IconShow,
} from "@/components/icons";

const REPO = "https://github.com/ARYANPANWAR893/SIH---SitePulse";

const PROBLEMS = [
  {
    k: "Which activity?",
    v: "“Cable tray done in Unit-3” maps to any of a dozen L6 line items. Field crews can’t be expected to carry activity codes in their heads.",
  },
  {
    k: "How much progress?",
    v: "Plain text carries no structured percent-complete, no quantities — nothing a forecast or an earned-value roll-up can actually consume.",
  },
  {
    k: "Prove it in a dispute.",
    v: "On a PSU contract a progress claim is a legal artifact. A folder of WhatsApp screenshots is not an audit trail anyone will defend.",
  },
];

const PEOPLE = [
  {
    role: "Reporter",
    who: "Field supervisor",
    lives: "WhatsApp only — never opens the web app",
    note: "Zero friction, no jargon, no confidence scores shown. The deliberately unreliable source the whole pipeline exists to sanity-check.",
    Icon: IconCapture,
  },
  {
    role: "Operator",
    who: "Planner / project-controls engineer",
    lives: "Upload, Review, Unmatched, Variance, Memory",
    note: "The human in the loop. The system escalates to them exactly when its own confidence drops — never silently, never too late.",
    Icon: IconUser,
  },
  {
    role: "Viewer",
    who: "Client / senior management",
    lives: "A read-only dashboard, on its own route",
    note: "Structurally isolated from the contractor workspace — not a hidden nav link, a separate app. Wants one number and a trend.",
    Icon: IconShow,
  },
  {
    role: "Auditor",
    who: "Compliance / dispute resolution",
    lives: "The append-only hash chain",
    note: "Occasional, not daily. When a contract claim is challenged, the record has to hold — every entry, in order, tamper-evident.",
    Icon: IconChain,
  },
];

const TRUST = [
  {
    Icon: IconSpark,
    title: "Confidence is a composite, not a guess",
    body: "A weighted average of four signals — semantic similarity 0.50, assignment match 0.20, schedule-window proximity 0.15, discipline match 0.15 — gated by an independent semantic floor and an ambiguity margin for top-two-close calls.",
  },
  {
    Icon: IconVerify,
    title: "Human-in-the-loop by design",
    body: "Auto-link, review, no-match, or ambiguous. Anything under the floor or too close to call goes to a planner, or sends a clarifying question back to the field. The system never quietly guesses.",
  },
  {
    Icon: IconChain,
    title: "One hash chain, enforced by the database",
    body: "A single global SHA-256 chain over every action. Postgres triggers physically reject UPDATE and DELETE on the log — append-only by construction, not by convention.",
  },
  {
    Icon: IconAlert,
    title: "Three risk flags, never conflated",
    body: "Behind (self), at-risk (cascaded from a troubled predecessor) and critical (on the longest dependency chain) are tracked separately. A finished activity stops propagating trouble downstream.",
  },
];

const STACK = [
  "Next.js",
  "FastAPI",
  "Supabase / Postgres",
  "Groq → Gemini fallback",
  "sentence-transformers (MiniLM)",
  "Vercel + Render",
];

// Reading the session makes this route dynamic. Fine for one page — the
// alternative is a client-side session fetch and a flash of the wrong nav.
export default async function Home() {
  const session = await currentUser();
  return (
    <div id="top" className="relative">
      <SiteHeader user={session && { name: session.name }} />

      {/* ---------------------------------------------------------------- HERO */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="blueprint-grid pointer-events-none absolute inset-0 -z-10" />
        <div className="mx-auto grid max-w-[1180px] items-center gap-10 px-5 pt-10 pb-14 sm:gap-14 sm:pt-16 sm:pb-20 lg:grid-cols-[1.05fr_0.95fr] lg:pt-24 lg:pb-28">
          <div>
            <div className="rise mb-5 inline-flex items-center gap-2 rounded-full border border-line-strong bg-paper-raised px-3 py-1.5 font-mono text-[0.68rem] tracking-wider text-ink-soft uppercase sm:text-[0.72rem]">
              <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              Field-to-schedule intelligence
              <span className="hidden sm:inline">· Oil India Limited</span>
            </div>

            <h1
              className="rise font-display text-[2.15rem] leading-[1] font-extrabold tracking-tight sm:text-[3.4rem] sm:leading-[0.98] lg:text-[4.1rem]"
              style={{ animationDelay: "70ms" }}
            >
              Turn a supervisor’s text message
              <br className="hidden sm:block" />{" "}
              into an <span className="text-accent-strong">audit-proof</span> schedule update.
            </h1>

            <p
              className="rise mt-6 max-w-[42ch] text-[1.02rem] leading-relaxed text-ink-soft"
              style={{ animationDelay: "150ms" }}
            >
              Field crews report progress the way they already talk — one WhatsApp line, no forms,
              no activity codes. SitePulse links every update to the right L5/L6 activity with a
              confidence score, keeps a hash-chained audit trail, and asks a human whenever it isn’t
              sure.
            </p>

            <div
              className="rise mt-8 flex flex-wrap items-center gap-3"
              style={{ animationDelay: "230ms" }}
            >
              <a href="#demo" className="btn btn-primary">
                See it work <IconArrowRight width={16} height={16} />
              </a>
              <a href="#how" className="btn btn-ghost">
                How it works
              </a>
              <a href={REPO} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                <IconGitHub width={15} height={15} /> Source
              </a>
            </div>

            {/* Two tidy columns on phones — a plain flex-wrap left a ragged,
                orphaned last item. Single row from sm up. */}
            <div
              className="rise mt-9 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[0.72rem] text-ink-soft sm:flex sm:flex-wrap sm:gap-x-5 sm:text-[0.74rem]"
              style={{ animationDelay: "310ms" }}
            >
              {[
                "Groq → Gemini fallback",
                "self-hosted embeddings",
                "append-only audit",
                "human-in-the-loop",
              ].map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-ink-soft/50" />
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div
            id="demo"
            className="rise flex justify-center lg:justify-end"
            style={{ animationDelay: "190ms" }}
          >
            <HeroTransform />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- PROBLEM */}
      <section id="problem" className="border-t border-line bg-paper-raised">
        <div className="mx-auto max-w-[1180px] px-5 py-16 sm:py-20 lg:py-28">
          <Reveal
            as="p"
            className="mb-3 font-mono text-[0.75rem] tracking-widest text-accent-strong uppercase"
          >
            The problem
          </Reveal>
          <Reveal
            as="h2"
            delay={60}
            className="max-w-[18ch] font-display text-[1.85rem] leading-[1.05] font-bold sm:text-[2.6rem] sm:leading-[1.02] lg:text-5xl"
          >
            A schedule can’t reconcile a sentence.
          </Reveal>
          <Reveal as="p" delay={120} className="mt-5 max-w-[58ch] text-ink-soft">
            The official plan is a structured L5/L6 network in Primavera. The reality on site comes
            in as free text from dozens of crews. Between the two sits a planner, retyping WhatsApp
            into a schedule and hoping nothing gets lost.
          </Reveal>

          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {PROBLEMS.map((p, i) => (
              <Reveal
                key={p.k}
                delay={i * 90}
                className="rounded-xl border border-line bg-paper p-5"
              >
                <div className="mb-3 font-mono text-[0.8rem] text-rust">0{i + 1}</div>
                <h3 className="mb-2 font-display text-xl font-bold tracking-wide">{p.k}</h3>
                <p className="text-[0.88rem] leading-relaxed text-ink-soft">{p.v}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- HOW */}
      <section id="how" className="border-t border-line">
        <div className="mx-auto max-w-[1180px] px-5 py-16 sm:py-20 lg:py-28">
          <Reveal
            as="p"
            className="mb-3 font-mono text-[0.75rem] tracking-widest text-accent-strong uppercase"
          >
            How it works
          </Reveal>
          <Reveal
            as="h2"
            delay={60}
            className="max-w-[20ch] font-display text-[1.85rem] leading-[1.05] font-bold sm:text-[2.6rem] sm:leading-[1.02] lg:text-5xl"
          >
            Six stages, one honest pipeline.
          </Reveal>
          <Reveal as="p" delay={120} className="mt-5 mb-14 max-w-[58ch] text-ink-soft">
            Assign, Capture, Link, Verify, Analyze, Show — with a Learn layer underneath. Every
            stage either produces something a person can check, or hands the decision to one.
          </Reveal>

          <Reveal delay={60}>
            <Pipeline />
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------------- PEOPLE */}
      <section id="people" className="border-t border-line bg-paper-raised">
        <div className="mx-auto max-w-[1180px] px-5 py-16 sm:py-20 lg:py-28">
          <Reveal
            as="p"
            className="mb-3 font-mono text-[0.75rem] tracking-widest text-accent-strong uppercase"
          >
            Who it’s for
          </Reveal>
          <Reveal
            as="h2"
            delay={60}
            className="max-w-[22ch] font-display text-[1.85rem] leading-[1.05] font-bold sm:text-[2.6rem] sm:leading-[1.02] lg:text-5xl"
          >
            Four people, four windows into the same record.
          </Reveal>
          <Reveal as="p" delay={120} className="mt-5 max-w-[58ch] text-ink-soft">
            Roles are cut by relationship to the system, not job title — that’s what decides which
            screens someone needs and how much they’re allowed to touch.
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {PEOPLE.map((p, i) => (
              <Reveal
                key={p.role}
                delay={(i % 2) * 90}
                className="flex gap-4 rounded-xl border border-line bg-paper p-5"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-strong">
                  <p.Icon width={20} height={20} />
                </span>
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <h3 className="font-display text-xl font-bold tracking-wide">{p.role}</h3>
                    <span className="font-mono text-[0.72rem] text-ink-soft">{p.who}</span>
                  </div>
                  <div className="mt-0.5 mb-2 font-mono text-[0.72rem] text-accent-strong">
                    {p.lives}
                  </div>
                  <p className="text-[0.86rem] leading-relaxed text-ink-soft">{p.note}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------------- TRUST */}
      <section id="trust" className="border-t border-line">
        <div className="mx-auto max-w-[1180px] px-5 py-16 sm:py-20 lg:py-28">
          <Reveal
            as="p"
            className="mb-3 font-mono text-[0.75rem] tracking-widest text-accent-strong uppercase"
          >
            Trust &amp; audit
          </Reveal>
          <Reveal
            as="h2"
            delay={60}
            className="max-w-[16ch] font-display text-[1.85rem] leading-[1.05] font-bold sm:text-[2.6rem] sm:leading-[1.02] lg:text-5xl"
          >
            Built to be doubted.
          </Reveal>
          <Reveal as="p" delay={120} className="mt-5 max-w-[58ch] text-ink-soft">
            The reporting source is unreliable by nature, so every downstream number has to be
            defensible. Four decisions carry that weight.
          </Reveal>

          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {TRUST.map((t, i) => (
              <Reveal
                key={t.title}
                delay={(i % 2) * 90}
                className="rounded-xl border border-line bg-paper-raised p-6"
              >
                <span className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-accent-soft text-accent-strong">
                  <t.Icon width={19} height={19} />
                </span>
                <h3 className="mb-2 font-display text-xl font-bold tracking-wide">{t.title}</h3>
                <p className="text-[0.88rem] leading-relaxed text-ink-soft">{t.body}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- CTA */}
      <section className="border-t border-line bg-paper-raised">
        <div className="mx-auto max-w-[1180px] px-5 py-16 text-center sm:py-20 lg:py-24">
          <Reveal
            as="h2"
            className="mx-auto max-w-[20ch] font-display text-[1.8rem] leading-[1.08] font-bold sm:text-[2.75rem]"
          >
            The site already sent the update. SitePulse makes it count.
          </Reveal>
          <Reveal as="div" delay={80} className="mt-8 flex flex-wrap justify-center gap-3">
            <a href="#demo" className="btn btn-primary">
              Replay the walkthrough <IconArrowRight width={16} height={16} />
            </a>
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
              <IconGitHub width={15} height={15} /> Read the code
            </a>
          </Reveal>
        </div>
      </section>

      {/* -------------------------------------------------------------- FOOTER */}
      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1180px] px-5 py-12">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-[38ch]">
              <div className="flex items-center gap-2.5">
                <span className="grid h-6 w-6 place-items-center rounded bg-accent text-on-accent">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 12h4l2.5-7 5 18 2.5-11H21" />
                  </svg>
                </span>
                <span className="font-display text-lg font-extrabold tracking-wide">SitePulse</span>
              </div>
              <p className="mt-3 text-[0.82rem] leading-relaxed text-ink-soft">
                Smart India Hackathon 2026 · Problem Statement SIH26122 · Oil India Limited. A
                field-to-schedule intelligence layer with a human in the loop.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <span className="font-mono text-[0.7rem] tracking-widest text-ink-soft uppercase">
                Built with
              </span>
              <div className="flex max-w-[24rem] flex-wrap gap-1.5">
                {STACK.map((s) => (
                  <span
                    key={s}
                    className="rounded border border-line bg-paper-raised px-2 py-0.5 font-mono text-[0.7rem] text-ink-soft"
                  >
                    {s}
                  </span>
                ))}
              </div>
              <a
                href={REPO}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 -ml-1 flex min-h-[44px] items-center gap-2 rounded px-1 font-mono text-[0.78rem] text-ink-soft transition-colors hover:text-accent-strong"
              >
                <IconGitHub width={15} height={15} /> ARYANPANWAR893/SIH---SitePulse
              </a>
            </div>
          </div>

          <div className="mt-10 border-t border-line pt-5 font-mono text-[0.7rem] text-ink-soft">
            Student prototype for SIH 2026. Not affiliated with, sponsored by, or endorsed by Oil
            India Limited.
          </div>
        </div>
      </footer>
    </div>
  );
}
