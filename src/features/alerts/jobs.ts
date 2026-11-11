import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { users } from "@/db/schema/auth";
import { savedHomes } from "@/db/schema/customer";
import { properties } from "@/db/schema/properties";
import { currencyFormats, formatFor } from "@/features/properties/format";
import { searchableStatuses, statusLabels } from "@/features/properties/status";
import { loadSettings } from "@/features/settings/queries";
import { defineJob } from "@/jobs/types";
import { formatMoney } from "@/lib/money";
import { alertSearches, newMatches, savedHomesLike, searchesMatching } from "./match";
import { sendHomeAlert, sendSearchAlert } from "./send";

async function listingFor(db: Db, propertyId: string) {
  const [row] = await db
    .select({
      id: properties.id,
      slug: properties.slug,
      title: properties.title,
      status: properties.status,
      publishedAt: properties.publishedAt,
      deletedAt: properties.deletedAt,
    })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.agencyId, currentAgencyId())));
  return row && !row.deletedAt && row.publishedAt ? row : null;
}

/** People who saved this listing (active accounts only). */
async function saversOf(db: Db, propertyId: string) {
  return db
    .select({
      savedHomeId: savedHomes.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
    })
    .from(savedHomes)
    .innerJoin(users, eq(users.id, savedHomes.userId))
    .where(and(eq(savedHomes.propertyId, propertyId), eq(users.isActive, true)));
}

const isSearchable = (status: string) => (searchableStatuses as readonly string[]).includes(status);

/**
 * A listing went live (first publish, or back from off market): instant searches it matches
 * get an alert within minutes, together with any other new matches not sent yet (12 §3).
 */
export async function alertNewListing(db: Db, propertyId: string, now = new Date()) {
  const listing = await listingFor(db, propertyId);
  if (!listing || !isSearchable(listing.status)) return { skipped: "not live" };
  const searches = await alertSearches(db, ["instant"]);
  const matched = await searchesMatching(db, propertyId, searches);
  let sent = 0;
  const told = new Set<string>();
  for (const search of searches.filter((s) => matched.has(s.id))) {
    const since = search.lastSentAt ?? search.createdAt;
    const others = await newMatches(db, search, since);
    // Their search tells them (now, or did already): no second email about the same listing.
    told.add(search.userId);
    if (await sendSearchAlert(db, search, [propertyId, ...others], "instant", now)) sent++;
  }
  // People who saved a home like this one hear about it too, once, unless a search tells them.
  const similar = await alertSimilarHomes(db, listing, told, now);
  return { matched: matched.size, sent, similar };
}

async function alertSimilarHomes(
  db: Db,
  listing: NonNullable<Awaited<ReturnType<typeof listingFor>>>,
  told: Set<string>,
  now: Date,
) {
  const saves = await savedHomesLike(db, listing.id);
  if (saves.length === 0) return 0;
  const [row] = await db
    .select({ price: properties.price, currency: properties.currency })
    .from(properties)
    .where(eq(properties.id, listing.id));
  const market = await loadSettings("market", db);
  const fmt = formatFor(row!.currency ?? "", currencyFormats(market));
  const price = row!.price == null ? "" : formatMoney(row!.price, fmt);
  let sent = 0;
  for (const s of saves) {
    if (told.has(s.userId)) continue;
    told.add(s.userId);
    const ok = await sendHomeAlert(db, {
      to: s,
      savedHomeId: s.savedHomeId,
      propertyId: listing.id,
      kind: "similar_home",
      detail: "",
      note: `Like ${s.savedTitle}`,
      vars: { title: listing.title, saved: s.savedTitle, price },
      path: `/property/${listing.slug}`,
      now,
    });
    if (ok) sent++;
  }
  return sent;
}

