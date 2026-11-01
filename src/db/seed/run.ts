import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { pages } from "@/db/schema/cms";
import { seedInbox } from "./inbox";
import {
  badges,
  developers,
  facilities,
  locations,
  poiTypes,
  pois,
  propertyTypes,
} from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { agents } from "@/db/schema/people";
import { projectFacilities, projectMedia, projectUnitTypes, projects } from "@/db/schema/projects";
import {
  priceHistory,
  properties,
  propertyDailyStats,
  propertyFacilities,
  propertyMedia,
} from "@/db/schema/properties";
import { createOrPromoteAdmin, generatePassword } from "@/features/admin-users/create-admin";
import { publicKey } from "@/features/media/keys";
import { recountAllMediaUsage } from "@/features/media/usage";
import { writePlan } from "@/features/payment-plans/store";
import { builtInTemplates, planFromTemplate } from "@/features/payment-plans/templates";
import { computeProjectPois, computePropertyPois } from "@/features/pois/distances";
import { refreshAutoBadges } from "@/features/properties/badges";
import { nextPropertyReference } from "@/features/properties/reference";
import { searchTextFor } from "@/features/properties/save";
import { patchSettings } from "@/features/settings/mutations";
import { newId } from "@/lib/ids";
import { renderRichText, type RichDoc } from "@/lib/rich-text";
import { slugify } from "@/lib/slug";
import { getStorage } from "@/lib/storage";
import { areaToSqm, perAreaToSqm, type AreaUnit } from "@/lib/units";
import {
  bedroom,
  floorPlan,
  kitchen,
  livingRoom,
  logo,
  palettes,
  pool,
  portrait,
  tower,
  villa,
  type Picture,
} from "./images";
import { seedPages } from "./pages";
import { seedContent } from "./content";
import { seedCrm } from "./crm";
import { seedViewings } from "./viewings";
import { seedCustomers } from "./customers";
import { seedMenus } from "./menus";
import { seedNewsletter } from "./newsletter";
import { seedOwnerRequests, seedPriceStats } from "./owner-tools";
import { rng } from "./rng";
import type { ListingSpec, SeedPreset } from "./types";

const system = { type: "system", id: null } as const;
const DAY = 86_400_000;

/** Tables the demo data fills, children first (a reset empties them in this order). */
const resetOrder = [
  "quick_replies",
  "faqs",
  "area_guide_media",
  "area_guides",
  "post_tag_links",
  "post_tags",
  "posts",
  "post_categories",
  "testimonials",
  // CRM (children first; contacts are referenced by leads, viewings and conversations).
  "messages",
  "approval_queue",
  "conversations",
  "shortlists",
  "lead_tasks",
  "lead_events",
  "viewings",
  "valuation_requests",
  "listing_requests",
  "newsletter_subscribers",
  "visitor_events",
  "leads",
  "visitors",
  "contacts",
  "lead_stages",
  "area_price_stats",
  "property_daily_stats",
  "price_history",
  "property_pois",
  "property_badges",
  "property_facilities",
  "property_media",
  "properties",
  "project_pois",
  "project_unit_types",
  "project_media",
  "project_facilities",
  "projects",
  "payment_plans",
  "developers",
  "agents",
  "pois",
  "poi_types",
  "badges",
  "facilities",
  "property_types",
  "locations",
  "seo_redirects",
  "saved_views",
  "menus",
  "page_revisions",
  "pages",
  "media",
];

export type SeedResult = {
  admins: Array<{ email: string; password: string; readOnly: boolean }>;
  /** Demo customers for the site's account area (16 §1). */
  customers: Array<{ email: string; password: string }>;
  counts: Record<string, number>;
};

