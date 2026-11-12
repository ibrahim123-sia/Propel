import { and, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db/client";
import { microsToCents } from "@/features/ai/pricing";
import { spendSummary } from "@/features/ai/usage";
import { currentAgencyId } from "@/db/schema/_common";
import { jobRuns, jobStatuses } from "@/db/schema/system";
import { loadSettings } from "@/features/settings/queries";
import { listSecretStatus, type SecretStatus } from "@/features/settings/secrets";
import type { SecretKey } from "@/features/settings/schema";
import { cronTasks } from "@/jobs/cron";
import { smtpFromEnv } from "@/lib/email/config";
import { env } from "@/lib/env";
import type { TableParams } from "@/lib/table-params";
import { readEnv } from "@/lib/legacy-env";

export type { JobStatus } from "@/db/schema/system";
type JobStatus = (typeof jobStatuses)[number];

/** Queue health for the System page (13 §2, 14 §6). */
export async function jobSummary(db?: DbOrTx) {
  const conn = db ?? (await getDb());
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await conn
    .select({
      queued: sql<number>`count(*) filter (where ${jobRuns.status} = 'queued')::int`,
      running: sql<number>`count(*) filter (where ${jobRuns.status} = 'running')::int`,
      dead: sql<number>`count(*) filter (where ${jobRuns.status} = 'dead')::int`,
      failedDay: sql<number>`count(*) filter (where ${jobRuns.status} = 'failed' and ${jobRuns.updatedAt} >= ${dayAgo})::int`,
      succeededDay: sql<number>`count(*) filter (where ${jobRuns.status} = 'succeeded' and ${jobRuns.finishedAt} >= ${dayAgo})::int`,
      retrying: sql<number>`count(*) filter (where ${jobRuns.status} = 'queued' and ${jobRuns.lastError} is not null)::int`,
      // Due for more than 5 minutes and not picked up: the every-minute trigger is not running.
      overdue: sql<number>`count(*) filter (where ${jobRuns.status} = 'queued' and ${jobRuns.runAfter} < ${new Date(Date.now() - 5 * 60_000)})::int`,
      // Running for more than 15 minutes: a worker died mid-job (the runner re-queues them).
      stuck: sql<number>`count(*) filter (where ${jobRuns.status} = 'running' and ${jobRuns.startedAt} < ${new Date(Date.now() - 15 * 60_000)})::int`,
    })
    .from(jobRuns)
    .where(eq(jobRuns.agencyId, currentAgencyId()));
  return row!;
}

export const jobSortable = ["newest"] as const;

export type JobRunRow = {
  id: string;
  name: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  payload: unknown;
  result: unknown;
};

export async function listJobRuns(
  params: TableParams<(typeof jobSortable)[number]>,
  db?: DbOrTx,
): Promise<{ rows: JobRunRow[]; total: number }> {
  const conn = db ?? (await getDb());
  const where: SQL[] = [eq(jobRuns.agencyId, currentAgencyId())];
  const status = params
    .getAll("status")
    .filter((s): s is JobStatus => (jobStatuses as readonly string[]).includes(s));
  if (status.length) where.push(inArray(jobRuns.status, status));
  if (params.q) where.push(ilike(jobRuns.name, `%${params.q.replace(/[\\%_]/g, "\\$&")}%`));
  const name = params.get("name");
  if (name) where.push(eq(jobRuns.name, name));
  if (params.get("problems") === "1") {
    where.push(sql`(${jobRuns.status} in ('failed', 'dead') or ${jobRuns.lastError} is not null)`);
  }
  const [rows, [count]] = await Promise.all([
    conn
      .select()
      .from(jobRuns)
      .where(and(...where))
      .orderBy(params.sort.desc ? jobRuns.createdAt : desc(jobRuns.createdAt), desc(jobRuns.id))
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    conn
      .select({ n: sql<number>`count(*)::int` })
      .from(jobRuns)
      .where(and(...where)),
  ]);
  return {
    total: count?.n ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      createdAt: r.createdAt.toISOString(),
      runAfter: r.runAfter.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      lastError: r.lastError,
      payload: r.payload,
      result: r.result,
    })),
  };
}

/** Minutes between runs, read from a task's schedule text ("every 15 minutes", "daily at 06:00"). */
export function scheduleMinutes(schedule: string): number | null {
  const s = schedule.toLowerCase();
  const every = s.match(/every (\d+) minutes/);
  if (every) return Number(every[1]);
  if (s.includes("every minute")) return 1;
  if (s.includes("every hour")) return 60;
  if (s.startsWith("daily")) return 24 * 60;
  if (s.startsWith("weekly") || /^(mon|tues|wednes|thurs|fri|satur|sun)days/.test(s))
    return 7 * 24 * 60;
  if (s.startsWith("monthly")) return 31 * 24 * 60;
  return null;
}

