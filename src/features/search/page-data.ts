import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import {
  badges,
  facilities,
  locations,
  poiTypes,
  pois,
  propertyTypes,
} from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { properties } from "@/db/schema/properties";
import { guideForLocation, type LandingGuide } from "@/features/area-guides/public";
import { loadListingCards, type ListingCardData } from "@/features/listings/cards";
import { searchableStatuses } from "@/features/properties/status";
import { loadSettings } from "@/features/settings/queries";
import { tags } from "@/lib/cache-tags";
import { searchChips, type SearchLabels } from "./labels";
import { searchHref, type SearchFilters } from "./params";
import { searchConditions } from "./query";

/* Landing routes ---------------------------------------------------------------------- */

export type LandingInfo = {
  location: {
    id: string;
    slug: string;
    name: string;
    level: string;
    description: string | null;
    parentId: string | null;
  } | null;
  type: { slug: string; name: string } | null;
  /** The area's published guide: its intro opens the page and its questions close it. */
  guide: LandingGuide | null;
};

/** The location and type of an SEO landing route, or null when either slug is unknown. */
export async function landingFor(
  locationSlug: string | null,
  typeSlug: string | null,
): Promise<LandingInfo | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.locations, tags.masterData("property-types"), tags.areaGuides, tags.faqs);
  const db = await getDb();
  const agency = currentAgencyId();
  let location: LandingInfo["location"] = null;
  if (locationSlug) {
    const [row] = await db
      .select({
        id: locations.id,
        slug: locations.slug,
        name: locations.name,
        level: locations.level,
        description: locations.description,
        parentId: locations.parentId,
      })
      .from(locations)
      .where(and(eq(locations.agencyId, agency), eq(locations.slug, locationSlug)));
    if (!row) return null;
    location = row;
  }
  let type: LandingInfo["type"] = null;
  if (typeSlug) {
    const [row] = await db
      .select({ slug: propertyTypes.slug, name: propertyTypes.name })
      .from(propertyTypes)
      .where(and(eq(propertyTypes.agencyId, agency), eq(propertyTypes.slug, typeSlug)));
    if (!row) return null;
    type = row;
  }
  return { location, type, guide: location ? await guideForLocation(location.id) : null };
}

/* Labels for headings and chips ------------------------------------------------------- */

/** Names for the slugs and ids in a search (cached per set of values). */
export async function searchLabels(f: SearchFilters): Promise<SearchLabels> {
  "use cache";
  cacheLife("hours");
  cacheTag(
    tags.locations,
    tags.projects,
    tags.agents,
    tags.masterData("property-types"),
    tags.masterData("facilities"),
    tags.masterData("badges"),
    tags.masterData("pois"),
  );
  const db = await getDb();
  const agency = currentAgencyId();
  const labels: SearchLabels = { places: {}, types: {}, facilities: {}, badges: {}, agent: null };
  const locSlugs = f.loc.filter((l) => !l.startsWith("p."));
  const projectSlugs = f.loc.filter((l) => l.startsWith("p.")).map((l) => l.slice(2));
  if (locSlugs.length) {
    const rows = await db
      .select({ slug: locations.slug, name: locations.name })
      .from(locations)
      .where(and(eq(locations.agencyId, agency), inArray(locations.slug, locSlugs)));
    for (const r of rows) labels.places[r.slug] = r.name;
  }
  if (projectSlugs.length) {
    const rows = await db
      .select({ slug: projects.slug, name: projects.name })
      .from(projects)
      .where(and(eq(projects.agencyId, agency), inArray(projects.slug, projectSlugs)));
    for (const r of rows) labels.places[`p.${r.slug}`] = r.name;
  }
  if (f.type.length) {
    const rows = await db
      .select({ slug: propertyTypes.slug, name: propertyTypes.name })
      .from(propertyTypes)
      .where(and(eq(propertyTypes.agencyId, agency), inArray(propertyTypes.slug, f.type)));
    for (const r of rows) labels.types[r.slug] = r.name;
  }
  if (f.fac.length) {
    const rows = await db
      .select({ id: facilities.id, name: facilities.name })
      .from(facilities)
      .where(and(eq(facilities.agencyId, agency), inArray(facilities.id, f.fac)));
    for (const r of rows) labels.facilities[r.id] = r.name;
  }
  if (f.commute) {
    const [place] = await db
      .select({ name: pois.name })
      .from(pois)
      .where(and(eq(pois.agencyId, agency), eq(pois.id, f.commute.poi)));
    labels.commutePlace = place?.name ?? null;
  }
  const badgeIds = f.badge.filter((b) => /^[0-9a-f-]{36}$/i.test(b));
  if (badgeIds.length) {
    const rows = await db
      .select({ id: badges.id, name: badges.name })
      .from(badges)
      .where(and(eq(badges.agencyId, agency), inArray(badges.id, badgeIds)));
    for (const r of rows) labels.badges[r.id] = r.name;
  }
  if (f.agent) {
    const [row] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.agencyId, agency), eq(agents.slug, f.agent)));
    labels.agent = row?.name ?? null;
  }
  return labels;
}

/* Filter options ---------------------------------------------------------------------- */

