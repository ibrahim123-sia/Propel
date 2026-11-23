import { and, eq, like, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { aiUsage } from "@/db/schema/ai";
import { env } from "@/lib/env";
import { agencyToday } from "./usage";

/**
 * Cloudflare Workers AI as a chat provider, through its OpenAI-compatible Chat Completions
 * API (the same wire format as Groq, see providers/groq.ts). It needs the account id and an
 * API token with the "Workers AI: Read" permission (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN).
 *
 * The account gets 10,000 Neurons a day free; beyond that Cloudflare bills them. To keep the
 * bill flat, the assistants move to the backup provider for the rest of the day once the
 * day's Workers AI estimate (chat and embeddings, from `ai_usage`) reaches the cap below.
 */

export function workersAiBaseUrl(): string | null {
  const account = env().CLOUDFLARE_ACCOUNT_ID;
  return account ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1` : null;
}

/** 10,000 Neurons at $0.011 per 1,000 is $0.11; stop at about 80% of it, in micro-dollars. */
export const WORKERS_AI_DAILY_CAP_MICROS = 90_000;

/** Today's estimated Workers AI spend (every `@cf/` model) in micro-dollars. */
export async function workersAiSpentToday(db: DbOrTx, now = new Date()): Promise<number> {
  const date = await agencyToday(db, now);
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${aiUsage.costEstimateMicros}), 0)` })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.agencyId, currentAgencyId()),
        eq(aiUsage.date, date),
        like(aiUsage.model, "@cf/%"),
      ),
    );
  return Number(row?.micros ?? 0);
}

export async function workersAiAllowanceLeft(db: DbOrTx, now = new Date()): Promise<boolean> {
  return (await workersAiSpentToday(db, now)) < WORKERS_AI_DAILY_CAP_MICROS;
}
