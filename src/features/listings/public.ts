import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import {
  badges,
  developers,
  facilities,
  poiTypes,
  pois,
  propertyTypes,
  type HideableField,
  type PoiCategory,
} from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import {
  priceHistory,
  properties,
  propertyBadges,
  propertyFacilities,
  propertyMedia,
  propertyPois,
} from "@/db/schema/properties";
import { mediaUrl } from "@/features/media/queries";
import { isPlanComplete, type PlanStep } from "@/features/payment-plans/schema";
import { loadPlan } from "@/features/payment-plans/store";
import { liveStatuses } from "@/features/properties/status";
import { servedRedirect } from "@/features/seo/serve";
import { tags } from "@/lib/cache-tags";
import { richTextToPlain } from "@/lib/rich-text";
import { publicPoint, type PublicPoint } from "./public-point";

/**
 * Everything the public property page shows (06 §5), for live listings only (available,
 * reserved, under offer, sold, rented). Never the unit number, and never the exact point when
 * the listing keeps its pin private.
 */
export type PublicListing = {
  id: string;
  slug: string;
  reference: string;
  title: string;
  purpose: "sale" | "rent";
  status: (typeof liveStatuses)[number];
  completion: "ready" | "off_plan";
  price: number | null;
  currency: string;
  pricePeriod: "year" | "month" | null;
  beds: number | null;
  baths: number | null;
  /** m² */
  size: number | null;
  plotSize: number | null;
  yearBuilt: number | null;
  floor: string | null;
  view: string[];
  parkingSpaces: number | null;
  furnishing: string | null;
  ownership: string | null;
  floorCount: number | null;
  maidRoom: boolean;
  study: boolean;
  /** Minor units per m² per year. */
  serviceChargePerArea: number | null;
  rentPaymentOptions: number[];
  monthlyPaymentAvailable: boolean;
  depositAmount: number | null;
  agencyFeeText: string | null;
  handover: string | null;
  constructionProgress: number | null;
  expectedRentYearly: number | null;
  isTenanted: boolean;
  descriptionHtml: string | null;
  descriptionText: string;
  highlights: string[];
  videoUrl: string | null;
  tourUrl: string | null;
  permitNumber: string | null;
  verifiedAt: string | null;
  addressLine: string | null;
  buildingName: string | null;
  type: { name: string; slug: string; hidden: HideableField[] } | null;
  /** From the top area down to the listing's location (country left out). */
  places: Array<{ id: string; name: string; slug: string; level: string }>;
  point: PublicPoint | null;
  photos: Array<{
    url: string;
    alt: string;
    caption: string | null;
    color: string | null;
    width: number | null;
    height: number | null;
  }>;
  floorPlans: Array<{ url: string; alt: string; caption: string | null; mime: string }>;
  brochure: { url: string; fileName: string } | null;
  facilities: Array<{ name: string; icon: string | null; group: string }>;
  badges: Array<{ name: string; color: string; textColor: string; icon: string | null }>;
  nearby: Array<{
    id: string;
    name: string;
    typeName: string;
    typeIcon: string | null;
    category: PoiCategory;
    mode: "drive" | "walk";
    distanceM: number;
    driveSeconds: number | null;
    driveDistanceM: number | null;
    walkSeconds: number | null;
    walkDistanceM: number | null;
    overrideText: string | null;
  }>;
  priceHistory: Array<{ at: string; oldPrice: number | null; newPrice: number | null }>;
  /** The listing's own plan, or its project's; only plans that add up to 100%. */
  plan: { steps: PlanStep[]; summaryLabel: string | null; notes: string | null } | null;
  project: {
    name: string;
    slug: string;
    published: boolean;
    developerName: string | null;
    progress: number | null;
    handover: string | null;
  } | null;
  agent: {
    name: string;
    slug: string;
    title: string | null;
    photoUrl: string | null;
    languages: string[];
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    replyTimeText: string | null;
  } | null;
  seo: {
    title: string | null;
    description: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
    /** The share image: the one chosen in the editor, else the cover photo. */
    ogImageUrl: string | null;
    /** Only the one chosen in the editor (otherwise the generated share card is used). */
    chosenOgImageUrl: string | null;
  };
  publishedAt: string | null;
  locationId: string | null;
};

