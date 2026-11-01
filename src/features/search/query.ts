import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pois } from "@/db/schema/master-data";
import { properties } from "@/db/schema/properties";
import { loadListingCards, type ListingCardData } from "@/features/listings/cards";
import { publicPoint } from "@/features/listings/public-point";
import { searchableStatuses } from "@/features/properties/status";
import { loadSettings } from "@/features/settings/queries";
import { tags } from "@/lib/cache-tags";
import { areaToSqm } from "@/lib/units";
import { PAGE_SIZE, type SearchCommute, type SearchFilters } from "./params";

type Market = Awaited<ReturnType<typeof loadSettings<"market">>>;

export type SearchPin = {
  id: string;
  slug: string;
  lng: number;
  lat: number;
  /** The exact pin is private: an approximate area is shown instead (06 §4.5). */
  approx: boolean;
  price: number | null;
  currency: string;
  pricePeriod: "year" | "month" | null;
};

export type SearchResult = {
  total: number;
  page: number;
  pages: number;
  cards: ListingCardData[];
};

/** A listing's price in minor units of the base currency (listings keep their own currency). */
export function priceInBase(market: Market): SQL {
  const base = market.baseCurrency;
  const cases = market.visitorCurrencies
    .filter((c) => c.code !== base.code)
    .map(
      (c) =>
        sql`when ${c.code} then round(${properties.price}::numeric / ${10 ** c.decimals} / ${c.rate} * ${10 ** base.decimals})`,
    );
  return cases.length
    ? sql`(case ${properties.currency} ${sql.join(cases, sql` `)} else ${properties.price}::numeric end)`
    : sql`${properties.price}::numeric`;
}

const handoverEnd = (h: string) => {
  const [year, q] = h.split("-Q");
  const month = q ? Number(q) * 3 : 12;
  const end = new Date(Date.UTC(Number(year), month, 0));
  return end.toISOString().slice(0, 10);
};

/**
 * Commute time to one of the agency's places (11 §9), cost-safe: the drive or walk time
 * measured for the listing (property_pois, from Google Routes when the place was among its
 * nearest) when there is one, else an estimate from the straight-line distance (roads are
 * about 40% longer; 30 km/h by car in town, 4.8 km/h on foot), labelled as an estimate.
 * Nothing calls Google on a page view (07 §4.7).
 */
export const COMMUTE_ESTIMATE = {
  drive: { detour: 1.4, metresPerMinute: 500 },
  walk: { detour: 1.3, metresPerMinute: 80 },
} as const;

/** Minutes from the listing to the place: measured when known, else estimated. Null: no pin. */
export function commuteMinutesSql(c: SearchCommute): SQL {
  const p = properties;
  const e = COMMUTE_ESTIMATE[c.mode];
  const measured =
    c.mode === "drive"
      ? sql`(select pp.drive_seconds from property_pois pp where pp.property_id = ${p.id} and pp.poi_id = ${c.poi}::uuid)`
      : sql`(select pp.walk_seconds from property_pois pp where pp.property_id = ${p.id} and pp.poi_id = ${c.poi}::uuid)`;
  // Only a live place of this agency counts, measured or not.
  const place = sql`(select poi.point::geography from pois poi where poi.id = ${c.poi}::uuid and poi.agency_id = ${currentAgencyId()} and poi.is_active)`;
  return sql`(case when ${place} is null then null else coalesce(
    ceil(${measured} / 60.0),
    ceil(ST_Distance(${p.point}::geography, ${place}) * ${e.detour} / ${e.metresPerMinute})
  ) end)`;
}

/** Whether the time is a measurement (false: the straight-line estimate). */
export function commuteMeasuredSql(c: SearchCommute): SQL {
  const column = c.mode === "drive" ? sql`pp.drive_seconds` : sql`pp.walk_seconds`;
  return sql`exists (select 1 from property_pois pp where pp.property_id = ${properties.id} and pp.poi_id = ${c.poi}::uuid and ${column} is not null)`;
}

