import { date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { agencyColumn, idColumn } from "./_common";

export const reportDeliveryKinds = ["weekly", "daily"] as const;

/**
 * Scheduled report emails that went out (09 §7 weekly report, 13 §3 daily summary). One row per
 * agency, kind and period: the unique index is what makes the weekly email go out once per
 * week, even when the cron fires twice or a retried job runs again.
 */
export const reportDeliveries = pgTable(
  "report_deliveries",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    kind: text({ enum: reportDeliveryKinds }).notNull(),
    /** First and last day of the period in the agency's time zone. */
    periodStart: date().notNull(),
    periodEnd: date().notNull(),
    recipients: text().array().notNull().default([]),
    emailCount: integer().notNull().default(0),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("report_deliveries_period_unique").on(t.agencyId, t.kind, t.periodStart),
    index("report_deliveries_sent_idx").on(t.agencyId, t.sentAt.desc()),
  ],
);