async function storePicture(
  db: Db,
  pic: Picture,
  meta: { fileName: string; alt: string; folder: string },
): Promise<string> {
  const ext = pic.mime === "image/png" ? "png" : "jpg";
  const key = publicKey(meta.fileName, ext);
  await (await getStorage()).put(key, pic.bytes, pic.mime);
  const [row] = await db
    .insert(media)
    .values({
      r2Key: key,
      fileName: `${meta.fileName}.${ext}`,
      mime: pic.mime,
      kind: "image",
      status: "ready",
      sizeBytes: pic.bytes.byteLength,
      width: pic.width,
      height: pic.height,
      alt: meta.alt,
      folder: meta.folder,
      dominantColor: pic.color,
    })
    .returning({ id: media.id });
  return row!.id;
}

const doc = (blocks: Array<{ h?: string; p?: string; list?: string[] }>): RichDoc => ({
  type: "doc",
  content: blocks.map((b) =>
    b.h
      ? {
          type: "heading" as const,
          attrs: { level: 2 as const },
          content: [{ type: "text" as const, text: b.h }],
        }
      : b.list
        ? {
            type: "bulletList" as const,
            content: b.list.map((item) => ({
              type: "listItem" as const,
              content: [
                { type: "paragraph" as const, content: [{ type: "text" as const, text: item }] },
              ],
            })),
          }
        : { type: "paragraph" as const, content: [{ type: "text" as const, text: b.p! }] },
  ),
});

function listingDescription(
  title: string,
  area: { name: string; description: string },
  building: string | null,
  facilityNames: string[],
): RichDoc {
  return doc([
    { h: "The home" },
    {
      p: `${title}. The rooms are laid out so the living space gets the most light, with a separate dining area and a kitchen that works for everyday cooking and for having friends over. Storage is generous and the bedrooms are set away from the living room for quiet.`,
    },
    { h: building ? `${building} and the area` : "The area" },
    {
      p: `${area.description} ${building ? `${building} is managed by a professional team, with maintenance on call and a lobby that is staffed day and night.` : "The street is quiet and close to everyday shops."} Schools, supermarkets and the main roads are a short drive away; the nearby places below show the distances we measured.`,
    },
    {
      list: facilityNames.slice(0, 4).length
        ? facilityNames.slice(0, 4)
        : ["Close to shops and cafes"],
    },
    {
      p: "We visited and checked this home in person. Ask us for the floor plan, service charges and the latest viewing times, or book a tour and we will show you around.",
    },
  ]);
}

/**
 * Seeds a preset (16 §1). `reset` empties the demo tables first; without it the database must
 * have no listings yet. Deterministic: the same preset gives the same data.
 */
