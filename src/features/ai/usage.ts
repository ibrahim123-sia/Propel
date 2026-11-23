import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { aiUsage, type AiFeature } from "@/db/schema/ai";
import { loadSettings } from "@/features/settings/queries";
import { localDateString } from "@/lib/local-date";
import { costMicros } from "./pricing";
import type { AiUsageCount } from "./types";

/** `ai_usage`: requests, tokens and estimated cost per agency day, feature and model. */

export async function agencyToday(db: DbOrTx, now: Date): Promise<string> {
  const general = await loadSettings("general", db);
  return localDateString(now, general.timeZone);
}

/** Adds one call (or a batch of embedding calls) to today's row. Returns its cost in micros. */
export async function recordUsage(
  input: { feature: AiFeature; model: string; usage: AiUsageCount; requests?: number },
  options: { db?: DbOrTx; now?: Date } = {},
): Promise<number> {
  const db = options.db ?? (await getDb());
  const date = await agencyToday(db, options.now ?? new Date());
  const cost = costMicros(input.model, input.usage);
  const u = input.usage;
  const requests = input.requests ?? 1;
  await db
    .insert(aiUsage)
    .values({
      date,
      feature: input.feature,
      model: input.model,
      requests,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      costEstimateMicros: cost,
    })
    .onConflictDoUpdate({
      target: [aiUsage.agencyId, aiUsage.date, aiUsage.feature, aiUsage.model],
      set: {
        requests: sql`${aiUsage.requests} + ${requests}`,
        inputTokens: sql`${aiUsage.inputTokens} + ${u.inputTokens}`,
        outputTokens: sql`${aiUsage.outputTokens} + ${u.outputTokens}`,
        cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${u.cacheReadTokens}`,
        cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${u.cacheWriteTokens}`,
        costEstimateMicros: sql`${aiUsage.costEstimateMicros} + ${cost}`,
        updatedAt: sql`now()`,
      },
    });
  return cost;
}

export type SpendSummary = {
  today: string;
  todayMicros: number;
  monthMicros: number;
};

/** Estimated spend today and this calendar month, in the agency's time zone. */
export async function spendSummary(db?: DbOrTx, now: Date = new Date()): Promise<SpendSummary> {
  const conn = db ?? (await getDb());
  const today = await agencyToday(conn, now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [row] = await conn
    .select({
      month: sql<string>`coalesce(sum(${aiUsage.costEstimateMicros}), 0)::text`,
      today: sql<string>`coalesce(sum(${aiUsage.costEstimateMicros}) filter (where ${aiUsage.date} = ${today}), 0)::text`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.agencyId, currentAgencyId()), gte(aiUsage.date, monthStart)));
  return { today, todayMicros: Number(row?.today ?? 0), monthMicros: Number(row?.month ?? 0) };
}

export type UsageDay = {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  byFeature: Array<{ feature: AiFeature; requests: number; costMicros: number }>;
};

/** The last `days` days with any use, newest first (Settings -> AI "Usage per day"). */
export async function usageByDay(
  days = 14,
  db?: DbOrTx,
  now: Date = new Date(),
): Promise<UsageDay[]> {
  const conn = db ?? (await getDb());
  const today = await agencyToday(conn, now);
  const from = new Date(`${today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const rows = await conn
    .select({
      date: aiUsage.date,
      feature: aiUsage.feature,
      requests: sql<number>`sum(${aiUsage.requests})::int`,
      inputTokens: sql<string>`sum(${aiUsage.inputTokens} + ${aiUsage.cacheReadTokens} + ${aiUsage.cacheWriteTokens})::text`,
      outputTokens: sql<string>`sum(${aiUsage.outputTokens})::text`,
      cost: sql<string>`sum(${aiUsage.costEstimateMicros})::text`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.agencyId, currentAgencyId()),
        gte(aiUsage.date, from.toISOString().slice(0, 10)),
      ),
    )
    .groupBy(aiUsage.date, aiUsage.feature)
    .orderBy(desc(aiUsage.date), aiUsage.feature);

  const byDate = new Map<string, UsageDay>();
  for (const r of rows) {
    const day = byDate.get(r.date) ?? {
      date: r.date,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
      byFeature: [],
    };
    day.requests += r.requests;
    day.inputTokens += Number(r.inputTokens);
    day.outputTokens += Number(r.outputTokens);
    day.costMicros += Number(r.cost);
    day.byFeature.push({ feature: r.feature, requests: r.requests, costMicros: Number(r.cost) });
    byDate.set(r.date, day);
  }
  return [...byDate.values()];
}
