import type { ExtractionContext, ExtractionResult, LlmProvider } from "./types.ts";
import { EMPTY_FIELD_EVENT } from "./types.ts";
import { coerceFieldEvent, parseJsonObject } from "./coerce.ts";

/**
 * One adapter, several providers.
 *
 * Groq, OpenAI, Together, OpenRouter, llama.cpp's server and Ollama all speak
 * the same `/chat/completions` shape, so they differ only by base URL, key and
 * model name. Writing a class per vendor would be four copies of this file.
 *
 * Gemini is deliberately not covered — its request shape is genuinely different
 * and it would be a second adapter, not a config value. Add it when someone
 * actually wants Gemini.
 *
 * ponytail: no retry, no backoff, no streaming. A failed call falls back to the
 * rule-based reader, which is a better answer than making the user wait.
 */

const TIMEOUT_MS = 20_000;

const SYSTEM = `You read construction field reports and return JSON only.

Return exactly this shape:
{"work":string|null,"progress":number|null,"status":"not_started"|"in_progress"|"completed"|"blocked"|null,
"date":"YYYY-MM-DD"|null,"datePhrase":string|null,"location":string|null,"discipline":string|null,
"quantity":number|null,"unit":string|null,"activityRef":string|null,
"people":string[],"equipment":string[],"materials":string[],"context":string[]}

Rules, in order of importance:
1. Never invent. If the report does not say it, the value is null and the array is empty.
2. Do not infer location or discipline from what is likely. Only from what is written.
3. Prefer values from the project vocabulary given below when the text refers to one.
4. progress is the number the report states, 0-100. "80% complete" is 80, not 100.
5. status "completed" only when the work itself is finished, not when a step is.
6. Resolve relative dates against the report timestamp given below.
7. context holds meaningful clauses that fit no other field.
Return the JSON object and nothing else.`;

function userPrompt(text: string, ctx: ExtractionContext): string {
  const vocab = (label: string, list: string[]) =>
    list.length ? `${label}: ${list.slice(0, 60).join(", ")}\n` : "";
  return (
    `Report timestamp: ${new Date(ctx.now).toISOString()}\n` +
    vocab("Known locations", ctx.locations) +
    vocab("Known disciplines", ctx.disciplines) +
    vocab("Known people", ctx.people) +
    vocab("Known activity IDs", ctx.activityRefs) +
    `\nReport:\n${text}`
  );
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: { name?: string; baseUrl: string; apiKey: string; model: string }) {
    this.name = opts.name ?? "openai-compatible";
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async extractFieldEvent(text: string, ctx: ExtractionContext): Promise<ExtractionResult> {
    const base: ExtractionResult = {
      provider: this.name, model: this.model, modelVersion: null,
      raw: null, ok: true, error: null, event: { ...EMPTY_FIELD_EVENT },
    };
    if (typeof text !== "string" || !text.trim()) {
      return { ...base, ok: false, error: "empty report" };
    }

    let body: string;
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model: this.model,
          temperature: 0,                        // extraction, not writing
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: userPrompt(text.trim().slice(0, 4000), ctx) },
          ],
        }),
      });
      body = await res.text();
      if (!res.ok) {
        return { ...base, ok: false, raw: body.slice(0, 2000), error: `${this.name} HTTP ${res.status}` };
      }
    } catch (e) {
      return { ...base, ok: false, error: `${this.name} unreachable: ${(e as Error).message}` };
    }

    // Two layers of parsing, both of which may fail harmlessly: the envelope,
    // then whatever the model put in the content field.
    let content: string | null = null;
    try {
      const env = JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] };
      const c = env.choices?.[0]?.message?.content;
      if (typeof c === "string") content = c;
    } catch { /* fall through — content stays null */ }

    if (!content) {
      return { ...base, ok: false, raw: body.slice(0, 2000), error: "no content in response" };
    }
    const parsed = parseJsonObject(content);
    if (!parsed) {
      return { ...base, ok: false, raw: content.slice(0, 2000), error: "response was not JSON" };
    }
    return { ...base, event: coerceFieldEvent(parsed), raw: content.slice(0, 4000) };
  }
}