const kindOrder = sql`array_position(array['photo','floor_plan','video','brochure','document']::text[], ${propertyMedia.kind})`;

/** Location ancestors, top first. */
async function placesFor(db: DbOrTx, locationId: string | null) {
  if (!locationId) return [];
  const res = await db.execute<{
    id: string;
    name: string;
    slug: string;
    level: string;
    depth: number;
  }>(sql`
    with recursive up as (
      select id, parent_id, name, slug, level, 0 as depth from locations where id = ${locationId}::uuid
      union all
      select l.id, l.parent_id, l.name, l.slug, l.level, up.depth + 1 from locations l join up on l.id = up.parent_id
    ) select id, name, slug, level, depth from up order by depth desc`);
  return res.rows
    .filter((r) => r.level !== "country")
    .map(({ id, name, slug, level }) => ({ id, name, slug, level }));
}

/** The public listing for a slug, or null (cached; editor saves expire `listing:<id>`). */
export async function getPublicListing(slug: string): Promise<PublicListing | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(tags.listings);
  const db = await getDb();
  const [row] = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, currentAgencyId()),
        eq(properties.slug, slug),
        isNull(properties.deletedAt),
        inArray(properties.status, [...liveStatuses]),
      ),
    )
    .limit(1);
  if (!row) return null;
  cacheTag(tags.listing(row.id));
  const id = row.id;

  const [type] = row.propertyTypeId
    ? await db
        .select({
          name: propertyTypes.name,
          slug: propertyTypes.slug,
          hidden: propertyTypes.fieldsHidden,
        })
        .from(propertyTypes)
        .where(eq(propertyTypes.id, row.propertyTypeId))
    : [];
  const places = await placesFor(db, row.locationId);

  const files = await db
    .select({
      kind: propertyMedia.kind,
      isCover: propertyMedia.isCover,
      caption: propertyMedia.caption,
      alt: propertyMedia.alt,
      key: media.r2Key,
      libraryAlt: media.alt,
      fileName: media.fileName,
      mime: media.mime,
      color: media.dominantColor,
      width: media.width,
      height: media.height,
    })
    .from(propertyMedia)
    .innerJoin(media, eq(media.id, propertyMedia.mediaId))
    .where(and(eq(propertyMedia.propertyId, id), eq(media.status, "ready")))
    .orderBy(kindOrder, sql`${propertyMedia.isCover} desc`, asc(propertyMedia.sortOrder));

  const facilityRows = await db
    .select({ name: facilities.name, icon: facilities.icon, group: facilities.group })
    .from(propertyFacilities)
    .innerJoin(facilities, eq(facilities.id, propertyFacilities.facilityId))
    .where(eq(propertyFacilities.propertyId, id))
    .orderBy(asc(facilities.group), asc(facilities.sortOrder), asc(facilities.name));

  const badgeRows = await db
    .select({
      name: badges.name,
      color: badges.color,
      textColor: badges.textColor,
      icon: badges.icon,
    })
    .from(propertyBadges)
    .innerJoin(badges, eq(badges.id, propertyBadges.badgeId))
    .where(
      and(
        eq(propertyBadges.propertyId, id),
        sql`(${propertyBadges.expiresAt} is null or ${propertyBadges.expiresAt} > now())`,
      ),
    )
    .orderBy(asc(badges.sortOrder), asc(badges.name));

  const nearbyRows = await db
    .select({
      id: propertyPois.id,
      name: pois.name,
      typeName: poiTypes.name,
      typeIcon: poiTypes.icon,
      category: poiTypes.category,
      mode: poiTypes.travelMode,
      distanceM: propertyPois.straightDistanceM,
      driveSeconds: propertyPois.driveSeconds,
      driveDistanceM: propertyPois.driveDistanceM,
      walkSeconds: propertyPois.walkSeconds,
      walkDistanceM: propertyPois.walkDistanceM,
      overrideText: propertyPois.overrideText,
      isManualOverride: propertyPois.isManualOverride,
    })
    .from(propertyPois)
    .innerJoin(pois, eq(pois.id, propertyPois.poiId))
    .innerJoin(poiTypes, eq(poiTypes.id, pois.poiTypeId))
    .where(
      and(
        eq(propertyPois.propertyId, id),
        eq(propertyPois.isShown, true),
        eq(poiTypes.showOnProperty, true),
      ),
    )
    .orderBy(
      asc(poiTypes.sortOrder),
      asc(propertyPois.sortOrder),
      asc(propertyPois.straightDistanceM),
    );

  const history = await db
    .select({
      at: priceHistory.changedAt,
      oldPrice: priceHistory.oldPrice,
      newPrice: priceHistory.newPrice,
    })
    .from(priceHistory)
    .where(eq(priceHistory.propertyId, id))
    .orderBy(asc(priceHistory.changedAt))
    .limit(30);

  let project: PublicListing["project"] = null;
  let projectPlanId: string | null = null;
  if (row.projectId) {
    const [p] = await db
      .select({
        name: projects.name,
        slug: projects.slug,
        isPublished: projects.isPublished,
        progress: projects.constructionProgress,
        handoverDate: projects.handoverDate,
        handoverText: projects.handoverText,
        paymentPlanId: projects.paymentPlanId,
        developerName: developers.name,
      })
      .from(projects)
      .leftJoin(developers, eq(developers.id, projects.developerId))
      .where(and(eq(projects.id, row.projectId), isNull(projects.deletedAt)));
    if (p) {
      cacheTag(tags.project(row.projectId));
      projectPlanId = p.paymentPlanId;
      project = {
        name: p.name,
        slug: p.slug,
        published: p.isPublished,
        developerName: p.developerName,
        progress: p.progress,
        handover: p.handoverText || p.handoverDate || null,
      };
    }
  }

  const planId = row.paymentPlanId ?? projectPlanId;
  const planRecord = planId ? await loadPlan(db, planId) : null;
  const plan =
    planRecord && isPlanComplete(planRecord.steps)
      ? { steps: planRecord.steps, summaryLabel: planRecord.summaryLabel, notes: planRecord.notes }
      : null;

  let agent: PublicListing["agent"] = null;
  if (row.agentId) {
    const [a] = await db
      .select({
        name: agents.name,
        slug: agents.slug,
        title: agents.title,
        photoKey: media.r2Key,
        photoStatus: media.status,
        languages: agents.languages,
        phone: agents.phone,
        whatsapp: agents.whatsapp,
        email: agents.email,
        replyTimeText: agents.replyTimeText,
        isActive: agents.isActive,
      })
      .from(agents)
      .leftJoin(media, eq(media.id, agents.photoId))
      .where(eq(agents.id, row.agentId));
    if (a?.isActive) {
      cacheTag(tags.agent(row.agentId));
      agent = {
        name: a.name,
        slug: a.slug,
        title: a.title,
        photoUrl: a.photoKey && a.photoStatus === "ready" ? mediaUrl(a.photoKey) : null,
        languages: a.languages,
        phone: a.phone,
        whatsapp: a.whatsapp,
        email: a.email,
        replyTimeText: a.replyTimeText,
      };
    }
  }

  let ogImageUrl: string | null = null;
  if (row.ogImageId) {
    const [og] = await db
      .select({ key: media.r2Key, status: media.status })
      .from(media)
      .where(eq(media.id, row.ogImageId));
    if (og?.status === "ready") ogImageUrl = mediaUrl(og.key);
  }

  const photos = files.filter((f) => f.kind === "photo");
  const brochure = files.find((f) => f.kind === "brochure" && f.mime === "application/pdf");
  return {
    id,
    slug: row.slug,
    reference: row.reference,
    title: row.title,
    purpose: row.purpose,
    status: row.status as PublicListing["status"],
    completion: row.completion,
    price: row.priceOnRequest ? null : row.price,
    currency: row.currency ?? "",
    pricePeriod: row.pricePeriod,
    beds: row.beds,
    baths: row.baths,
    size: row.size,
    plotSize: row.plotSize,
    yearBuilt: row.yearBuilt,
    floor: row.floor,
    view: row.view,
    parkingSpaces: row.parkingSpaces,
    furnishing: row.furnishing,
    ownership: row.ownership,
    floorCount: row.floorCount,
    maidRoom: row.maidRoom,
    study: row.study,
    serviceChargePerArea: row.serviceChargePerArea,
    rentPaymentOptions: row.rentPaymentOptions,
    monthlyPaymentAvailable: row.monthlyPaymentAvailable,
    depositAmount: row.depositAmount,
    agencyFeeText: row.agencyFeeText,
    handover:
      row.completion === "off_plan"
        ? row.handoverText || row.handoverDate || project?.handover || null
        : null,
    constructionProgress: row.constructionProgress ?? project?.progress ?? null,
    expectedRentYearly: row.expectedRentYearly,
    isTenanted: row.isTenanted,
    descriptionHtml: row.descriptionHtml,
    descriptionText: richTextToPlain(row.description).replace(/\s+/g, " ").trim(),
    highlights: row.highlights,
    videoUrl: row.videoUrl,
    tourUrl: row.tourUrl,
    permitNumber: row.permitNumber,
    verifiedAt: row.isVerified && row.lastVerifiedAt ? row.lastVerifiedAt.toISOString() : null,
    addressLine: row.addressLine,
    buildingName: row.buildingName,
    type: type ?? null,
    places,
    point: row.point ? publicPoint(id, row.point, row.mapPinExact) : null,
    photos: photos.map((f) => ({
      url: mediaUrl(f.key),
      alt: f.alt || f.libraryAlt || "",
      caption: f.caption,
      color: f.color,
      width: f.width,
      height: f.height,
    })),
    floorPlans: files
      .filter((f) => f.kind === "floor_plan")
      .map((f) => ({
        url: mediaUrl(f.key),
        alt: f.alt || f.libraryAlt || "",
        caption: f.caption,
        mime: f.mime,
      })),
    brochure: brochure ? { url: mediaUrl(brochure.key), fileName: brochure.fileName } : null,
    facilities: facilityRows,
    badges: badgeRows,
    nearby: nearbyRows.map(({ isManualOverride, overrideText, ...n }) => ({
      ...n,
      overrideText: isManualOverride && overrideText ? overrideText : null,
    })),
    priceHistory: history.map((h) => ({
      at: h.at.toISOString(),
      oldPrice: h.oldPrice,
      newPrice: h.newPrice,
    })),
    plan,
    project,
    agent,
    seo: {
      title: row.seoTitle,
      description: row.seoDescription,
      canonicalUrl: row.canonicalUrl,
      noindex: row.noindex,
      ogImageUrl: ogImageUrl ?? (photos[0] ? mediaUrl(photos[0].key) : null),
      chosenOgImageUrl: ogImageUrl,
    },
    publishedAt: row.publishedAt?.toISOString() ?? null,
    locationId: row.locationId,
  };
}

/**
 * Where an old listing address now lives (slug changes add 301s, 07 §3). Counts the hit for
 * the redirects manager. Not cached: it only runs when the slug is unknown.
 */
export async function listingRedirect(
  slug: string,
): Promise<{ to: string; permanent: boolean } | null> {
  return servedRedirect(`/property/${slug}`);
}
