import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  agencyColumn,
  baseColumns,
  geoPoint,
  idColumn,
  numericNumber,
  seoColumns,
  softDelete,
  timestamps,
  tsvector,
} from "./_common";
import { badges, facilities, locations, pois, propertyTypes } from "./master-data";
import { media } from "./media";
import { paymentPlans } from "./payment-plans";
import { agents } from "./people";
import type { RichDoc } from "@/lib/rich-text";
import { listingMediaKinds, projectUnitTypes, projects } from "./projects";

export const propertyPurposes = ["sale", "rent"] as const;
export const propertyStatuses = [
  "draft",
  "available",
  "reserved",
  "under_offer",
  "sold",
  "rented",
  "off_market",
] as const;
export const propertyCompletions = ["ready", "off_plan"] as const;
export const pricePeriods = ["year", "month"] as const;
export const propertySources = ["manual", "import", "ai_draft"] as const;

export type PropertyStatus = (typeof propertyStatuses)[number];

/** Listing references (HD-1001, ...): the prefix comes from Settings -> General. */
export const propertyReferenceSeq = pgSequence("property_reference_seq", { startWith: 1001 });

/** Listings (05 §5). Money is minor units of `currency`; areas are m². */
export const properties = pgTable(
  "properties",
  {
    ...baseColumns(),
    // Basics
    reference: text().notNull(),
    title: text().notNull(),
    purpose: text({ enum: propertyPurposes }).notNull(),
    status: text({ enum: propertyStatuses }).notNull().default("draft"),
    completion: text({ enum: propertyCompletions }).notNull().default("ready"),
    propertyTypeId: uuid().references(() => propertyTypes.id, { onDelete: "restrict" }),
    locationId: uuid().references(() => locations.id, { onDelete: "restrict" }),
    projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
    projectUnitTypeId: uuid().references(() => projectUnitTypes.id, { onDelete: "set null" }),
    addressLine: text(),
    buildingName: text(),
    /** Private: never shown on the site or in feeds. */
    unitNumber: text(),
    floor: text(),
    point: geoPoint(),
    /** Off: the public map shows an approximate area instead of the exact pin. */
    mapPinExact: boolean().notNull().default(false),
    // Price
    price: bigint({ mode: "number" }),
    currency: text(),
    priceOnRequest: boolean().notNull().default(false),
    pricePeriod: text({ enum: pricePeriods }),
    pricePerArea: numericNumber().generatedAlwaysAs(
      sql`case when size > 0 and price is not null then round(price / size) end`,
    ),
    originalPrice: bigint({ mode: "number" }),
    serviceChargePerArea: bigint({ mode: "number" }),
    rentPaymentOptions: integer().array().notNull().default([]),
    monthlyPaymentAvailable: boolean().notNull().default(false),
    depositAmount: bigint({ mode: "number" }),
    agencyFeeText: text(),
    // Specs
    beds: integer(),
    baths: integer(),
    size: numericNumber(),
    plotSize: numericNumber(),
    yearBuilt: integer(),
    parkingSpaces: integer(),
    furnishing: text(),
    ownership: text(),
    view: text().array().notNull().default([]),
    floorCount: integer(),
    maidRoom: boolean().notNull().default(false),
    study: boolean().notNull().default(false),
    // Off-plan
    handoverDate: date(),
    handoverText: text(),
    paymentPlanId: uuid().references(() => paymentPlans.id, { onDelete: "set null" }),
    constructionProgress: integer(),
    // Investor
    expectedRentYearly: bigint({ mode: "number" }),
    expectedYield: numericNumber().generatedAlwaysAs(
      sql`case when purpose = 'sale' and price > 0 and expected_rent_yearly is not null then round(expected_rent_yearly::numeric * 100 / price, 2) end`,
    ),
    isTenanted: boolean().notNull().default(false),
    tenancyEndDate: date(),
    // Content
    description: jsonb().$type<RichDoc>(),
    descriptionHtml: text(),
    highlights: text().array().notNull().default([]),
    videoUrl: text(),
    tourUrl: text(),
    // Trust
    permitNumber: text(),
    isVerified: boolean().notNull().default(false),
    lastVerifiedAt: timestamp({ withTimezone: true }),
    verifiedBy: uuid(),
    // Ops
    agentId: uuid().references(() => agents.id, { onDelete: "restrict" }),
    isFeatured: boolean().notNull().default(false),
    featuredUntil: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    /**
     * When it last went live: the first publish, or coming back from off market or a draft.
     * Saved-search digests use it, so a listing back on the market reaches them too.
     */
    wentLiveAt: timestamp({ withTimezone: true }),
    viewsCount: integer().notNull().default(0),
    inquiriesCount: integer().notNull().default(0),
    source: text({ enum: propertySources }).notNull().default("manual"),
    /** Location names and other words to find the listing by; kept up to date on save. */
    searchText: text(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', lintel_normalize(coalesce(title, '') || ' ' || coalesce(building_name, '') || ' ' || coalesce(reference, '') || ' ' || coalesce(search_text, '')))`,
    ),
    ...seoColumns(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex("properties_reference_unique").on(t.agencyId, t.reference),
    uniqueIndex("properties_slug_unique").on(t.agencyId, t.slug),
    index("properties_point_gist").using("gist", t.point),
    index("properties_point_geog_gist").using("gist", sql`(${t.point}::geography)`),
    index("properties_search_gin").using("gin", t.searchVector),
    index("properties_title_trgm").using("gin", sql`lintel_normalize(${t.title}) gin_trgm_ops`),
    index("properties_building_trgm").using(
      "gin",
      sql`lintel_normalize(coalesce(${t.buildingName}, '')) gin_trgm_ops`,
    ),
    index("properties_purpose_status_price_idx").on(t.agencyId, t.purpose, t.status, t.price),
    index("properties_location_idx").on(t.locationId),
    index("properties_beds_idx").on(t.beds),
    index("properties_agent_idx").on(t.agentId),
    index("properties_project_idx").on(t.projectId),
  ],
);

export const propertyMedia = pgTable(
  "property_media",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    mediaId: uuid()
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    kind: text({ enum: listingMediaKinds }).notNull().default("photo"),
    sortOrder: integer().notNull().default(0),
    isCover: boolean().notNull().default(false),
    caption: text(),
    /** Per-listing alt text; falls back to the file's alt text in the library. */
    alt: text(),
    ...timestamps(),
  },
  (t) => [
    index("property_media_property_idx").on(t.propertyId, t.kind, t.sortOrder),
    index("property_media_media_idx").on(t.mediaId),
  ],
);

