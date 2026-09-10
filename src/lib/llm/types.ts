/**
 * The boundary between SitePulse and whatever is reading the field reports.
 *
 * No provider detail crosses this file. The application asks for a FieldEvent
 * and gets one; whether that came from a rule-based reader, Groq, Gemini or a
 * model on a laptop is a configuration question, not an architectural one.
 *
 * Deliberately not `server-only`: the types are shared with the UI.
 */

/**
 * A field report, read.
 *
 * **Every field is nullable, and that is the contract.** A report that says
 * nothing about location has `location: null` — never a guess, never an
 * inference from the project's most common location. A wrong value here becomes
 * a wrong match, and a wrong match that looks confident is worse than no match.
 */
export type FieldEvent = {
  /** The work being described. "Foundation excavation". */
  work: string | null;
  /** 0-100, only when the text states it. */
  progress: number | null;
  status: "not_started" | "in_progress" | "completed" | "blocked" | null;
  /** Resolved to ISO. Null when the text carries no date at all. */
  date: string | null;
  /** The words the date came from — "today", "last Tuesday" — kept for review. */
  datePhrase: string | null;
  location: string | null;
  discipline: string | null;
  quantity: number | null;
  unit: string | null;
  /** An Activity ID quoted in the text. Near-definitive when present. */
  activityRef: string | null;
  people: string[];
  equipment: string[];
  materials: string[];
  /** Clauses that carry meaning but aren't any of the above. */
  context: string[];
};

export const EMPTY_FIELD_EVENT: FieldEvent = {
  work: null, progress: null, status: null, date: null, datePhrase: null,
  location: null, discipline: null, quantity: null, unit: null, activityRef: null,
  people: [], equipment: [], materials: [], context: [],
};

/**
 * What the project knows about itself, handed to the provider.
 *
 * This is what keeps a reader honest: "CDU" is a location because this project
 * has a location called CDU, not because a model decided it looked like one.
 * A provider is free to ignore it, but the mock leans on it entirely and a
 * prompted model is told to prefer these values over inventing its own.
 */
export type ExtractionContext = {
  /** Anchors "today" and "yesterday". Milliseconds. */
  now: number;
  locations: string[];
  disciplines: string[];
  people: string[];
  /** Activity IDs, so a quoted code can be recognised rather than guessed at. */
  activityRefs: string[];
};

export type ExtractionResult = {
  event: FieldEvent;
  provider: string;
  model: string | null;
  modelVersion: string | null;
  /** Exactly what the provider returned, before any coercion. */
  raw: string | null;
  /** False when the output could not be used; `event` is then the empty one. */
  ok: boolean;
  error: string | null;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string | null;
  extractFieldEvent(text: string, ctx: ExtractionContext): Promise<ExtractionResult>;
}

/**
 * Embeddings are a separate capability from extraction.
 *
 * A provider may do one, the other or both — the rule-based reader does
 * extraction and a lexical vector; a hosted model may do both properly. Keeping
 * them apart means swapping one does not force swapping the other.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
