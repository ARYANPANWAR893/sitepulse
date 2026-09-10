import type { EmbeddingProvider, ExtractionContext, ExtractionResult, LlmProvider } from "./types.ts";
import { MockProvider } from "./mock.ts";
import { OpenAiCompatibleProvider } from "./openai-compatible.ts";

export * from "./types.ts";
export { coerceFieldEvent, parseJsonObject, percent, isoDate } from "./coerce.ts";
export { MockProvider } from "./mock.ts";
export { OpenAiCompatibleProvider } from "./openai-compatible.ts";

/**
 * Which reader is in use, decided by configuration alone.
 *
 * `LLM_PROVIDER=mock` (or no key at all) gives the rule-based reader. Anything
 * else needs `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` — which is enough
 * for Groq, OpenAI, Together, OpenRouter, llama.cpp or Ollama, since they all
 * speak the same endpoint.
 *
 *   LLM_PROVIDER=groq
 *   LLM_BASE_URL=https://api.groq.com/openai/v1
 *   LLM_API_KEY=gsk_...
 *   LLM_MODEL=llama-3.3-70b-versatile
 */
export function getProvider(): LlmProvider {
  const name = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();

  if (!name || name === "mock" || !baseUrl || !apiKey || !model) return new MockProvider();
  return new OpenAiCompatibleProvider({ name, baseUrl, apiKey, model });
}

/**
 * Reads a report, and never fails to return something.
 *
 * A hosted model that is down, rate-limited or talking nonsense must not stop a
 * report being recorded and matched — it should degrade to the rule-based
 * reading, with the failure kept on the record so nobody mistakes one for the
 * other. `ok: false` plus a populated event means exactly that.
 */
export async function extractFieldEvent(
  text: string, ctx: ExtractionContext, provider: LlmProvider = getProvider()
): Promise<ExtractionResult> {
  let result: ExtractionResult;
  try {
    result = await provider.extractFieldEvent(text, ctx);
  } catch (e) {
    result = {
      event: (await new MockProvider().extractFieldEvent(text, ctx)).event,
      provider: provider.name, model: provider.model, modelVersion: null,
      raw: null, ok: false, error: `provider threw: ${(e as Error).message}`,
    };
    return result;
  }

  if (result.ok || provider.name === "mock") return result;

  const fallback = await new MockProvider().extractFieldEvent(text, ctx);
  return {
    ...fallback,
    provider: `${provider.name}→mock`,
    ok: false,
    error: result.error,
    raw: result.raw,
  };
}

// ---------------------------------------------------------------- embeddings

const DIMS = 256;

/**
 * A deterministic lexical vector. Not a learned embedding, and named so.
 *
 * Hashed character 4-grams plus whole tokens, L2-normalised. That makes
 * "excavation" and "excavate" land close together and survives the
 * misspellings a phone keyboard produces, which is most of what matters for
 * site language. It does *not* know that "digging" and "excavation" mean the
 * same thing — that needs a real model.
 *
 * It is here because it needs no key, no network and no cost, runs the same in
 * a test as in production, and gives the matcher a genuine semantic signal to
 * weigh from day one. Swap in a hosted embedder by implementing this interface;
 * `activity_embeddings` already stores dims and model per row, so the two can
 * coexist while a project is re-embedded.
 *
 * ponytail: brute-force cosine over every activity in the project, which is
 * ~5000 × 256 floats — about 5ms. Move to sqlite-vec when a project needs more
 * than one schedule's worth.
 */
export class LexicalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "lexical";
  readonly model = "lexical-hash-v1";
  readonly dims = DIMS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => embedOne(t));
  }
}

/** FNV-1a. Cheap, well-spread, and identical on every machine. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "by",
  "is", "are", "was", "were", "be", "been", "with", "from", "as", "it", "this",
  "that", "near", "today", "yesterday", "tomorrow",
]);

export function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function embedOne(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  const tokens = tokenize(text);

  for (const tok of tokens) {
    v[hash(tok) % DIMS] += 1;
    // Character 4-grams, so a near-miss spelling still overlaps.
    const padded = `^${tok}$`;
    for (let i = 0; i + 4 <= padded.length; i++) {
      v[hash(padded.slice(i, i + 4)) % DIMS] += 0.5;
    }
  }
  // Adjacent pairs carry a little word order — "cable trench" ≠ "trench cable".
  for (let i = 0; i + 1 < tokens.length; i++) {
    v[hash(`${tokens[i]}_${tokens[i + 1]}`) % DIMS] += 0.75;
  }

  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

/** Both vectors are unit length, so this is the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return new LexicalEmbeddingProvider();
}
