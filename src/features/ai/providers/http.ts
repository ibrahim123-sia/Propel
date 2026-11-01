import { AiProviderError } from "../types";

/**
 * The HTTP part every provider shares: one POST with retries on overload, rate limits and
 * network errors (before any output), a timeout, and the provider's own error message.
 */

export const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type PostOptions = {
  fetch: typeof fetch;
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  maxRetries?: number;
  timeoutMs?: number;
};

export async function postWithRetries(o: PostOptions): Promise<Response> {
  const maxRetries = o.maxRetries ?? 2;
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 90_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await o.fetch(o.url, { method: "POST", headers: o.headers, body: o.body, signal });
    } catch (err) {
      if (signal.aborted || attempt >= maxRetries)
        throw new AiProviderError(
          `The AI provider could not be reached: ${(err as Error).message}`,
          null,
          true,
        );
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res;
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(after) && after > 0 ? Math.min(after, 8) * 1000 : 500 * 2 ** attempt,
      );
      continue;
    }
    throw new AiProviderError(
      `The AI provider answered ${res.status}: ${await errorMessage(res)}`,
      res.status,
      RETRY_STATUSES.has(res.status),
    );
  }
}

/** `{ error: { message } }` (Anthropic, xAI, Gemini) or `{ error: "..." }`, else the body. */
export async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof json.error === "string" ? json.error : json.error?.message;
    if (message) return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.slice(0, 300) || res.statusText;
}

/** A Cloudflare AI Gateway address for a provider, or null when no gateway is set. */
export function gatewayBase(
  gateway: { accountId: string; name: string } | null | undefined,
  provider: "anthropic" | "grok" | "groq" | "google-ai-studio",
): string | null {
  return gateway?.accountId && gateway.name
    ? `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.name)}/${provider}`
    : null;
}

/** Tool input JSON as the model wrote it; a cut-off one is reported by the runner. */
export function parseToolInput(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { __invalid_json: json.slice(0, 200) };
  }
}
