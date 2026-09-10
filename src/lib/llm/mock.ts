import { EMPTY_FIELD_EVENT, type ExtractionContext, type ExtractionResult, type FieldEvent, type LlmProvider } from "./types.ts";
import { coerceFieldEvent } from "./coerce.ts";

/**
 * A rule-based reader. No network, no key, no variance.
 *
 * Two jobs. It is the demo and test provider — the same input always gives the
 * same output, which is what makes the matcher testable at all. And it is the
 * floor: when no API key is configured, or a hosted model is down or returns
 * rubbish, this still produces something usable rather than nothing.
 *
 * It is grounded rather than clever. Locations, disciplines, people and
 * activity codes are recognised because the *project* has them, not because a
 * pattern looked plausible — which is also why it cannot hallucinate a location
 * that does not exist. What it cannot find, it leaves null.
 *
 * ponytail: regex and a vocabulary lookup. A real model reads nuance this
 * cannot ("crew stood down waiting on the crane" → blocked). Swap the provider;
 * nothing above this file changes.
 */

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Words that mean a day, relative to the report's own timestamp. */
function readDate(text: string, now: number): { date: string | null; phrase: string | null } {
  const t = text.toLowerCase();

  const explicit = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (explicit) return { date: explicit[1], phrase: explicit[1] };

  // Day-first, as an Indian site writes it.
  const dmy = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(text);
  if (dmy) {
    const [, d, mo, y] = dmy;
    const cand = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const parsed = new Date(`${cand}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === cand) {
      return { date: cand, phrase: dmy[0] };
    }
  }

  for (const [re, offset] of [
    [/\btoday\b/, 0], [/\btonight\b/, 0], [/\bthis morning\b/, 0], [/\bthis afternoon\b/, 0],
    [/\byesterday\b/, -1], [/\blast night\b/, -1],
    [/\btomorrow\b/, 1],
  ] as const) {
    const m = re.exec(t);
    if (m) return { date: iso(now + offset * DAY), phrase: m[0] };
  }

  const ago = /\b(\d{1,2})\s+days?\s+ago\b/.exec(t);
  if (ago) return { date: iso(now - Number(ago[1]) * DAY), phrase: ago[0] };

  return { date: null, phrase: null };
}

const STATUS_RULES: [RegExp, FieldEvent["status"]][] = [
  [/\b(held|holding|stopped|halted|blocked|on hold|waiting on|standing by|stood down)\b/, "blocked"],
  [/\b(complete[d]?|finished|done|closed out|handed over)\b/, "completed"],
  [/\b(start(ed|ing)?|commenced|underway|in progress|ongoing|continuing|resumed)\b/, "in_progress"],
  [/\b(not started|yet to start|pending|planned for)\b/, "not_started"],
];

/** Longest vocabulary entry that appears in the text, so "CDU Unit 2" beats "CDU". */
function matchVocab(text: string, vocab: string[]): string | null {
  const t = text.toLowerCase();
  let best: string | null = null;
  for (const v of vocab) {
    const needle = v.trim().toLowerCase();
    if (!needle || needle.length < 2) continue;
    // Word-boundary match, so "CDU" doesn't fire inside "CDUX".
    const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(t) && (!best || needle.length > best.length)) best = v;
  }
  return best;
}

const UNITS = "m|mm|cm|km|m2|m3|sqm|cum|nos?|ea|t|te|tonnes?|tons?|kg|ltr|l|joints?|welds?|pcs?|bags?|trucks?|loads?";

/**
 * Everything before the first progress/status clause, cleaned of the phrases
 * that belong to other fields. This is the "what work" line.
 */
function readWork(text: string, cut: string[]): string | null {
  let head = text.split(/[.;\n]/)[0] ?? text;
  for (const c of cut) {
    if (c) head = head.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }
  head = head
    .replace(/\b\d+(\.\d+)?\s*%/g, " ")
    .replace(new RegExp(`\\b\\d+(\\.\\d+)?\\s*(${UNITS})\\b`, "ig"), " ")
    .replace(/\b(complete[d]?|finished|done|in progress|ongoing|started|underway|held|blocked)\b/ig, " ")
    .replace(/\b(near|at|in|on|for|by|of|the|is|was|are|were)\b\s*$/i, " ")
    .replace(/^\s*(and|then|also|update|report)\b/i, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.\-–—]+|[\s,.\-–—]+$/g, "");
  return head.length > 2 ? head.slice(0, 200) : null;
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "rules-v1";

  async extractFieldEvent(text: string, ctx: ExtractionContext): Promise<ExtractionResult> {
    const base: ExtractionResult = {
      provider: this.name, model: this.model, modelVersion: "1",
      raw: null, ok: true, error: null, event: { ...EMPTY_FIELD_EVENT },
    };
    if (typeof text !== "string" || !text.trim()) {
      return { ...base, ok: false, error: "empty report" };
    }
    const clean = text.trim().slice(0, 4000);

    const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(clean);
    const { date, phrase } = readDate(clean, ctx.now);

    let status: FieldEvent["status"] = null;
    for (const [re, s] of STATUS_RULES) if (re.test(clean.toLowerCase())) { status = s; break; }
    // "80% complete" is progress, not completion. Only 100 means finished.
    const progress = pct ? Number(pct[1]) : null;
    if (status === "completed" && progress !== null && progress < 100) status = "in_progress";

    const location = matchVocab(clean, ctx.locations);
    const discipline = matchVocab(clean, ctx.disciplines);
    const people = ctx.people.filter((p) => matchVocab(clean, [p]));
    const ref = ctx.activityRefs.find((r) =>
      new RegExp(`(^|[^a-z0-9])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(clean));

    const qty = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\b`, "i").exec(clean);
    // A percentage is not a quantity, even though it parses like one.
    const quantity = qty && !/^%/.test(qty[2]) ? Number(qty[1]) : null;
    const unit = quantity !== null ? qty![2].toLowerCase() : null;

    // Sentences after the first are context — "Crew moved to cable trench".
    const rest = clean.split(/[.;\n]/).slice(1).map((s) => s.trim()).filter((s) => s.length > 2);

    const work = readWork(clean, [phrase ?? "", location ?? "", ...people, ref ?? ""]);

    // Through the same airlock as any hosted model. The rules are trusted no
    // further than a stranger's JSON.
    const event = coerceFieldEvent({
      work, progress, status, date, datePhrase: phrase,
      location, discipline, quantity, unit, activityRef: ref ?? null,
      people, equipment: [], materials: [], context: rest,
    });

    return { ...base, event, raw: JSON.stringify(event) };
  }
}
