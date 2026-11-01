import { sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { agencyColumn, idColumn, timestamps, tsvector } from "./_common";

/** The AI service layer's tables (05 §14, 10). */

/**
 * Vector size of `embeddings.embedding`. Every embedding provider returns this many numbers
 * (the default Workers AI model `@cf/baai/bge-m3` returns 1024). Changing it needs a migration
 * that alters the column and the index, then a re-embed (`ai.embed_backfill`).
 */
export const EMBEDDING_DIMENSIONS = 1024;

export const embeddingEntityTypes = [
  "property",
  "project",
  "page",
  "post",
  "area_guide",
  "faq",
  "developer",
] as const;
export type EmbeddingEntityType = (typeof embeddingEntityTypes)[number];

/**
 * Text chunks of public content with their vectors (10 §1). Rebuilt on publish and update,
 * removed on unpublish. Retrieval only: prices and statuses are always read live.
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    entityType: text({ enum: embeddingEntityTypes }).notNull(),
    entityId: uuid().notNull(),
    chunkIndex: integer().notNull(),
    content: text().notNull(),
    /** SHA-256 of the chunk text + model: an unchanged chunk is never embedded again. */
    contentHash: text().notNull(),
    /** Which embedding model made the vector; search only compares vectors of one model. */
    model: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    contentVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, lintel_normalize(content))`,
    ),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("embeddings_entity_chunk_unique").on(
      t.agencyId,
      t.entityType,
      t.entityId,
      t.chunkIndex,
    ),
    index("embeddings_entity_idx").on(t.entityType, t.entityId),
    index("embeddings_vector_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("embeddings_content_fts_idx").using("gin", t.contentVector),
  ],
);

export const aiActionStatuses = [
  "proposed",
  "confirmed",
  "rejected",
  "executed",
  "failed",
] as const;
export type AiActionStatus = (typeof aiActionStatuses)[number];
export const aiActionSources = ["admin_chat", "mcp"] as const;
export type AiActionSource = (typeof aiActionSources)[number];

/**
 * Write actions the AI proposed (10 §3 confirm flow). Nothing runs until an admin confirms;
 * the preview is what the admin saw.
 */
export const aiActions = pgTable(
  "ai_actions",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    /** The admin whose assistant (or MCP token) proposed it. */
    adminId: uuid(),
    /** Conversation or MCP session the proposal came from. */
    conversationRef: text(),
    tool: text().notNull(),
    input: jsonb().$type<Record<string, unknown>>().notNull(),
    preview: jsonb().$type<Record<string, unknown>>().notNull(),
    status: text({ enum: aiActionStatuses }).notNull().default("proposed"),
    result: jsonb(),
    error: text(),
    /** The admin who confirmed or rejected it. */
    decidedBy: uuid(),
    confirmedAt: timestamp({ withTimezone: true }),
    rejectedAt: timestamp({ withTimezone: true }),
    executedAt: timestamp({ withTimezone: true }),
    source: text({ enum: aiActionSources }).notNull().default("admin_chat"),
    ...timestamps(),
  },
  (t) => [
    index("ai_actions_status_idx").on(t.agencyId, t.status, t.createdAt.desc()),
    index("ai_actions_conversation_idx").on(t.conversationRef),
  ],
);

export const aiFeatures = [
  "customer_chat",
  "whatsapp",
  "admin_chat",
  "description",
  "seo",
  "blog",
  "valuation",
  "scoring",
  "summary",
  "alt_text",
  "listing_from_text",
  "topics",
  "embeddings",
] as const;
export type AiFeature = (typeof aiFeatures)[number];

/** Requests, tokens and estimated cost per day, feature and model (10 §1, 04 §9 spend limit). */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    /** Calendar day in the agency's time zone. */
    date: date().notNull(),
    feature: text({ enum: aiFeatures }).notNull(),
    model: text().notNull(),
    requests: integer().notNull().default(0),
    inputTokens: bigint({ mode: "number" }).notNull().default(0),
    outputTokens: bigint({ mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint({ mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint({ mode: "number" }).notNull().default(0),
    /** Estimated cost in millionths of a US dollar (prices in features/ai/pricing.ts). */
    costEstimateMicros: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("ai_usage_day_feature_model_unique").on(t.agencyId, t.date, t.feature, t.model),
  ],
);

export type ChatTopic = {
  /** A short name for what visitors asked about ("Service charges in JVC"). */
  label: string;
  /** How many of the week's questions fall under it. */
  count: number;
  /** Two or three questions in the visitors' words (contact details removed). */
  examples: string[];
  /** A blog post that would answer it, when one fits. */
  blogIdea: string | null;
};

/**
 * The week's common chat questions, grouped by the weekly job (10 §5 "Chat topic clustering",
 * 13 §2 Mondays): what visitors asked in the website chat and on WhatsApp, for the dashboard's
 * blog topic suggestions and the assistant's `chat_topics` tool.
 */
export const chatTopicReports = pgTable(
  "chat_topic_reports",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    /** The first of the seven days grouped (agency time zone): the Monday before the run. */
    weekStart: date().notNull(),
    questionCount: integer().notNull().default(0),
    topics: jsonb().$type<ChatTopic[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [uniqueIndex("chat_topic_reports_week_unique").on(t.agencyId, t.weekStart)],
);
