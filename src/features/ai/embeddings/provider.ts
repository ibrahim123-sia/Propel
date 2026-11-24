import { EMBEDDING_DIMENSIONS } from "@/db/schema/ai";
import { isWorkersRuntime } from "@/lib/env";
import { aiBinding } from "../binding";

/**
 * Embedding providers (10 §1). The spec's stack is Cloudflare, so the real provider is Workers
 * AI through the Worker's `AI` binding (routed through the AI Gateway when one is set in
 * Settings -> Integrations); the default model `@cf/baai/bge-m3` is multilingual and returns
 * 1024 numbers (EMBEDDING_DIMENSIONS). The test provider hashes words into the same space, so
 * development, tests and e2e work without any account; similar wording gives similar vectors.
 */

export type EmbeddingProvider = {
  name: "mock" | "workers_ai";
  /** Stored with each vector: search only compares vectors from the same model. */
  model: string;
  dimensions: number;
  /** Cosine similarity above `high` is a strong match, below `low` a weak one. */
  thresholds: { high: number; low: number };
  embed: (texts: string[]) => Promise<{ vectors: number[][]; tokens: number }>;
};

export const MOCK_EMBEDDING_MODEL = `mock-hash-${EMBEDDING_DIMENSIONS}`;

/* Hashing vectors (feature hashing of words and word pairs) ------------------------------ */

const STOPWORDS = new Set(
  "a an and are as at be by for from has have i in is it its me my of on or our the their this to we with you your".split(
    " ",
  ),
);

export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic unit vector for a text. */
export function hashEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  const words = normalizeWords(text);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    v[h % dimensions]! += (h & 0x80000000 ? -1 : 1) * weight;
  };
  for (let i = 0; i < words.length; i++) {
    add(words[i]!, 1);
    if (i + 1 < words.length) add(`${words[i]} ${words[i + 1]}`, 0.5);
  }
  // Damp repeated words so a long text does not drown a short query.
  for (let i = 0; i < dimensions; i++) v[i] = Math.sign(v[i]!) * Math.log1p(Math.abs(v[i]!));
  const norm = Math.hypot(...v);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norm);
}

export const mockEmbeddings: EmbeddingProvider = {
  name: "mock",
  model: MOCK_EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
  thresholds: { high: 0.3, low: 0.12 },
  async embed(texts) {
    return {
      vectors: texts.map((t) => hashEmbedding(t)),
      tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
    };
  },
};

/* Workers AI ------------------------------------------------------------------------------ */

type AiBinding = {
  run: (
    model: string,
    input: { text: string[] },
    options?: { gateway?: { id: string } },
  ) => Promise<{ data?: number[][]; shape?: number[] }>;
};

const BATCH = 50;

export function workersAiEmbeddings(model: string, gatewayName: string | null): EmbeddingProvider {
  return {
    name: "workers_ai",
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    thresholds: { high: 0.62, low: 0.45 },
    async embed(texts) {
      const binding = await aiBinding<AiBinding>();
      if (!binding)
        throw new Error("Workers AI is only available on Cloudflare (the AI binding is missing).");
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const out = await binding.run(
          model,
          { text: texts.slice(i, i + BATCH) },
          gatewayName ? { gateway: { id: gatewayName } } : undefined,
        );
        for (const vector of out.data ?? []) {
          if (vector.length !== EMBEDDING_DIMENSIONS)
            throw new Error(
              `${model} returned ${vector.length} numbers; the database expects ${EMBEDDING_DIMENSIONS}.`,
            );
          vectors.push(vector);
        }
      }
      if (vectors.length !== texts.length)
        throw new Error(`${model} returned ${vectors.length} vectors for ${texts.length} texts.`);
      return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
    },
  };
}

/**
 * The provider for the settings. Workers AI only exists on Cloudflare; in local development
 * and tests the test provider stands in (its vectors are stored under their own model name,
 * so the two never mix).
 */
export function embeddingProviderFor(config: {
  embedding: { provider: "mock" | "workers_ai"; model: string };
  gateway: { name: string } | null;
}): EmbeddingProvider {
  if (config.embedding.provider === "workers_ai" && isWorkersRuntime())
    return workersAiEmbeddings(config.embedding.model, config.gateway?.name ?? null);
  return mockEmbeddings;
}

/** pgvector literal for a vector parameter. */
export const vectorLiteral = (v: number[]): string => `[${v.map((x) => x.toFixed(6)).join(",")}]`;
