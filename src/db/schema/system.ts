import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  jsonb,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agencyColumn, baseColumns, idColumn, timestamps } from "./_common";

export const settingGroups = [
  "general",
  "branding",
  "market",
  "contact",
  "leads",
  "viewings",
  "seo",
  "integrations",
  "ai",
  "notifications",
  "legal",
  "security",
  /** Footer text and the announcement bar, edited at Website -> Menus (08 §2). */
  "website",
  /** Which demo preset is loaded and which one the next reset loads (16 §2-3). */
  "demo",
] as const;
export type SettingGroup = (typeof settingGroups)[number];

/** One typed JSON document per settings group (04-settings.md). */
export const settings = pgTable(
  "settings",
  {
    ...baseColumns(),
    group: text({ enum: settingGroups }).notNull(),
    value: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex("settings_agency_group_unique").on(t.agencyId, t.group)],
);

/** Integration keys, AES-256-GCM encrypted at rest. Never sent to the client. */
export const secrets = pgTable(
  "secrets",
  {
    ...baseColumns(),
    key: text().notNull(),
    encryptedValue: text().notNull(),
    lastTestedAt: timestamp({ withTimezone: true }),
    lastError: text(),
  },
  (t) => [uniqueIndex("secrets_agency_key_unique").on(t.agencyId, t.key)],
);

export const actorTypes = ["admin", "ai", "system"] as const;
export type ActorType = (typeof actorTypes)[number];

/** Append-only (a trigger blocks UPDATE and DELETE; see migration 0002). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    actorType: text({ enum: actorTypes }).notNull(),
    actorId: uuid(),
    /** For AI actions: the admin who confirmed it (10-ai.md §3, confirm flow step 3). */
    confirmedBy: uuid(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    before: jsonb(),
    after: jsonb(),
    /** Truncated (IPv4 /24, IPv6 /48) for privacy (14-non-functional.md §3). */
    ip: text(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_created_idx").on(t.agencyId, t.createdAt.desc()),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    index("audit_log_actor_idx").on(t.actorId, t.createdAt.desc()),
  ],
);

/** App rate limits (forms, chat, tools). Fixed windows keyed by scope + subject + window. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().primaryKey(),
    count: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limits_expires_idx").on(t.expiresAt)],
);

export const jobStatuses = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobStatus = (typeof jobStatuses)[number];

/** Every background job run, for the admin Jobs page (13-integrations-and-jobs.md §2). */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    name: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text({ enum: jobStatuses }).notNull().default("queued"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    /** Idempotency: a second enqueue with the same key while one is pending is a no-op. */
    dedupeKey: text(),
    runAfter: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    lastError: text(),
    result: jsonb(),
    ...timestamps(),
  },
  (t) => [
    index("job_runs_status_idx").on(t.status, t.runAfter),
    index("job_runs_name_idx").on(t.name, t.createdAt.desc()),
    uniqueIndex("job_runs_dedupe_unique")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('queued','running')`),
  ],
);

export const emailStatuses = ["queued", "sent", "mocked", "failed"] as const;

/** Outgoing email log (status tracking; doubles as the dev outbox when no provider is set). */
export const emailLog = pgTable(
  "email_log",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    to: text().notNull(),
    subject: text().notNull(),
    template: text().notNull(),
    html: text(),
    text: text(),
    status: text({ enum: emailStatuses }).notNull().default("queued"),
    // "resend": emails sent before SMTP replaced it.
    provider: text({ enum: ["smtp", "resend", "mock"] }).notNull(),
    providerId: text(),
    error: text(),
    relatedType: text(),
    relatedId: text(),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_log_created_idx").on(t.agencyId, t.createdAt.desc()),
    index("email_log_to_idx").on(t.to),
  ],
);