/** Daily (06:00 agency time) and weekly (Monday 06:00) digests of new matches. */
export async function runAlertDigest(db: Db, frequency: "daily" | "weekly", now = new Date()) {
  const searches = await alertSearches(db, [frequency]);
  let sent = 0;
  for (const search of searches) {
    const ids = await newMatches(db, search, search.lastSentAt ?? search.createdAt);
    if (await sendSearchAlert(db, search, ids, frequency, now)) sent++;
  }
  return { searches: searches.length, sent };
}

/**
 * A listing's price went down: everyone who saved it, then instant searches it matches (for
 * other people), hear "Price dropped by AED 50,000" — once per new price.
 */
export async function alertPriceDrop(
  db: Db,
  input: { propertyId: string; oldPrice: number; newPrice: number; currency: string },
  now = new Date(),
) {
  const listing = await listingFor(db, input.propertyId);
  if (!listing || !isSearchable(listing.status) || input.newPrice >= input.oldPrice)
    return { skipped: "not a live price drop" };
  const market = await loadSettings("market", db);
  const fmt = formatFor(input.currency, currencyFormats(market));
  const drop = formatMoney(input.oldPrice - input.newPrice, fmt);
  const common = {
    propertyId: listing.id,
    kind: "price_drop" as const,
    detail: String(input.newPrice),
    note: `Price dropped by ${drop}`,
    vars: { title: listing.title, price: formatMoney(input.newPrice, fmt), drop },
    path: `/property/${listing.slug}`,
    now,
  };
  const told = new Set<string>();
  let sent = 0;
  for (const s of await saversOf(db, listing.id)) {
    if (told.has(s.userId)) continue;
    told.add(s.userId);
    if (await sendHomeAlert(db, { ...common, to: s, savedHomeId: s.savedHomeId })) sent++;
  }
  const searches = (await alertSearches(db, ["instant"])).filter((s) => !told.has(s.userId));
  const matched = await searchesMatching(db, listing.id, searches);
  for (const search of searches.filter((s) => matched.has(s.id))) {
    if (told.has(search.userId)) continue;
    told.add(search.userId);
    if (await sendHomeAlert(db, { ...common, to: search, savedSearchId: search.id })) sent++;
  }
  return { sent };
}

const changeStatuses = ["reserved", "sold", "rented"] as const;

/** A saved home was reserved, sold or rented: the people who saved it hear once per status. */
export async function alertStatusChange(
  db: Db,
  input: { propertyId: string; status: (typeof changeStatuses)[number] },
  now = new Date(),
) {
  const listing = await listingFor(db, input.propertyId);
  if (!listing || listing.status !== input.status) return { skipped: "status changed again" };
  const label = statusLabels[input.status].toLowerCase();
  let sent = 0;
  const told = new Set<string>();
  for (const s of await saversOf(db, listing.id)) {
    if (told.has(s.userId)) continue;
    told.add(s.userId);
    const ok = await sendHomeAlert(db, {
      to: s,
      savedHomeId: s.savedHomeId,
      propertyId: listing.id,
      kind: "status_change",
      detail: input.status,
      note: `Now ${label}`,
      vars: { title: listing.title, status: label },
      path: `/property/${listing.slug}`,
      now,
    });
    if (ok) sent++;
  }
  return { sent };
}

export const alertsNewListingJob = defineJob({
  name: "alerts.new_listing",
  payload: z.object({ propertyId: z.uuid() }),
  maxAttempts: 5,
  run: ({ propertyId }, { db }) => alertNewListing(db, propertyId),
});

export const alertsPriceDropJob = defineJob({
  name: "alerts.price_drop",
  payload: z.object({
    propertyId: z.uuid(),
    oldPrice: z.number().int().nonnegative(),
    newPrice: z.number().int().nonnegative(),
    currency: z.string().min(1).max(8),
  }),
  maxAttempts: 5,
  run: (payload, { db }) => alertPriceDrop(db, payload),
});

export const alertsStatusChangeJob = defineJob({
  name: "alerts.status_change",
  payload: z.object({ propertyId: z.uuid(), status: z.enum(changeStatuses) }),
  maxAttempts: 5,
  run: (payload, { db }) => alertStatusChange(db, payload),
});