export type SearchOptions = {
  types: Array<{ slug: string; name: string }>;
  facilities: Array<{ id: string; name: string; group: string }>;
  furnishing: string[];
  rentPaymentOptions: number[];
  /** This year, for the handover filter (from the server, not the render). */
  year: number;
  /** The agency's places for the commute filter (11 §9), grouped by type. */
  places: Array<{ id: string; name: string; typeName: string }>;
};

export async function searchOptions(): Promise<SearchOptions> {
  "use cache";
  cacheLife("hours");
  cacheTag(
    tags.masterData("property-types"),
    tags.masterData("facilities"),
    tags.masterData("pois"),
    tags.masterData("poi-types"),
    tags.settings("market"),
  );
  const db = await getDb();
  const agency = currentAgencyId();
  const market = await loadSettings("market", db);
  const typeRows = await db
    .select({ slug: propertyTypes.slug, name: propertyTypes.name })
    .from(propertyTypes)
    .where(eq(propertyTypes.agencyId, agency))
    .orderBy(asc(propertyTypes.sortOrder), asc(propertyTypes.name));
  const facilityRows = await db
    .select({ id: facilities.id, name: facilities.name, group: facilities.group })
    .from(facilities)
    .where(eq(facilities.agencyId, agency))
    .orderBy(asc(facilities.sortOrder), asc(facilities.name));
  const placeRows = await db
    .select({ id: pois.id, name: pois.name, typeName: poiTypes.name })
    .from(pois)
    .innerJoin(poiTypes, eq(poiTypes.id, pois.poiTypeId))
    .where(and(eq(pois.agencyId, agency), eq(pois.isActive, true)))
    .orderBy(asc(poiTypes.sortOrder), asc(poiTypes.name), asc(pois.name))
    .limit(500);
  return {
    places: placeRows,
    types: typeRows,
    facilities: facilityRows,
    furnishing: market.furnishingOptions,
    rentPaymentOptions: market.rentPaymentOptions,
    year: new Date().getFullYear(),
  };
}

/* Counts and references --------------------------------------------------------------- */

/** How many live listings match (the "Show N homes" button, no-results help). */
export async function countListings(f: SearchFilters): Promise<number> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.search, tags.listings);
  const db = await getDb();
  const market = await loadSettings("market", db);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(properties)
    .where(and(...searchConditions({ ...f, page: 1 }, market)));
  return row?.n ?? 0;
}

/** "Jump to a reference" (06 §4.2 `ref`): the slug of the live listing with it. */
export async function liveListingSlugByRef(ref: string): Promise<string | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.listings);
  const db = await getDb();
  const [row] = await db
    .select({ slug: properties.slug })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, currentAgencyId()),
        sql`upper(${properties.reference}) = upper(${ref.trim()})`,
        isNull(properties.deletedAt),
        isNotNull(properties.publishedAt),
        inArray(properties.status, ["available", "reserved", "under_offer", "sold", "rented"]),
      ),
    );
  return row?.slug ?? null;
}

/** One card for the map's selected pin; only listings that show in search. */
export async function publicCard(id: string): Promise<ListingCardData | null> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.listing(id), tags.search);
  const db = await getDb();
  const [row] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(
      and(
        eq(properties.id, id),
        eq(properties.agencyId, currentAgencyId()),
        isNull(properties.deletedAt),
        isNotNull(properties.publishedAt),
        inArray(properties.status, [...searchableStatuses]),
      ),
    );
  if (!row) return null;
  const [card] = await loadListingCards(db, [id]);
  return card ?? null;
}

/* No results (06 §4.6) ---------------------------------------------------------------- */

export type Suggestion = { label: string; href: string; count: number };

/**
 * Which single filter to drop to get results, best first: each chip removed in turn and
 * counted. Only filters that would bring results back.
 */
export async function relaxSuggestions(
  f: SearchFilters,
  labels: SearchLabels,
  units: Parameters<typeof searchChips>[2],
): Promise<Suggestion[]> {
  const chips = searchChips(f, labels, units);
  const out: Suggestion[] = [];
  for (const chip of chips) {
    const next = chip.remove(f);
    const count = await countListings(next);
    if (count > 0) out.push({ label: chip.label, href: searchHref(next), count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 3);
}

/** Areas next to the searched one (same parent), with how many homes match there. */
export async function siblingAreas(f: SearchFilters): Promise<Suggestion[]> {
  const only = f.loc.length === 1 && !f.loc[0]!.startsWith("p.") ? f.loc[0]! : null;
  if (!only) return [];
  const siblings = await siblingLocations(only);
  const out: Suggestion[] = [];
  for (const s of siblings) {
    const next = { ...f, loc: [s.slug], page: 1 };
    const count = await countListings(next);
    if (count > 0) out.push({ label: s.name, href: searchHref(next), count });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

async function siblingLocations(slug: string): Promise<Array<{ slug: string; name: string }>> {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.locations);
  const db = await getDb();
  const agency = currentAgencyId();
  const [self] = await db
    .select({ id: locations.id, parentId: locations.parentId })
    .from(locations)
    .where(and(eq(locations.agencyId, agency), eq(locations.slug, slug)));
  if (!self?.parentId) return [];
  return db
    .select({ slug: locations.slug, name: locations.name })
    .from(locations)
    .where(
      and(
        eq(locations.agencyId, agency),
        eq(locations.parentId, self.parentId),
        sql`${locations.id} <> ${self.id}`,
      ),
    )
    .orderBy(asc(locations.name))
    .limit(12);
}
