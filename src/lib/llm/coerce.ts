import { EMPTY_FIELD_EVENT, type FieldEvent } from "./types.ts";

/**
 * The airlock.
 *
 * Everything a provider returns passes through here before it exists anywhere
 * else in the system. A model can return the wrong shape, the wrong types, a
 * 4200% progress, a date of "soon", forty megabytes of prose, `null` where an
 * array belongs, or valid JSON describing something else entirely — and the
 * worst any of that can do is produce nulls.
 *
 * The rule throughout: **a field that cannot be understood becomes null, and
 * the rest of the event still stands.** One bad key must not discard a good
 * reading, and no bad key may ever reach the database.
 */

const MAX_TEXT = 400;
const MAX_LIST = 12;
const MAX_ITEM = 80;

const str = (v: unknown, max = MAX_TEXT): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : null;
};

/** A list of short strings. Anything that isn't becomes an empty list. */
function list(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const s = str(item, MAX_ITEM);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** 0-100 from a number or a string like "80" / "80%" / " 80 % ". */
export function percent(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/%/g, "").trim());
  // Out of range is refused rather than clamped: a model that says 4200% has
  // misread something, and silently storing 100 would hide that.
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}

const STATUSES = new Set(["not_started", "in_progress", "completed", "blocked"]);
const STATUS_ALIASES: Record<string, FieldEvent["status"]> = {
  "not started": "not_started", pending: "not_started", planned: "not_started",
  "in progress": "in_progress", ongoing: "in_progress", started: "in_progress",
  wip: "in_progress", active: "in_progress",
  complete: "completed", done: "completed", finished: "completed",
  held: "blocked", stopped: "blocked", halted: "blocked", blocked: "blocked",
};

function status(v: unknown): FieldEvent["status"] {
  const s = str(v, 40)?.toLowerCase();
  if (!s) return null;
  const norm = s.replace(/[\s-]+/g, "_");
  if (STATUSES.has(norm)) return norm as FieldEvent["status"];
  return STATUS_ALIASES[s] ?? null;
}

/** ISO only, and a real calendar day — 2026-02-31 is refused, not rolled over. */
export function isoDate(v: unknown): string | null {
  const s = str(v, 40);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Pulls a JSON object out of whatever a model actually sent.
 *
 * Chat models wrap JSON in prose, in ```json fences, or emit it with a leading
 * apology. This finds the outermost balanced object and parses that. Returns
 * null rather than throwing — the caller records the failure and moves on.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;

  const start = body.indexOf("{");
  if (start < 0) return null;
  // Walk to the matching brace, ignoring braces inside strings.
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(body.slice(start, i + 1));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      } catch { return null; }
    }
  }
  return null;
}

/** Accepts the aliases a model reaches for when it ignores the schema. */
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
};

/** Turns anything at all into a valid FieldEvent. Never throws. */
export function coerceFieldEvent(input: unknown): FieldEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...EMPTY_FIELD_EVENT };
  }
  const o = input as Record<string, unknown>;
  return {
    work: str(pick(o, "work", "activity", "task", "description", "work_description")),
    progress: percent(pick(o, "progress", "progress_percent", "percent", "percentage", "pct")),
    status: status(pick(o, "status", "state")),
    date: isoDate(pick(o, "date", "event_date", "reported_date")),
    datePhrase: str(pick(o, "datePhrase", "date_phrase", "date_text"), 60),
    location: str(pick(o, "location", "area", "zone", "place"), 120),
    discipline: str(pick(o, "discipline", "trade", "craft"), 60),
    quantity: num(pick(o, "quantity", "qty", "amount")),
    unit: str(pick(o, "unit", "units", "uom"), 20),
    activityRef: str(pick(o, "activityRef", "activity_ref", "activity_id", "activityId", "code"), 40),
    people: list(pick(o, "people", "persons", "crew", "team", "names")),
    equipment: list(pick(o, "equipment", "machines", "plant")),
    materials: list(pick(o, "materials", "material")),
    context: list(pick(o, "context", "contextual_phrases", "notes", "other")),
  };
}
