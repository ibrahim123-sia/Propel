import type { AiUsageCount } from "./types";

/**
 * Estimated prices in US dollars per million tokens (list prices of Anthropic, xAI and the
 * Gemini API's standard tier, checked 2026-10-31; Cloudflare Workers AI for embeddings). Gemini
 * 3.6/3.8 Flash double on 2027-01-01. Used only to estimate spend for the
 * budgets in Settings -> AI; the provider's invoice is the real number. Cache writes are the
 * 5-minute rate (1.25x input).
 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Higher rates when one request's prompt is longer than `overTokens`. */
  long?: { overTokens: number; input: number; output: number };
};

/** xAI's current flagships: double rates from 200k prompt tokens. */
function xaiFlagship(cacheRead: number): ModelPrice {
  return {
    input: 2,
    output: 6,
    cacheRead,
    cacheWrite: 0,
    long: { overTokens: 200_000, input: 4, output: 12 },
  };
}
const xaiStandard: ModelPrice = {
  input: 1.25,
  output: 2.5,
  cacheRead: 0.2,
  cacheWrite: 0,
  long: { overTokens: 200_000, input: 2.5, output: 5 },
};

export const modelPrices: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    long: { overTokens: 100_000, input: 0.5, output: 2.5 },
  },
  "grok-4.7": xaiFlagship(0.5),
  "grok-4.6": xaiFlagship(0.5),
  "grok-4.5": xaiFlagship(0.3),
  "grok-4.3": xaiStandard,
  "grok-4.20-0309-reasoning": xaiStandard,
  "grok-4.20-0309-non-reasoning": xaiStandard,
  "grok-build-0.1": {
    input: 1,
    output: 2,
    cacheRead: 0.2,
    cacheWrite: 0,
    long: { overTokens: 200_000, input: 2, output: 4 },
  },
  // GroqCloud on-demand (third-party listings, 2026-11; cached input at half price).
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3, cacheRead: 0.0375, cacheWrite: 0 },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08, cacheRead: 0.05, cacheWrite: 0 },
  // Voice notes: Whisper is billed per audio hour ($0.04); usage counts seconds as input.
  "whisper-large-v3-turbo": { input: 11.12, output: 0, cacheRead: 0, cacheWrite: 0 },
  "gemini-4-argon": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  "gemini-3.1-pro-preview": {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 0,
    long: { overTokens: 200_000, input: 4, output: 18 },
  },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
  "gemini-2.5-pro": {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
    long: { overTokens: 200_000, input: 2.5, output: 15 },
  },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  "@cf/baai/bge-m3": { input: 0.012, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const FREE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * A model missing from the table is priced like the most expensive one, so an unknown model
 * reaches the spend limit early rather than late.
 */
const UNKNOWN: ModelPrice = Object.values(modelPrices).reduce((a, b) =>
  b.input + b.output > a.input + a.output ? b : a,
);

/**
 * The model's price; a dated or versioned id the provider answers with ("gemini-2.5-flash-001")
 * takes the price of the longest listed id it starts with.
 */
export function priceFor(model: string): ModelPrice {
  if (model.startsWith("mock")) return FREE;
  const exact = modelPrices[model];
  if (exact) return exact;
  const base = Object.keys(modelPrices)
    .filter((id) => model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? modelPrices[base]! : UNKNOWN;
}

/** Estimated cost of one call in millionths of a US dollar (integer). */
export function costMicros(model: string, usage: AiUsageCount): number {
  const price = priceFor(model);
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long = price.long && promptTokens > price.long.overTokens ? price.long : null;
  // $ per 1M tokens x tokens = millionths of a dollar.
  const micros =
    usage.inputTokens * (long?.input ?? price.input) +
    usage.outputTokens * (long?.output ?? price.output) +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;
  return Math.round(micros);
}

/** Micros to whole cents, rounded up (budgets compare in cents). */
export const microsToCents = (micros: number): number => Math.ceil(micros / 10_000);
