import { isWorkersRuntime } from "@/lib/env";

/**
 * The Worker's Workers AI binding (`AI` in wrangler.jsonc), for embeddings and chat. Kept apart
 * from workers-ai.ts so scripts can import the embedding provider without the database.
 */

/** The address the binding fetch answers; any base works, nothing is sent over the network. */
export const WORKERS_AI_BINDING_URL = "https://workers-ai.binding/v1";

type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };

/** The Worker's `AI` binding, or null outside Cloudflare. */
export async function aiBinding<T = AiBinding>(): Promise<T | null> {
  if (!isWorkersRuntime()) return null;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env: cfEnv } = await getCloudflareContext({ async: true });
    return ((cfEnv as { AI?: T }).AI ?? null) as T | null;
  } catch {
    return null;
  }
}

/**
 * A `fetch` for the Chat Completions client that runs the request on the `AI` binding: the
 * binding takes the same body (with `model` passed apart) and answers with the same JSON, or
 * with the same server-sent events when `stream` is set. Its errors come back as HTTP statuses
 * so the client retries capacity errors and the backup provider takes over on the rest.
 */
export function bindingFetch(binding: AiBinding): typeof fetch {
  return async (_url, init) => {
    const { model, ...input } = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    try {
      const out = await binding.run(String(model), input);
      if (out instanceof ReadableStream)
        return new Response(out, { headers: { "content-type": "text/event-stream" } });
      return Response.json(out);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // 3040 "Capacity temporarily exceeded", 3036 daily allowance used up, rate limits.
      const status = /capacity|rate limit|too many|3040|3036/i.test(message) ? 429 : 502;
      return Response.json({ error: { message: message.slice(0, 300) } }, { status });
    }
  };
}