/** Late: no run for twice the task's interval (plus 5 minutes' grace) since its last run. */
export function isCronLate(schedule: string, lastRunAt: Date | null, now: Date): boolean {
  const minutes = scheduleMinutes(schedule);
  if (minutes == null || !lastRunAt) return false;
  return now.getTime() - lastRunAt.getTime() > (2 * minutes + 5) * 60_000;
}

/** Each scheduled task and its latest logged run (the every-minute runner is not logged). */
export async function cronStatus(db?: DbOrTx) {
  const conn = db ?? (await getDb());
  const tasks = cronTasks.filter((t) => t.name !== "jobs.run-due");
  const names = tasks.map((t) => `cron:${t.name}`);
  const latest = await conn
    .selectDistinctOn([jobRuns.name], {
      name: jobRuns.name,
      status: jobRuns.status,
      finishedAt: jobRuns.finishedAt,
      createdAt: jobRuns.createdAt,
      lastError: jobRuns.lastError,
    })
    .from(jobRuns)
    .where(and(eq(jobRuns.agencyId, currentAgencyId()), inArray(jobRuns.name, names)))
    .orderBy(jobRuns.name, desc(jobRuns.createdAt));
  const byName = new Map(latest.map((r) => [r.name, r]));
  const now = new Date();
  return tasks.map((t) => {
    const last = byName.get(`cron:${t.name}`);
    const lastAt = last ? (last.finishedAt ?? last.createdAt) : null;
    return {
      name: t.name,
      schedule: t.schedule,
      lastRunAt: lastAt?.toISOString() ?? null,
      late: !t.quiet && isCronLate(t.schedule, lastAt, now),
      lastStatus: last?.status ?? null,
      lastError: last?.lastError ?? null,
    };
  });
}

export type IntegrationState = {
  name: string;
  state: "off" | "ok" | "error" | "untested" | "missing";
  detail: string;
};

/** Email is set in the environment (SMTP_*), not with a stored key. */
function emailState(): IntegrationState {
  const smtp = smtpFromEnv();
  return smtp
    ? { name: "Email (SMTP)", state: "ok", detail: `${smtp.host} as ${smtp.user}` }
    : { name: "Email (SMTP)", state: "off", detail: "No mail server set: emails stay in the log" };
}

/** One line per integration: off, missing a key, untested, working or failing (14 §6). */
export async function integrationStatus(db?: DbOrTx): Promise<IntegrationState[]> {
  const conn = db ?? (await getDb());
  const [integrations, keys] = await Promise.all([
    loadSettings("integrations", conn),
    listSecretStatus(conn),
  ]);
  const key = (k: SecretKey) => keys.find((s) => s.key === k)!;
  const line = (name: string, enabled: boolean, k: SecretStatus | null): IntegrationState => {
    if (!enabled) return { name, state: "off", detail: "Turned off" };
    if (k && !k.isSet) return { name, state: "missing", detail: "On, but the key is missing" };
    if (k?.lastError) return { name, state: "error", detail: k.lastError };
    if (k && !k.lastTestedAt) return { name, state: "untested", detail: "Not tested yet" };
    return { name, state: "ok", detail: k?.lastTestedAt ? "Last test passed" : "On" };
  };
  return [
    line("Google Maps Platform", integrations.googleMaps.enabled, key("google_maps_server_key")),
    line("WhatsApp Cloud API", integrations.whatsapp.enabled, key("whatsapp_access_token")),
    emailState(),
    line("Google Calendar", integrations.googleCalendar.enabled, key("google_oauth_client_secret")),
    line(
      "AI provider",
      integrations.ai.enabled,
      integrations.ai.provider === "mock"
        ? null
        : // A key from the environment (XAI_API_KEY, ...) counts as set (features/ai/config).
          !key("ai_api_key").isSet && envAiKey(integrations.ai.provider)
          ? null
          : key("ai_api_key"),
    ),
  ];
}

function envAiKey(provider: "xai" | "groq" | "gemini" | "anthropic"): boolean {
  const e = env();
  return Boolean(
    {
      xai: e.XAI_API_KEY,
      groq: e.GROQ_API_KEY,
      gemini: e.GEMINI_API_KEY,
      anthropic: e.ANTHROPIC_API_KEY,
    }[provider],
  );
}

/** Runtime facts for the System page header. */
export function runtimeInfo() {
  const e = env();
  return {
    environment: e.PROPEL_ENV,
    /** Release tag of this deploy (also on every log line, lib/log.ts). */
    release: readEnv("PROPEL_RELEASE") ?? null,
    storage: e.STORAGE_DRIVER === "r2" ? "Cloudflare R2" : "Local disk",
    jobs:
      e.JOBS_DRIVER === "queue"
        ? "Cloudflare Queues"
        : e.JOBS_DRIVER === "inline"
          ? "In-process"
          : "Manual",
  };
}

/** Estimated AI spend this month in USD cents (`ai_usage`, agency time zone). */
export async function aiSpendThisMonthCents(db?: DbOrTx): Promise<number> {
  return microsToCents((await spendSummary(db)).monthMicros);
}
