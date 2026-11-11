import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agencyColumn, geoPolygon, idColumn, timestamps } from "./_common";
import { users } from "./auth";
import { projects } from "./projects";
import { properties } from "./properties";

/** Customer features (05 §13, 12): saved homes and lists, saved searches, alerts, compare. */

/** Lists of saved homes: the default "Saved" and the customer's own ("For my parents"). */
export const savedLists = pgTable(
  "saved_lists",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    isDefault: boolean().notNull().default(false),
    /** Share by link (12 §2): set when the customer shares the list. */
    shareToken: text(),
    sortOrder: integer().notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("saved_lists_user_idx").on(t.userId),
    uniqueIndex("saved_lists_share_unique").on(t.shareToken),
  ],
);

export const savedHomes = pgTable(
  "saved_homes",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listId: uuid()
      .notNull()
      .references((): AnyPgColumn => savedLists.id, { onDelete: "cascade" }),
    propertyId: uuid().references(() => properties.id, { onDelete: "cascade" }),
    projectId: uuid().references(() => projects.id, { onDelete: "cascade" }),
    note: text(),
    /** What the home was when saved, to show "Price dropped by AED 50,000" or "Now reserved". */
    /** Minor units of the listing's currency. */
    priceWhenSaved: bigint({ mode: "number" }),
    statusWhenSaved: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("saved_homes_user_idx").on(t.userId, t.createdAt),
    index("saved_homes_property_idx").on(t.propertyId),
    uniqueIndex("saved_homes_list_property_unique").on(t.listId, t.propertyId),
    uniqueIndex("saved_homes_list_project_unique").on(t.listId, t.projectId),
  ],
);

export const alertFrequencies = ["instant", "daily", "weekly", "off"] as const;

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Same shape as the search URL (features/search/params). */
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** "Draw your area" (06 §4). */
    polygon: geoPolygon(),
    alertFrequency: text({ enum: alertFrequencies }).notNull().default("daily"),
    lastSentAt: timestamp({ withTimezone: true }),
    /** Hash of the one-click unsubscribe token in its alert emails. */
    unsubscribeTokenHash: text(),
    ...timestamps(),
  },
  (t) => [
    index("saved_searches_user_idx").on(t.userId),
    index("saved_searches_frequency_idx").on(t.agencyId, t.alertFrequency),
  ],
);

/** Every alert sent, so a listing is never sent twice for the same search or saved home. */
export const alertsSent = pgTable(
  "alerts_sent",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    savedSearchId: uuid().references(() => savedSearches.id, { onDelete: "cascade" }),
    savedHomeId: uuid().references(() => savedHomes.id, { onDelete: "cascade" }),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    kind: text({ enum: ["new_match", "price_drop", "status_change", "similar_home"] }).notNull(),
    /** For price drops and status changes: what changed, so a later change sends again. */
    detail: text().notNull().default(""),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Never the same listing twice" (12 §3): one row per search (or saved home), listing,
    // kind and detail.
    uniqueIndex("alerts_sent_search_unique")
      .on(t.savedSearchId, t.propertyId, t.kind, t.detail)
      .where(sql`saved_search_id is not null`),
    uniqueIndex("alerts_sent_home_unique")
      .on(t.savedHomeId, t.propertyId, t.kind, t.detail)
      .where(sql`saved_home_id is not null`),
  ],
);

/** The compare set (up to 4 homes): a customer's, or a guest's by visitor id. */
export const compareSets = pgTable(
  "compare_sets",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    visitorKey: text(),
    propertyIds: uuid().array().notNull().default([]),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("compare_sets_user_unique").on(t.userId),
    uniqueIndex("compare_sets_visitor_unique").on(t.agencyId, t.visitorKey),
  ],
);

export type AlertChannels = { email: boolean; whatsapp: boolean };

/** A customer's notification choices (12 §2 Notifications). */
export const customerPreferences = pgTable("customer_preferences", {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  agencyId: agencyColumn(),
  newMatch: jsonb().$type<AlertChannels>().notNull().default({ email: true, whatsapp: false }),
  priceDrop: jsonb().$type<AlertChannels>().notNull().default({ email: true, whatsapp: false }),
  statusChange: jsonb().$type<AlertChannels>().notNull().default({ email: true, whatsapp: false }),
  /** WhatsApp alerts only with this opt-in, and only through approved templates (12 §3). */
  whatsappOptInAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
