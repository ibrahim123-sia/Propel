import "server-only";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { users } from "@/db/schema/auth";
import { savedSearches, type alertFrequencies } from "@/db/schema/customer";
import { properties } from "@/db/schema/properties";
import { searchConditions } from "@/features/search/query";
import { loadSettings } from "@/features/settings/queries";
import { savedSearchFilters } from "./filters";

type Frequency = Exclude<(typeof alertFrequencies)[number], "off">;
type Market = Awaited<ReturnType<typeof loadSettings<"market">>>;

/** A saved search with what an alert needs about its owner. */
export type AlertSearch = {
  id: string;
  userId: string;
  name: string;
  filters: Record<string, unknown>;
  polygon: typeof savedSearches.$inferSelect.polygon;
  alertFrequency: (typeof alertFrequencies)[number];
  lastSentAt: Date | null;
  createdAt: Date;
  unsubscribeTokenHash: string | null;
  userName: string;
  email: string;
  phone: string | null;
};

const searchColumns = {
  id: savedSearches.id,
  userId: savedSearches.userId,
  name: savedSearches.name,
  filters: savedSearches.filters,
  polygon: savedSearches.polygon,
  alertFrequency: savedSearches.alertFrequency,
  lastSentAt: savedSearches.lastSentAt,
  createdAt: savedSearches.createdAt,
  unsubscribeTokenHash: savedSearches.unsubscribeTokenHash,
  userName: users.name,
  email: users.email,
  phone: users.phone,
};

/** Saved searches with these alert frequencies whose owners are still active. */
export async function alertSearches(
  db: DbOrTx,
  frequencies: readonly Frequency[],
): Promise<AlertSearch[]> {
  return db
    .select(searchColumns)
    .from(savedSearches)
    .innerJoin(users, eq(users.id, savedSearches.userId))
    .where(
      and(
        eq(savedSearches.agencyId, currentAgencyId()),
        inArray(savedSearches.alertFrequency, [...frequencies]),
        eq(users.isActive, true),
      ),
    );
}

/** The public search's conditions for one saved search (live, searchable listings only). */
function conditionsFor(search: Pick<AlertSearch, "filters" | "polygon">, market: Market) {
  return and(...searchConditions(savedSearchFilters(search.filters, search.polygon), market))!;
}

/**
 * Which of these searches the listing matches, in one round trip per 50 searches: each
 * search is an EXISTS test with exactly the conditions of the public search (base-currency
 * prices, drawn areas, sub-areas, live statuses).
 */
export async function searchesMatching(
  db: DbOrTx,
  propertyId: string,
  searches: readonly AlertSearch[],
): Promise<Set<string>> {
  const matched = new Set<string>();
  if (searches.length === 0) return matched;
  const market = await loadSettings("market", db);
  for (let i = 0; i < searches.length; i += 50) {
    const tests = searches.slice(i, i + 50).map(
      (s) =>
        sql`select ${s.id}::uuid as id where exists (
          select 1 from ${properties}
          where ${properties.id} = ${propertyId} and ${conditionsFor(s, market)})`,
    );
    const res = await db.execute<{ id: string }>(sql.join(tests, sql` union all `));
    for (const r of res.rows) matched.add(r.id);
  }
  return matched;
}

/**
 * Listings that match a search, went live after `since` and were never alerted for it,
 * newest first.
 */
export async function newMatches(
  db: DbOrTx,
  search: Pick<AlertSearch, "id" | "filters" | "polygon">,
  since: Date,
  limit = 50,
): Promise<string[]> {
  const market = await loadSettings("market", db);
  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .where(
      and(
        conditionsFor(search, market),
        // Listings that went live since, first publish or back on the market (decision 70).
        gt(sql`coalesce(${properties.wentLiveAt}, ${properties.publishedAt})`, since),
        sql`not exists (
          select 1 from alerts_sent a
          where a.saved_search_id = ${search.id} and a.property_id = ${properties.id}
            and a.kind = 'new_match')`,
      ),
    )
    .orderBy(
      desc(sql`coalesce(${properties.wentLiveAt}, ${properties.publishedAt})`),
      desc(properties.id),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}
