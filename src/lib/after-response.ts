import { after } from "next/server";
import { isWorkersRuntime } from "@/lib/env";

/**
 * Work to finish after the response is sent. Do not call Next's `after()` directly: on
 * Cloudflare Workers it waits for the response stream's close event, which never comes, so the
 * callback never runs and the request ends as "code had hung" (2026-11-27, Error 1101). There
 * the work goes straight to the request's `waitUntil`; elsewhere `after()` is fine.
 * Throws outside a request, like `after()`.
 */
export async function afterResponse(work: () => Promise<unknown>): Promise<void> {
  if (isWorkersRuntime()) {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { ctx } = await getCloudflareContext({ async: true });
    ctx.waitUntil(work());
    return;
  }
  after(work);
}