export const propertyFacilities = pgTable(
  "property_facilities",
  {
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    facilityId: uuid()
      .notNull()
      .references(() => facilities.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.facilityId] }),
    index("property_facilities_facility_idx").on(t.facilityId),
  ],
);

export const propertyBadges = pgTable(
  "property_badges",
  {
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    badgeId: uuid()
      .notNull()
      .references(() => badges.id, { onDelete: "restrict" }),
    isAuto: boolean().notNull().default(false),
    /** Automatic badges with a time limit ("New" for 14 days) end here. */
    expiresAt: timestamp({ withTimezone: true }),
    /** Why an automatic badge applies, shown read-only in the editor. */
    reason: text(),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.badgeId] }),
    index("property_badges_badge_idx").on(t.badgeId),
  ],
);

/** Measured distances and travel times to nearby places (07 §4). */
export const propertyPois = pgTable(
  "property_pois",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    poiId: uuid()
      .notNull()
      .references(() => pois.id, { onDelete: "cascade" }),
    straightDistanceM: integer().notNull(),
    driveSeconds: integer(),
    driveDistanceM: integer(),
    walkSeconds: integer(),
    walkDistanceM: integer(),
    computedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    isShown: boolean().notNull().default(true),
    isManualOverride: boolean().notNull().default(false),
    overrideText: text(),
    sortOrder: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("property_pois_unique").on(t.propertyId, t.poiId),
    index("property_pois_poi_idx").on(t.poiId),
  ],
);

export const priceHistory = pgTable(
  "price_history",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    oldPrice: bigint({ mode: "number" }),
    newPrice: bigint({ mode: "number" }),
    currency: text(),
    changedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    changedBy: uuid(),
  },
  (t) => [index("price_history_property_idx").on(t.propertyId, t.changedAt.desc())],
);

export const propertyDailyStats = pgTable(
  "property_daily_stats",
  {
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    date: date().notNull(),
    views: integer().notNull().default(0),
    saves: integer().notNull().default(0),
    inquiries: integer().notNull().default(0),
    shares: integer().notNull().default(0),
    brochureDownloads: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.date] })],
);
