import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { embeddingEntityTypes, embeddings, type EmbeddingEntityType } from "@/db/schema/ai";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { afterResponse } from "@/lib/after-response";
import { sha256Hex } from "@/lib/crypto";
import { loadAiConfig } from "../config";
import { checkAiAvailable } from "../limits";
import { emptyUsage } from "../types";
import { pgArrayLiteral } from "../sql";
import { recordUsage } from "../usage";
import { loadEntityDocument, publicEntityIds } from "./chunks";
import { embeddingProviderFor, vectorLiteral, type EmbeddingProvider } from "./provider";

/**
 * Keeps `embeddings` in step with public content (10 §1, 13 §2): `ai.embed` rebuilds one
 * entity's chunks after a publish or update and removes them when it is no longer public;
 * `ai.embed_backfill` indexes everything (first run, model change) and drops leftovers, and
 * runs nightly as a safety net for changes made outside the admin (scheduled publishing).
 * Unchanged chunks are never embedded again (hash of model + text).
 */

export const EMBED_JOB = "ai.embed";
export const EMBED_BACKFILL_JOB = "ai.embed_backfill";

export async function currentEmbeddingProvider(db?: DbOrTx): Promise<EmbeddingProvider> {
  return embeddingProviderFor(await loadAiConfig(db));
}

export type IndexOutcome = {
  status: "indexed" | "unchanged" | "removed" | "skipped";
  chunks: number;
  embedded: number;
};

export async function removeEntityEmbeddings(
  db: DbOrTx,
  type: EmbeddingEntityType,
  id: string,
): Promise<number> {
  const removed = await db
    .delete(embeddings)
    .where(
      and(
        eq(embeddings.agencyId, currentAgencyId()),
        eq(embeddings.entityType, type),
        eq(embeddings.entityId, id),
      ),
    )
    .returning({ id: embeddings.id });
  return removed.length;
}

export async function indexEntity(
  db: DbOrTx,
  type: EmbeddingEntityType,
  id: string,
  options: { provider?: EmbeddingProvider; now?: Date } = {},
): Promise<IndexOutcome> {
  const provider = options.provider ?? (await currentEmbeddingProvider(db));
  const doc = await loadEntityDocument(db, type, id);
  if (!doc.visible) {
    const removed = await removeEntityEmbeddings(db, type, id);
    return { status: "removed", chunks: removed, embedded: 0 };
  }

  const hashes = await Promise.all(doc.chunks.map((c) => sha256Hex(`${provider.model}\n${c}`)));
  const existing = await db
    .select({ chunkIndex: embeddings.chunkIndex, contentHash: embeddings.contentHash })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.agencyId, currentAgencyId()),
        eq(embeddings.entityType, type),
        eq(embeddings.entityId, id),
      ),
    );
  const known = new Map(existing.map((e) => [e.chunkIndex, e.contentHash]));
  const changed = doc.chunks.map((_, i) => i).filter((i) => known.get(i) !== hashes[i]);
  const extra = existing.filter((e) => e.chunkIndex >= doc.chunks.length).length;
  if (changed.length === 0 && extra === 0)
    return { status: "unchanged", chunks: doc.chunks.length, embedded: 0 };

  if (changed.length > 0 && provider.name !== "mock") {
    // Real embeddings cost money: they follow the AI switch and budgets.
    const ok = await checkAiAvailable("embeddings", { db, now: options.now });
    if (!ok.ok) return { status: "skipped", chunks: doc.chunks.length, embedded: 0 };
  }
  const { vectors, tokens } = changed.length
    ? await provider.embed(changed.map((i) => doc.chunks[i]!))
    : { vectors: [], tokens: 0 };
  if (provider.name !== "mock" && changed.length)
    await recordUsage(
      {
        feature: "embeddings",
        model: provider.model,
        usage: { ...emptyUsage(), inputTokens: tokens },
        requests: 1,
      },
      { db, now: options.now },
    );

  for (const [n, i] of changed.entries()) {
    const values = {
      entityType: type,
      entityId: id,
      chunkIndex: i,
      content: doc.chunks[i]!,
      contentHash: hashes[i]!,
      model: provider.model,
      embedding: vectors[n]!,
    };
    await db
      .insert(embeddings)
      .values(values)
      .onConflictDoUpdate({
        target: [
          embeddings.agencyId,
          embeddings.entityType,
          embeddings.entityId,
          embeddings.chunkIndex,
        ],
        set: {
          content: values.content,
          contentHash: values.contentHash,
          model: values.model,
          embedding: sql`${vectorLiteral(values.embedding)}::vector`,
          updatedAt: sql`now()`,
        },
      });
  }
  if (extra > 0)
    await db
      .delete(embeddings)
      .where(
        and(
          eq(embeddings.agencyId, currentAgencyId()),
          eq(embeddings.entityType, type),
          eq(embeddings.entityId, id),
          gte(embeddings.chunkIndex, doc.chunks.length),
        ),
      );
  return { status: "indexed", chunks: doc.chunks.length, embedded: changed.length };
}

