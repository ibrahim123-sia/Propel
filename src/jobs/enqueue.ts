import { getDb, type DbOrTx } from "@/db/client";
import { jobRuns } from "@/db/schema/system";
import { env, isWorkersRuntime } from "@/lib/env";
import { newId } from "@/lib/ids";

export type EnqueueOptions = {
  db?: DbOrTx;
  /** A second enqueue with the same key while one is pending is ignored (idempotency). */
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
};

/**
 * Records a job and dispatches it:
 * - `queue`  (staging/production): Cloudflare Queues binding `JOBS_QUEUE`;
 * - `inline` (development): runs in-process right after the response (`after()`);
 * - `manual` (tests): stays queued until `runDueJobs()` is called.
 * Whatever the driver, the every-minute cron runs queued jobs whose time has come, so a lost
 * message or a crash never loses work.
 */
export async function enqueue(
  name: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const conn = options.db ?? (await getDb());
  const id = newId();
  const inserted = await conn
    .insert(jobRuns)
    .values({
      id,
      name,
      payload,
      dedupeKey: options.dedupeKey ?? null,
      runAfter: options.runAfter ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
    })
    .onConflictDoNothing()
    .returning({ id: jobRuns.id });
  if (inserted.length === 0) return null; // duplicate of a pending job

  const delayMs = options.runAfter ? Math.max(0, options.runAfter.getTime() - Date.now()) : 0;
  await dispatch(id, delayMs);
  return id;
}

/** Sends already-queued runs on their way again (Jobs page "Retry"). */
export async function redispatch(ids: string[]): Promise<void> {
  for (const id of ids) await dispatch(id, 0);
}

async function dispatch(id: string, delayMs: number): Promise<void> {
  const driver = process.env.JOBS_DRIVER ?? env().JOBS_DRIVER;
  if (driver === "manual") return;

  if (driver === "queue" && isWorkersRuntime()) {
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      const { env: cfEnv } = await getCloudflareContext({ async: true });
      const queue = (cfEnv as { JOBS_QUEUE?: Queue }).JOBS_QUEUE;
      if (queue) {
        // A short delay lets the surrounding transaction commit before the consumer reads the row.
        await queue.send({ id }, { delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)) });
        return;
      }
    } catch (err) {
      console.error("[jobs] queue send failed, cron will pick it up:", (err as Error).message);
      return;
    }
  }

  if (delayMs > 0) return; // the cron runs it when due
  const run = async () => {
    const { runJob } = await import("./runner");
    await runJob(id);
  };
  try {
    const { afterResponse } = await import("@/lib/after-response");
    await afterResponse(run);
  } catch {
    // Outside a request (scripts): run soon, without blocking the caller.
    setTimeout(() => void run().catch((e) => console.error("[jobs] inline run failed:", e)), 0);
  }
}

type Queue = { send: (body: unknown, options?: { delaySeconds?: number }) => Promise<void> };