/** WHERE conditions for the filters (06 §4.2). Only live, searchable listings. */
export function searchConditions(f: SearchFilters, market: Market): SQL[] {
  const agency = currentAgencyId();
  const p = properties;
  const where: SQL[] = [
    eq(p.agencyId, agency),
    isNull(p.deletedAt),
    isNotNull(p.publishedAt),
    inArray(p.status, [...searchableStatuses]),
    eq(p.purpose, f.purpose),
  ];
  if (f.completion) where.push(eq(p.completion, f.completion));

  const locSlugs = f.loc.filter((l) => !l.startsWith("p."));
  const projectSlugs = f.loc.filter((l) => l.startsWith("p.")).map((l) => l.slice(2));
  const places: SQL[] = [];
  if (locSlugs.length)
    places.push(sql`${p.locationId} in (
      with recursive sub as (
        select id from locations where agency_id = ${agency} and slug in ${locSlugs}
        union all
        select l.id from locations l join sub on l.parent_id = sub.id
      ) select id from sub)`);
  if (projectSlugs.length)
    places.push(
      sql`${p.projectId} in (select id from projects where agency_id = ${agency} and slug in ${projectSlugs} and deleted_at is null)`,
    );
  if (places.length) where.push(sql`(${sql.join(places, sql` or `)})`);

  if (f.poly) {
    const ring = [...f.poly, f.poly[0]!].map(([lng, lat]) => `${lng} ${lat}`).join(", ");
    where.push(sql`ST_Within(${p.point}, ST_GeomFromText(${`POLYGON((${ring}))`}, 4326))`);
  }
  if (f.commute) where.push(sql`${commuteMinutesSql(f.commute)} <= ${f.commute.minutes}`);
  if (f.type.length)
    where.push(
      sql`${p.propertyTypeId} in (select id from property_types where agency_id = ${agency} and slug in ${f.type})`,
    );
  if (f.min !== null || f.max !== null) {
    const scale = 10 ** market.baseCurrency.decimals;
    const price = priceInBase(market);
    where.push(sql`${p.priceOnRequest} = false and ${p.price} is not null`);
    if (f.min !== null) where.push(sql`${price} >= ${Math.round(f.min * scale)}`);
    if (f.max !== null) where.push(sql`${price} <= ${Math.round(f.max * scale)}`);
  }
  if (f.beds.length) {
    const exact = f.beds.filter((b) => b < 5);
    const parts: SQL[] = [];
    if (exact.length) parts.push(sql`${p.beds} in ${exact}`);
    if (f.beds.includes(5)) parts.push(sql`${p.beds} >= 5`);
    where.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (f.baths !== null) where.push(sql`${p.baths} >= ${f.baths}`);
  if (f.smin !== null) where.push(sql`${p.size} >= ${areaToSqm(f.smin, market.areaUnit)}`);
  if (f.smax !== null) where.push(sql`${p.size} <= ${areaToSqm(f.smax, market.areaUnit)}`);
  if (f.furn) where.push(eq(p.furnishing, f.furn));
  if (f.fac.length)
    where.push(
      sql`(select count(*) from property_facilities pf where pf.property_id = ${p.id} and pf.facility_id in ${f.fac}) = ${f.fac.length}`,
    );
  for (const b of f.badge) {
    if (b === "verified") where.push(eq(p.isVerified, true));
    else if (b === "price_reduced" || b === "new_listing")
      where.push(
        sql`exists (select 1 from property_badges pb join badges bd on bd.id = pb.badge_id where pb.property_id = ${p.id} and bd.auto_rule = ${b} and (pb.expires_at is null or pb.expires_at > now()))`,
      );
    else
      where.push(
        sql`exists (select 1 from property_badges pb where pb.property_id = ${p.id} and pb.badge_id = ${b}::uuid)`,
      );
  }
  if (f.handover)
    where.push(
      sql`coalesce(${p.handoverDate}, (select handover_date from projects pr where pr.id = ${p.projectId})) <= ${handoverEnd(f.handover)}::date`,
    );
  if (f.plan) {
    const planId = sql`coalesce(${p.paymentPlanId}, (select payment_plan_id from projects pr where pr.id = ${p.projectId}))`;
    where.push(
      f.plan === "any"
        ? sql`${planId} is not null`
        : sql`exists (select 1 from payment_plan_steps s where s.payment_plan_id = ${planId} and s.stage = 'post_handover')`,
    );
  }
  if (f.cheques !== null) where.push(sql`${f.cheques} = any(${p.rentPaymentOptions})`);
  if (f.q)
    where.push(
      sql`(${p.searchVector} @@ websearch_to_tsquery('simple', lintel_normalize(${f.q})) or lintel_normalize(${p.title}) % lintel_normalize(${f.q}) or ${p.reference} ilike ${f.q})`,
    );
  if (f.agent)
    where.push(
      sql`${p.agentId} = (select id from agents where agency_id = ${agency} and slug = ${f.agent})`,
    );
  return where;
}

function orderBy(f: SearchFilters, market: Market): SQL[] {
  const p = properties;
  switch (f.sort) {
    case "price_asc":
      return [sql`${priceInBase(market)} asc nulls last`];
    case "price_desc":
      return [sql`${priceInBase(market)} desc nulls last`];
    case "size":
      return [sql`${p.size} desc nulls last`];
    case "ppa":
      return [sql`(${priceInBase(market)} / nullif(${p.size}, 0)) asc nulls last`];
    case "reduced":
      return [
        sql`(select max(changed_at) from price_history ph where ph.property_id = ${p.id} and ph.new_price < ph.old_price) desc nulls last`,
      ];
    default:
      return [sql`${p.isFeatured} desc`, sql`${p.publishedAt} desc nulls last`];
  }
}

/** One page of results with card data (cached; listing changes expire the "search" tag). */
export async function searchListings(f: SearchFilters): Promise<SearchResult> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.search, tags.listings);
  const db = await getDb();
  const market = await loadSettings("market", db);
  const where = and(...searchConditions(f, market));
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(properties)
    .where(where);
  const total = count?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const c = f.commute;
  const ids = await db
    .select({
      id: properties.id,
      minutes: c ? sql<number | null>`${commuteMinutesSql(c)}` : sql<null>`null`,
      measured: c ? sql<boolean>`${commuteMeasuredSql(c)}` : sql<boolean>`false`,
    })
    .from(properties)
    .where(where)
    .orderBy(...orderBy(f, market), sql`${properties.id} desc`)
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const cards = await loadListingCards(
    db,
    ids.map((r) => r.id),
  );
  if (c) {
    const [place] = await db
      .select({ name: pois.name })
      .from(pois)
      .where(and(eq(pois.id, c.poi), eq(pois.agencyId, currentAgencyId())));
    const times = new Map(ids.map((r) => [r.id, r]));
    for (const card of cards) {
      const t = times.get(card.id);
      if (place && t?.minutes != null)
        card.commute = {
          minutes: Number(t.minutes),
          mode: c.mode,
          place: place.name,
          estimate: !t.measured,
        };
    }
  }
  return { total, page, pages, cards };
}

