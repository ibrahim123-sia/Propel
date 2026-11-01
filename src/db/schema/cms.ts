import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agencyColumn, baseColumns, idColumn, seoColumns, softDelete } from "./_common";

export const pageStatuses = ["draft", "published", "scheduled"] as const;
export const pageTemplates = ["default", "landing", "legal"] as const;

/** A section as stored: `{ id, type, props, style }` (08 §1). Validated by features/cms/sections.ts. */
export type StoredSection = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  style?: Record<string, unknown>;
  /** Kept on the page but not shown ("hide" in the page builder's section list). */
  hidden?: boolean;
};

/** Pages built from sections (05 §8, 08 §1). One page is the home page. */
export const pages = pgTable(
  "pages",
  {
    ...baseColumns(),
    title: text().notNull(),
    status: text({ enum: pageStatuses }).notNull().default("draft"),
    publishAt: timestamp({ withTimezone: true }),
    template: text({ enum: pageTemplates }).notNull().default("default"),
    /** What the site shows. */
    sections: jsonb().$type<StoredSection[]>().notNull().default([]),
    /** The page builder's working copy; Publish copies it to `sections` (08 §1). */
    draftSections: jsonb().$type<StoredSection[]>(),
    draftUpdatedAt: timestamp({ withTimezone: true }),
    isHome: boolean().notNull().default(false),
    /** The website chat button stays off on this page (06 §2), e.g. a campaign landing page. */
    hideChat: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    ...seoColumns(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex("pages_slug_unique").on(t.agencyId, t.slug),
    // Only one home page per agency.
    uniqueIndex("pages_home_unique")
      .on(t.agencyId)
      .where(sql`${t.isHome} and ${t.deletedAt} is null`),
  ],
);

/** The last 20 versions of a page (08 §1 "Revisions"). */
export const pageRevisions = pgTable(
  "page_revisions",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    pageId: uuid()
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    sections: jsonb().$type<StoredSection[]>().notNull(),
    seo: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_revisions_page_idx").on(t.pageId, t.createdAt.desc())],
);