export async function seedPreset(
  db: Db,
  preset: SeedPreset,
  options: {
    reset?: boolean;
    passwords?: Record<string, string>;
    now?: Date;
    /** Progress lines for the CLI ("Listings 12/40"). */
    onProgress?: (step: string) => void;
  } = {},
): Promise<SeedResult> {
  const now = options.now ?? new Date();
  const progress = options.onProgress ?? (() => undefined);
  const r = rng(20261020);
  if (options.reset) {
    for (const table of resetOrder) await db.execute(sql.raw(`delete from "${table}"`));
  } else {
    const [{ n }] = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from properties`)
    ).rows as [{ n: number }];
    if (n > 0)
      throw new Error(
        "This database already has listings. Run the seed with --reset to replace them.",
      );
  }

  // Settings ------------------------------------------------------------------------------
  progress("Settings");
  const agencyLogo = await storePicture(db, await logo(preset.agencyName, preset.logoColor), {
    fileName: `${slugify(preset.agencyName)}-logo`,
    alt: `${preset.agencyName} logo`,
    folder: "brand",
  });
  await patchSettings(
    db,
    "general",
    { ...preset.settings.general, logoLightId: agencyLogo },
    system,
  );
  await patchSettings(db, "market", preset.settings.market, system);
  await patchSettings(db, "contact", preset.settings.contact, system);
  await patchSettings(db, "seo", { ...preset.settings.seo, defaultOgImageId: null }, system);
  // Demo only: two-step verification off so the demo logins work (16 §1 "2FA off for demo only").
  await patchSettings(db, "security", { require2fa: false }, system);
  const areaUnit = (preset.settings.market.areaUnit ?? "sqm") as AreaUnit;
  const decimals = preset.settings.market.baseCurrency?.decimals ?? 2;
  const currency = preset.settings.market.baseCurrency?.code ?? "USD";
  const minor = (major: number) => Math.round(major * 10 ** decimals);
  // Listing habits follow the preset's market settings (16 §2 "same code, only settings").
  const market = preset.settings.market;
  const rentPeriod = market.rentPeriod ?? "month";
  const rentOptions = (market.rentPaymentOptions ?? []).filter((n) => n <= 4).slice(0, 3);
  const permits = market.permit?.enabled ?? false;
  const ownership = market.ownershipTypes?.[0] ?? null;
  const furnishings = market.furnishingOptions ?? ["Unfurnished", "Furnished"];
  const habits = preset.listingDefaults;
  const shapeOf = new Map(
    preset.propertyTypes.map((t) => [
      t.key,
      t.shape ??
        ({ villa: "house", townhouse: "house", office: "commercial", shop: "shop", plot: "plot" }[
          t.key
        ] as "house" | "commercial" | "shop" | "plot" | undefined) ??
        "apartment",
    ]),
  );

  // Admins --------------------------------------------------------------------------------
  progress("Admins");
  const admins: SeedResult["admins"] = [];
  for (const a of preset.admins) {
    const password = options.passwords?.[a.email] ?? generatePassword();
    await createOrPromoteAdmin(db, {
      email: a.email,
      name: a.name,
      password,
      readOnly: a.readOnly ?? false,
    });
    admins.push({ email: a.email, password, readOnly: a.readOnly ?? false });
  }

  // Master data ---------------------------------------------------------------------------
  progress("Master data");
  const typeIds = new Map<string, string>();
  for (const [i, t] of preset.propertyTypes.entries()) {
    const id = newId();
    typeIds.set(t.key, id);
    await db.insert(propertyTypes).values({
      id,
      name: t.name,
      slug: t.slug,
      category: t.category,
      icon: t.icon,
      fieldsHidden: t.hidden,
      sortOrder: i,
    });
  }
  const locIds = new Map<string, string>();
  const locByKey = new Map(preset.locations.map((l) => [l.key, l]));
  for (const [i, l] of preset.locations.entries()) {
    const id = newId();
    locIds.set(l.key, id);
    const [lng, lat] = l.center;
    const [dx, dy] = l.span;
    await db.insert(locations).values({
      id,
      parentId: l.parent ? locIds.get(l.parent)! : null,
      level: l.level,
      name: l.name,
      slug: l.slug,
      center: { lng, lat },
      geom: {
        type: "Polygon",
        coordinates: [
          [
            [lng - dx, lat - dy],
            [lng + dx, lat - dy],
            [lng + dx, lat + dy],
            [lng - dx, lat + dy],
            [lng - dx, lat - dy],
          ],
        ],
      },
      description: l.description,
      isFeatured: l.featured ?? false,
      sortOrder: i,
    });
  }
  const poiTypeIds = new Map<string, string>();
  for (const [i, t] of preset.poiTypes.entries()) {
    const id = newId();
    poiTypeIds.set(t.key, id);
    await db.insert(poiTypes).values({
      id,
      name: t.name,
      icon: t.icon,
      category: t.category,
      googlePlaceType: t.googlePlaceType,
      defaultSearchRadiusM: t.radius,
      showOnProperty: true,
      travelMode: t.mode,
      sortOrder: i,
    });
  }
  for (const p of preset.pois)
    await db.insert(pois).values({
      poiTypeId: poiTypeIds.get(p.type)!,
      name: p.name,
      address: p.address,
      point: { lng: p.point[0], lat: p.point[1] },
      isActive: true,
    });
  const facilityIds: Array<{ id: string; name: string; group: string }> = [];
  for (const [i, f] of preset.facilities.entries()) {
    const id = newId();
    facilityIds.push({ id, name: f.name, group: f.group });
    await db
      .insert(facilities)
      .values({ id, name: f.name, icon: f.icon, group: f.group, sortOrder: i });
  }
  for (const [i, b] of preset.badges.entries())
    await db.insert(badges).values({ ...b, sortOrder: i });

  // Pictures ------------------------------------------------------------------------------
  progress("Pictures");
  type Shot = { id: string; kind: "living" | "bedroom" | "kitchen" | "tower" | "villa" | "pool" };
  const shots: Shot[] = [];
  const alts: Record<Shot["kind"], string> = {
    living: "Living room with floor-to-ceiling windows",
    bedroom: "Bedroom with a large window",
    kitchen: "Fitted kitchen",
    tower: "Building exterior",
    villa: "Villa with garden and pool",
    pool: "Swimming pool",
  };
  for (const [i, p] of palettes.entries()) {
    const set: Array<[Shot["kind"], Promise<Picture>]> = [
      ["living", livingRoom(p, i * 11 + 3)],
      ["bedroom", bedroom(p, i * 7 + 5)],
      ["kitchen", kitchen(p)],
      ["tower", tower(p, i * 13 + 1)],
      ["villa", villa(p, i * 3 + 2)],
      ["pool", pool(p)],
    ];
    for (const [kind, pic] of set) {
      const id = await storePicture(db, await pic, {
        fileName: `${kind}-${i + 1}`,
        alt: alts[kind],
        folder: "listings",
      });
      shots.push({ id, kind });
    }
  }
  const plans = new Map<number, string>();
  for (const beds of [1, 2, 3, 4])
    plans.set(
      beds,
      await storePicture(db, await floorPlan(beds), {
        fileName: `floor-plan-${beds}-bed`,
        alt: `Floor plan, ${beds} bedroom${beds === 1 ? "" : "s"}`,
        folder: "listings/plans",
      }),
    );
  const ofKind = (kind: Shot["kind"]) => shots.filter((s) => s.kind === kind).map((s) => s.id);

  // Agents --------------------------------------------------------------------------------
  progress("Agents");
  const agentIds: Array<{ id: string; areas: string[] }> = [];
  for (const [i, a] of preset.agents.entries()) {
    const initials = a.name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2);
    const photoId = await storePicture(db, await portrait(initials, a.color), {
      fileName: a.slug,
      alt: a.name,
      folder: "agents",
    });
    const id = newId();
    agentIds.push({ id, areas: a.areas });
    await db.insert(agents).values({
      id,
      name: a.name,
      slug: a.slug,
      title: a.title,
      photoId,
      phone: preset.settings.contact.phone ?? null,
      whatsapp: preset.settings.contact.whatsapp || null,
      email: `${a.slug.split("-")[0]}@${(preset.settings.contact.email ?? "agency.example").split("@")[1]}`,
      languages: a.languages,
      areas: a.areas.map((k) => locIds.get(k)!),
      bio: a.bio,
      isActive: true,
      sortOrder: i,
      replyTimeText: "Usually replies in a few minutes",
    });
  }
  const agentFor = (area: string) =>
    (agentIds.find((a) => a.areas.includes(area)) ?? agentIds[0]!).id;

  // Developers and projects ---------------------------------------------------------------
  progress("Developers and projects");
  const devIds = new Map<string, string>();
  for (const [i, d] of preset.developers.entries()) {
    const logoId = await storePicture(db, await logo(d.name, d.color), {
      fileName: `${d.slug}-logo`,
      alt: `${d.name} logo`,
      folder: "developers",
    });
    const id = newId();
    devIds.set(d.key, id);
    await db.insert(developers).values({
      id,
      name: d.name,
      slug: d.slug,
      logoId,
      description: d.description,
      website: d.website,
      establishedYear: d.year,
      sortOrder: i,
    });
  }
  const projectRows = new Map<
    string,
    {
      id: string;
      units: Map<string, { id: string; priceFrom: number }>;
      spec: SeedPreset["projects"][number];
    }
  >();
  for (const p of preset.projects) {
    const template =
      typeof p.plan === "string"
        ? (builtInTemplates.find((t) => t.key === p.plan) ?? builtInTemplates[1]!)
        : p.plan;
    const planId = await db.transaction((tx) =>
      writePlan(tx, {
        id: null,
        input: planFromTemplate(template),
        isTemplate: false,
        actor: system,
        userId: null,
      }),
    );
    const description = doc([
      ...p.description.map((text) => ({ p: text })),
      { list: p.highlights },
    ]);
    const id = newId();
    const minFrom = Math.min(...p.units.map((u) => u.priceFrom));
    await db.insert(projects).values({
      id,
      developerId: devIds.get(p.developer)!,
      name: p.name,
      slug: p.slug,
      locationId: locIds.get(p.location)!,
      point: { lng: p.point[0], lat: p.point[1] },
      status: p.status,
      launchDate: p.launch,
      handoverDate: p.handover,
      handoverText: p.handoverText,
      constructionProgress: p.progress,
      progressUpdatedAt: new Date(now.getTime() - 12 * DAY),
      startingPrice: minor(minFrom),
      currency,
      unitTypesSummary: p.units.map((u) => u.name).join(", "),
      totalUnits: p.units.reduce((n, u) => n + u.available, 0) + 40,
      description,
      descriptionHtml: renderRichText(description),
      highlights: p.highlights,
      paymentPlanId: planId,
      isFeatured: p.featured,
      isPublished: true,
      publishedAt: new Date(now.getTime() - 60 * DAY),
    });
    const gallery = r.some(
      p.units[0]!.beds >= 4
        ? [...ofKind("villa"), ...ofKind("pool")]
        : [...ofKind("tower"), ...ofKind("pool"), ...ofKind("living")],
      5,
      6,
    );
    for (const [i, mediaId] of gallery.entries())
      await db
        .insert(projectMedia)
        .values({ projectId: id, mediaId, kind: "photo", sortOrder: i, isCover: i === 0 });
    for (const f of r.some(
      facilityIds.filter((x) => x.group !== "unit"),
      4,
      7,
    ))
      await db.insert(projectFacilities).values({ projectId: id, facilityId: f.id });
    const units = new Map<string, { id: string; priceFrom: number }>();
    for (const [i, u] of p.units.entries()) {
      const unitId = newId();
      units.set(u.name, { id: unitId, priceFrom: u.priceFrom });
      await db.insert(projectUnitTypes).values({
        id: unitId,
        projectId: id,
        name: u.name,
        beds: u.beds,
        baths: u.baths,
        sizeMin: areaToSqm(u.sizeMin, areaUnit),
        sizeMax: areaToSqm(u.sizeMax, areaUnit),
        priceFrom: minor(u.priceFrom),
        floorPlanId: plans.get(Math.min(Math.max(u.beds, 1), 4)) ?? null,
        availableCount: u.available,
        sortOrder: i,
      });
    }
    projectRows.set(p.key, { id, units, spec: p });
  }

  // Listings ------------------------------------------------------------------------------
  progress("Listings");
  const listingIds: string[] = [];
  for (const [index, spec] of preset.listings.entries()) {
    const id = await seedListing(db, spec, index);
    listingIds.push(id);
    if ((index + 1) % 10 === 0 || index + 1 === preset.listings.length)
      progress(`Listings ${index + 1}/${preset.listings.length}`);
  }

  async function seedListing(dbc: Db, spec: ListingSpec, index: number): Promise<string> {
    const [purpose, typeKey, locKey, beds, baths, sizeUnit, priceMajor, title, extras] = spec;
    const loc = locByKey.get(locKey)!;
    const project = extras.project ? projectRows.get(extras.project)! : null;
    const unit = project && extras.unit ? project.units.get(extras.unit)! : null;
    const base = project ? project.spec.point : loc.center;
    const point = {
      lng: Number((base[0] + (r.next() - 0.5) * loc.span[0] * 1.1).toFixed(6)),
      lat: Number((base[1] + (r.next() - 0.5) * loc.span[1] * 1.1).toFixed(6)),
    };
    const price = minor(priceMajor ?? unit?.priceFrom ?? 0);
    const reducedFrom = extras.reducedFrom ? minor(extras.reducedFrom) : null;
    const publishedAt = new Date(
      now.getTime() - (index % 7 === 0 ? 4 : 18 + ((index * 7) % 70)) * DAY,
    );
    const verifiedDaysAgo = extras.stale
      ? 60 + ((index * 13) % 70)
      : index % 6 === 5
        ? null
        : 1 + ((index * 5) % 18);
    const shape = shapeOf.get(typeKey) ?? "apartment";
    const villaLike = shape === "house";
    const commercial = shape === "commercial" || shape === "shop";
    const plot = shape === "plot";
    const kinds: Array<Shot["kind"]> = plot
      ? ["villa", "pool"]
      : villaLike
        ? ["villa", "living", "bedroom", "kitchen", "pool"]
        : commercial
          ? ["tower", "living"]
          : ["tower", "living", "bedroom", "kitchen", "pool"];
    const photoIds = r.some(
      shots.filter((s) => kinds.includes(s.kind)).map((s) => s.id),
      plot ? 6 : 6,
      plot ? 7 : 12,
    );
    const facilityPick = plot ? [] : r.some(facilityIds, 5, 9);
    const description = listingDescription(
      title,
      loc,
      extras.building ?? null,
      facilityPick.map((f) => f.name),
    );
    const status = extras.status ?? "available";

    return dbc.transaction(async (tx) => {
      const reference = await nextPropertyReference(tx);
      const [row] = await tx
        .insert(properties)
        .values({
          reference,
          title,
          slug: slugify(`${title}-${reference}`),
          purpose,
          status,
          completion: project ? "off_plan" : "ready",
          propertyTypeId: typeIds.get(typeKey)!,
          locationId: locIds.get(locKey)!,
          projectId: project?.id ?? null,
          projectUnitTypeId: unit?.id ?? null,
          buildingName: extras.building ?? project?.spec.name ?? null,
          addressLine: extras.address
            ? `${extras.address}, ${loc.name}`
            : `${extras.building ?? project?.spec.name ?? loc.name}, ${loc.name}`,
          unitNumber: plot ? null : String(100 + index * 7),
          floor: villaLike || plot ? null : String(2 + (index % 30)),
          point,
          mapPinExact: !villaLike && index % 2 === 0,
          price,
          currency,
          pricePeriod: purpose === "rent" ? rentPeriod : null,
          originalPrice: reducedFrom ?? price,
          serviceChargePerArea:
            commercial || plot || !habits.serviceCharge
              ? null
              : Math.round(
                  perAreaToSqm(
                    minor(habits.serviceCharge[0] + (index % habits.serviceCharge[1])),
                    areaUnit,
                  ),
                ),
          rentPaymentOptions: purpose === "rent" ? rentOptions : [],
          monthlyPaymentAvailable:
            purpose === "rent" && (market.monthlyPaymentAvailable ?? false) && index % 3 === 0,
          depositAmount: purpose === "rent" ? Math.round(price * habits.depositShare) : null,
          agencyFeeText: purpose === "rent" ? habits.agencyFeeRent : habits.agencyFeeSale,
          beds: plot || commercial ? null : beds,
          baths: plot ? null : baths,
          size: areaToSqm(sizeUnit, areaUnit),
          plotSize: villaLike
            ? areaToSqm(Math.round(sizeUnit * 1.6), areaUnit)
            : plot
              ? areaToSqm(sizeUnit, areaUnit)
              : null,
          yearBuilt: project ? null : 2008 + (index % 16),
          parkingSpaces: plot ? null : villaLike ? 2 : 1,
          furnishing: plot || shape === "shop" ? null : r.pick(furnishings),
          ownership,
          view: habits.views[locKey] ?? [],
          floorCount: villaLike ? 2 : null,
          maidRoom: habits.maidRooms && (beds ?? 0) >= 3,
          study: (beds ?? 0) >= 4,
          handoverDate: project ? project.spec.handover : null,
          handoverText: project ? project.spec.handoverText : null,
          constructionProgress: project ? project.spec.progress : null,
          expectedRentYearly:
            purpose === "sale" && !project && typeKey !== "plot" ? Math.round(price * 0.064) : null,
          description,
          descriptionHtml: renderRichText(description),
          highlights: facilityPick.slice(0, 3).map((f) => f.name),
          permitNumber: permits ? `${71000000 + index * 137}` : null,
          isVerified: verifiedDaysAgo !== null,
          lastVerifiedAt:
            verifiedDaysAgo !== null ? new Date(now.getTime() - verifiedDaysAgo * DAY) : null,
          agentId: agentFor(locKey),
          isFeatured: extras.featured ?? false,
          publishedAt,
          source: "manual",
          searchText: await searchTextFor(tx, {
            locationId: locIds.get(locKey)!,
            projectId: project?.id ?? null,
            propertyTypeId: typeIds.get(typeKey)!,
          }),
          seoTitle: title,
          seoDescription: `${title} in ${loc.name}. ${loc.description}`.slice(0, 155),
          viewsCount: 0,
        })
        .returning({ id: properties.id });
      const propertyId = row!.id;
      for (const [i, mediaId] of photoIds.entries())
        await tx
          .insert(propertyMedia)
          .values({ propertyId, mediaId, kind: "photo", sortOrder: i, isCover: i === 0 });
      const planImage =
        beds != null && typeKey !== "plot" && !commercial && index % 5 !== 4
          ? plans.get(Math.min(Math.max(beds, 1), 4))
          : null;
      if (planImage)
        await tx
          .insert(propertyMedia)
          .values({ propertyId, mediaId: planImage, kind: "floor_plan", sortOrder: 0 });
      for (const f of facilityPick)
        await tx.insert(propertyFacilities).values({ propertyId, facilityId: f.id });
      if (reducedFrom) {
        await tx.insert(priceHistory).values({
          propertyId,
          oldPrice: reducedFrom,
          newPrice: price,
          currency,
          changedAt: new Date(now.getTime() - (3 + (index % 9)) * DAY),
        });
      }
      for (let d = 0; d < 30; d++) {
        const views = Math.max(
          0,
          Math.round(8 + r.next() * 30 * (extras.featured ? 1.8 : 1) - d * 0.2),
        );
        await tx.insert(propertyDailyStats).values({
          propertyId,
          date: new Date(now.getTime() - d * DAY).toISOString().slice(0, 10),
          views,
          saves: Math.round(views / 12),
          inquiries: r.next() < 0.12 ? 1 : 0,
          shares: r.next() < 0.08 ? 1 : 0,
          brochureDownloads: r.next() < 0.05 ? 1 : 0,
        });
      }
      return propertyId;
    });
  }

  // Home page (06 §3) from sections; the page builder (Phase 5) edits it.
  const heroImage = ofKind("villa")[0] ?? shots[0]!.id;
  await db.insert(pages).values({
    title: "Home",
    slug: "home",
    status: "published",
    isHome: true,
    template: "default",
    sections: [
      {
        id: "hero",
        type: "hero_search",
        props: {
          ...preset.home.hero,
          tabs: preset.home.tabs ?? ["buy", "rent", "off_plan"],
          defaultTab: "buy",
          imageId: heroImage,
          floatingBadge: true,
        },
        style: { background: "sand", spacing: "normal", width: "contained" },
      },
      {
        id: "promise",
        type: "promise_strip",
        props: { items: preset.home.promises },
        style: { background: "white", spacing: "compact" },
      },
      {
        id: "featured",
        type: "featured_listings",
        props: {
          ...preset.home.featured,
          source: "featured",
          count: 6,
          viewAll: { label: preset.home.featured.viewAllLabel, href: "/buy" },
        },
        style: { background: "sand" },
      },
      ...(preset.home.projects
        ? [
            {
              id: "projects",
              type: "projects_showcase",
              props: {
                ...preset.home.projects,
                source: "featured",
                count: 4,
                dark: true,
                viewAll: { label: preset.home.projects.viewAllLabel, href: "/projects" },
              },
              style: { background: "ink" },
            },
          ]
        : []),
      {
        id: "areas",
        type: "areas_grid",
        props: { ...preset.home.areas, source: "featured", count: 4 },
        style: { background: "sand" },
      },
    ].map((sec) => {
      const { viewAllLabel: _a, ...props } = sec.props as Record<string, unknown> & {
        viewAllLabel?: string;
      };
      return { ...sec, props };
    }),
    seoTitle: `${preset.agencyName}: homes for sale and rent`,
    seoDescription: preset.settings.seo.defaultMetaDescription ?? null,
  });

  progress("Pages");
  await seedPages(db, preset.pages, {
    images: {
      living: ofKind("living")[0],
      villa: ofKind("villa")[1] ?? ofKind("villa")[0],
      tower: ofKind("tower")[0],
    },
  });
  if (preset.content) {
    progress("Blog, area guides, FAQs and testimonials");
    await seedContent(db, preset.content, {
      now,
      store: (pic, meta) => storePicture(db, pic, meta),
      locationKeys: new Map(preset.locations.map((l) => [l.key, l.slug])),
    });
  }
  progress("Menus");
  await seedMenus(db, preset);

  progress("Badges and nearby places");
  await refreshAutoBadges(db, listingIds, now);
  for (const id of listingIds) await computePropertyPois(db, id, now);
  for (const p of projectRows.values()) await computeProjectPois(db, p.id, now);
  await recountAllMediaUsage(db);

  progress("Leads");
  await seedCrm(db, {
    now,
    agentIds: agentIds.map((a) => a.id),
    phone: preset.crm.phone,
    leads: preset.crm.leads,
  });
  // After the leads, so conversations join their open leads.
  progress("Inbox");
  await seedInbox(db, { now, inbox: preset.inbox });
  progress("Newsletter");
  await seedNewsletter(db, { now });
  progress("Viewings");
  await seedViewings(db, { now, timeZone: preset.settings.general.timeZone ?? "UTC" });
  progress("Valuations and price trends");
  await seedOwnerRequests(db);
  await seedPriceStats(db, { now });

  progress("Customers");
  const customers = await seedCustomers(db, {
    now,
    customers: preset.customers,
    passwords: options.passwords,
    generatePassword,
  });

  // 16 §2-3: which demo market is loaded, for "Switch demo market" and the nightly reset.
  await patchSettings(
    db,
    "demo",
    {
      preset: preset.key === "us-demo" ? "us-demo" : "haven-dune",
      requestedPreset: null,
      requestedAt: null,
      lastResetAt: now.toISOString(),
    },
    system,
  );

  const count = async (table: string) =>
    (
      (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`)))
        .rows[0] as { n: number }
    ).n;
  const counts: Record<string, number> = {};
  for (const t of [
    "locations",
    "pois",
    "agents",
    "developers",
    "projects",
    "properties",
    "media",
    "property_pois",
    "property_badges",
    "newsletter_subscribers",
    "pages",
    "conversations",
    "posts",
    "area_guides",
    "faqs",
    "testimonials",
    "contacts",
    "leads",
    "lead_events",
    "viewings",
    "menus",
    "saved_homes",
    "saved_searches",
    "valuation_requests",
    "listing_requests",
    "area_price_stats",
  ])
    counts[t] = await count(t);
  return { admins, customers, counts };
}