/**
 * Map pins for all results (up to 1,500). Listings without a public exact pin get a point
 * snapped to a ~500 m grid plus a small offset: the exact building never leaves the server.
 */
export async function searchPins(f: SearchFilters): Promise<SearchPin[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(tags.search, tags.listings);
  const db = await getDb();
  const market = await loadSettings("market", db);
  const rows = await db
    .select({
      id: properties.id,
      slug: properties.slug,
      lng: sql<number>`ST_X(${properties.point})`,
      lat: sql<number>`ST_Y(${properties.point})`,
      exact: properties.mapPinExact,
      price: properties.price,
      priceOnRequest: properties.priceOnRequest,
      currency: properties.currency,
      pricePeriod: properties.pricePeriod,
    })
    .from(properties)
    .where(and(...searchConditions(f, market), isNotNull(properties.point)))
    .orderBy(...orderBy(f, market), sql`${properties.id} desc`)
    .limit(1500);
  return rows.map((r) => {
    const shown = publicPoint(r.id, { lng: r.lng, lat: r.lat }, r.exact);
    return {
      id: r.id,
      slug: r.slug,
      lng: shown.lng,
      lat: shown.lat,
      approx: shown.approx,
      price: r.priceOnRequest ? null : r.price,
      currency: r.currency ?? market.baseCurrency.code,
      pricePeriod: r.pricePeriod,
    };
  });
}
