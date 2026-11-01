import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { badges, locations, poiTypes, pois, propertyTypes } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { projects } from "@/db/schema/projects";
import { properties, propertyBadges, propertyMedia, propertyPois } from "@/db/schema/properties";
import { mediaUrl } from "@/features/media/queries";

/**
 * What a listing card shows (06 §4.4), shared by search, the home page, similar homes and the
 * project, agent and account pages. Plain data (cacheable); prices stay in the listing's
 * currency and are converted for the visitor when rendered.
 */
export type ListingCardData = {
  id: string;
  slug: string;
  reference: string;
  title: string;
  purpose: "sale" | "rent";
  status: string;
  completion: "ready" | "off_plan";
  price: number | null;
  currency: string;
  priceOnRequest: boolean;
  pricePeriod: "year" | "month" | null;
  beds: number | null;
  baths: number | null;
  /** m² */
  size: number | null;
  typeName: string | null;
  locationName: string | null;
  /** Up to 5 photos, the cover first. */
  photos: Array<{
    url: string;
    alt: string;
    color: string | null;
    width: number | null;
    height: number | null;
  }>;
  badges: Array<{ name: string; color: string; textColor: string }>;
  /** When it was last verified (ISO), shown as "Verified 3 days ago". */
  verifiedAt: string | null;
  /** The closest school or transport stop that is shown on the listing. */
  nearby: {
    name: string;
    typeName: string;
    distanceM: number;
    seconds: number | null;
    mode: "drive" | "walk";
  } | null;
  /** Off-plan: "Q3 2027" or a date (ISO). */
  handover: string | null;
  projectName: string | null;
  isFeatured: boolean;
  /** With a commute filter (11 §9): minutes to the chosen place, measured or estimated. */
  commute?: { minutes: number; mode: "drive" | "walk"; place: string; estimate: boolean };
};

/** Cards for these listing ids, in the order given. Unpublished or archived ones are left out. */
export async function loadListingCards(db: DbOrTx, ids: string[]): Promise<ListingCardData[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({
      id: properties.id,
      slug: properties.slug,
      reference: properties.reference,
      title: properties.title,
      purpose: properties.purpose,
      status: properties.status,
      completion: properties.completion,
      price: properties.price,
      currency: properties.currency,
      priceOnRequest: properties.priceOnRequest,
      pricePeriod: properties.pricePeriod,
      beds: properties.beds,
      baths: properties.baths,
      size: properties.size,
      isVerified: properties.isVerified,
      lastVerifiedAt: properties.lastVerifiedAt,
      handoverDate: properties.handoverDate,
      handoverText: properties.handoverText,
      isFeatured: properties.isFeatured,
      typeName: propertyTypes.name,
      locationName: locations.name,
      projectName: projects.name,
      projectHandoverDate: projects.handoverDate,
      projectHandoverText: projects.handoverText,
    })
    .from(properties)
    .leftJoin(propertyTypes, eq(propertyTypes.id, properties.propertyTypeId))
    .leftJoin(locations, eq(locations.id, properties.locationId))
    .leftJoin(projects, eq(projects.id, properties.projectId))
    .where(and(inArray(properties.id, unique), isNull(properties.deletedAt)));

  const photoRows = await db
    .select({
      propertyId: propertyMedia.propertyId,
      isCover: propertyMedia.isCover,
      sortOrder: propertyMedia.sortOrder,
      alt: propertyMedia.alt,
      key: media.r2Key,
      libraryAlt: media.alt,
      color: media.dominantColor,
      width: media.width,
      height: media.height,
    })
    .from(propertyMedia)
    .innerJoin(media, eq(media.id, propertyMedia.mediaId))
    .where(
      and(
        inArray(propertyMedia.propertyId, unique),
        eq(propertyMedia.kind, "photo"),
        eq(media.status, "ready"),
      ),
    )
    .orderBy(
      asc(propertyMedia.propertyId),
      sql`${propertyMedia.isCover} desc`,
      asc(propertyMedia.sortOrder),
    );

  const badgeRows = await db
    .select({
      propertyId: propertyBadges.propertyId,
      name: badges.name,
      color: badges.color,
      textColor: badges.textColor,
      sortOrder: badges.sortOrder,
    })
    .from(propertyBadges)
    .innerJoin(badges, eq(badges.id, propertyBadges.badgeId))
    .where(
      and(
        inArray(propertyBadges.propertyId, unique),
        sql`(${propertyBadges.expiresAt} is null or ${propertyBadges.expiresAt} > now())`,
      ),
    )
    .orderBy(asc(badges.sortOrder), asc(badges.name));

  const nearbyRows = await db
    .selectDistinctOn([propertyPois.propertyId], {
      propertyId: propertyPois.propertyId,
      name: pois.name,
      typeName: poiTypes.name,
      distanceM: propertyPois.straightDistanceM,
      driveSeconds: propertyPois.driveSeconds,
      walkSeconds: propertyPois.walkSeconds,
      mode: poiTypes.travelMode,
    })
    .from(propertyPois)
    .innerJoin(pois, eq(pois.id, propertyPois.poiId))
    .innerJoin(poiTypes, eq(poiTypes.id, pois.poiTypeId))
    .where(
      and(
        inArray(propertyPois.propertyId, unique),
        eq(propertyPois.isShown, true),
        inArray(poiTypes.category, ["schools", "transport"]),
      ),
    )
    .orderBy(propertyPois.propertyId, asc(propertyPois.straightDistanceM));

  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const near = nearbyRows.find((n) => n.propertyId === id);
    const seconds = near ? (near.mode === "walk" ? near.walkSeconds : near.driveSeconds) : null;
    return [
      {
        id: r.id,
        slug: r.slug,
        reference: r.reference,
        title: r.title,
        purpose: r.purpose,
        status: r.status,
        completion: r.completion,
        price: r.priceOnRequest ? null : r.price,
        currency: r.currency ?? "",
        priceOnRequest: r.priceOnRequest || r.price == null,
        pricePeriod: r.pricePeriod,
        beds: r.beds,
        baths: r.baths,
        size: r.size,
        typeName: r.typeName,
        locationName: r.locationName,
        photos: photoRows
          .filter((p) => p.propertyId === id)
          .slice(0, 5)
          .map((p) => ({
            url: mediaUrl(p.key),
            alt: p.alt || p.libraryAlt || "",
            color: p.color,
            width: p.width,
            height: p.height,
          })),
        badges: badgeRows
          .filter((b) => b.propertyId === id)
          .map((b) => ({ name: b.name, color: b.color, textColor: b.textColor })),
        verifiedAt: r.isVerified && r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
        nearby: near
          ? {
              name: near.name,
              typeName: near.typeName,
              distanceM: near.distanceM,
              seconds,
              mode: near.mode,
            }
          : null,
        handover:
          r.completion === "off_plan"
            ? r.handoverText ||
              r.handoverDate ||
              r.projectHandoverText ||
              r.projectHandoverDate ||
              null
            : null,
        projectName: r.projectName,
        isFeatured: r.isFeatured,
      },
    ];
  });
}