export type BackfillResult = {
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
};

/** Indexes every public entity and removes vectors of anything no longer public. */
export async function backfillEmbeddings(
  db: DbOrTx,
  options: { types?: EmbeddingEntityType[]; provider?: EmbeddingProvider; now?: Date } = {},
): Promise<BackfillResult> {
  const provider = options.provider ?? (await currentEmbeddingProvider(db));
  const wanted = (await publicEntityIds(db)).filter(
    (e) => !options.types || options.types.includes(e.type),
  );
  const result: BackfillResult = { indexed: 0, unchanged: 0, skipped: 0, removed: 0 };
  for (const e of wanted) {
    const outcome = await indexEntity(db, e.type, e.id, { provider, now: options.now });
    if (outcome.status === "indexed") result.indexed += 1;
    else if (outcome.status === "unchanged") result.unchanged += 1;
    else if (outcome.status === "skipped") result.skipped += 1;
  }
  const keep = wanted.map((e) => `${e.type}:${e.id}`);
  const typeFilter = options.types?.length ? sql` and entity_type in ${options.types}` : sql``;
  const removed = await db.execute<{ id: string }>(sql`
    delete from ${embeddings}
    where agency_id = ${currentAgencyId()}${typeFilter}
      and not (entity_type || ':' || entity_id::text = any(${pgArrayLiteral(keep)}::text[]))
    returning id`);
  result.removed = removed.rows.length;
  return result;
}

/* Queueing --------------------------------------------------------------------------------- */

/** Queues `ai.embed` for changed entities (one job per entity and second). */
export async function queueEmbedding(
  type: EmbeddingEntityType,
  ids: string[],
  options: { db?: DbOrTx; now?: Date } = {},
): Promise<void> {
  const second = Math.floor((options.now ?? new Date()).getTime() / 1000);
  for (const id of new Set(ids))
    await enqueue(
      EMBED_JOB,
      { entityType: type, entityId: id },
      { db: options.db, dedupeKey: `${EMBED_JOB}:${type}:${id}:${second}`, maxAttempts: 3 },
    );
}

/**
 * For the "revalidate after a change" helpers of each content type: queues the embedding
 * update after the response is sent (`afterResponse`), so it never slows an admin save or fails
 * it. Outside a request (scripts, tests) it does nothing: the nightly backfill catches up.
 */
export function embedAfterChange(
  type: EmbeddingEntityType,
  ids: Array<string | null | undefined>,
): void {
  const list = ids.filter((id): id is string => Boolean(id));
  if (list.length === 0) return;
  afterResponse(() =>
    queueEmbedding(type, list).catch((err) =>
      console.error("[ai] could not queue embeddings:", (err as Error).message),
    ),
  ).catch(() => {
    // Not inside a request: nothing to schedule.
  });
}

export const embedJob = defineJob({
  name: EMBED_JOB,
  payload: z.object({ entityType: z.enum(embeddingEntityTypes), entityId: z.uuid() }),
  maxAttempts: 3,
  async run({ entityType, entityId }, { db }) {
    return indexEntity(db, entityType, entityId);
  },
});

export const embedBackfillJob = defineJob({
  name: EMBED_BACKFILL_JOB,
  payload: z.object({ types: z.array(z.enum(embeddingEntityTypes)).optional() }),
  maxAttempts: 2,
  async run({ types }, { db }) {
    return backfillEmbeddings(db, { types });
  },
});

/** Nightly safety net (jobs/cron.ts). */
export async function queueEmbeddingBackfill(db?: DbOrTx): Promise<string | null> {
  return enqueue(
    EMBED_BACKFILL_JOB,
    {},
    { db: db ?? (await getDb()), dedupeKey: EMBED_BACKFILL_JOB, maxAttempts: 2 },
  );
}
