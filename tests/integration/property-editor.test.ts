import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { agents } from "@/db/schema/people";
import { badges, facilities, locations, propertyTypes } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { paymentPlans } from "@/db/schema/payment-plans";
import { priceHistory, properties, propertyBadges } from "@/db/schema/properties";
import { seoRedirects } from "@/db/schema/seo";
import { jobRuns } from "@/db/schema/system";
import { builtInTemplates, planFromTemplate } from "@/features/payment-plans/templates";
import { createProperty } from "@/features/properties/actions";
import { saveProperty, setPropertyStatus } from "@/features/properties/editor-actions";
import { loadProperty } from "@/features/properties/load";
import type { PropertyInput } from "@/features/properties/schema";
import { newId } from "@/lib/ids";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const doc = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
});

async function setup() {
  const db = await getDb();
  const ids = {
    type: newId(),
    land: newId(),
    city: newId(),
    area: newId(),
    agent: newId(),
    retired: newId(),
    photo: newId(),
    pdf: newId(),
    pool: newId(),
    gym: newId(),
    hot: newId(),
    reduced: newId(),
  };
  await db.insert(propertyTypes).values([
    { id: ids.type, name: "Apartment", slug: "apartments" },
    {
      id: ids.land,
      name: "Plot",
      slug: "plots",
      category: "land",
      fieldsHidden: ["beds", "baths"],
    },
  ]);
  await db.insert(locations).values([
    { id: ids.city, level: "city", name: "Coastal City", slug: "coastal-city" },
    { id: ids.area, parentId: ids.city, level: "area", name: "Old Harbour", slug: "old-harbour" },
  ]);
  await db.insert(agents).values([
    { id: ids.agent, name: "Omar", slug: "omar" },
    { id: ids.retired, name: "Lina", slug: "lina", isActive: false },
  ]);
  await db.insert(media).values([
    {
      id: ids.photo,
      r2Key: "2026/10/aaaaaaaaaa/front.jpg",
      fileName: "front.jpg",
      mime: "image/jpeg",
      status: "ready",
    },
    {
      id: ids.pdf,
      r2Key: "2026/10/bbbbbbbbbb/plan.pdf",
      fileName: "plan.pdf",
      mime: "application/pdf",
      status: "ready",
    },
  ]);
  await db.insert(facilities).values([
    { id: ids.pool, name: "Pool" },
    { id: ids.gym, name: "Gym" },
  ]);
  await db.insert(badges).values([
    { id: ids.hot, name: "Hot deal" },
    { id: ids.reduced, name: "Price reduced", autoRule: "price_reduced", autoDays: 30 },
  ]);
  const res = await createProperty({
    purpose: "sale",
    completion: "ready",
    propertyTypeId: ids.type,
    title: "Harbour loft",
  });
  if (!res.ok) throw new Error(res.error);
  const loaded = (await loadProperty(db, res.data.id))!;
  return {
    db,
    ids,
    id: res.data.id,
    input: loaded.input,
    version: loaded.row.updatedAt.toISOString(),
  };
}

function complete(
  input: PropertyInput,
  ids: Awaited<ReturnType<typeof setup>>["ids"],
): PropertyInput {
  return {
    ...input,
    locationId: ids.area,
    point: { lng: 55.27, lat: 25.2 },
    price: 150_000_000,
    beds: 1,
    baths: 1,
    size: 75.5,
    agentId: ids.agent,
    description: doc("A loft by the old harbour."),
    media: [
      { mediaId: ids.photo, kind: "photo", isCover: false, caption: "", alt: "Front of the loft" },
    ],
  };
}

describe("property editor", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    await truncate(
      "properties",
      "property_media",
      "property_facilities",
      "property_badges",
      "price_history",
      "payment_plans",
      "payment_plan_steps",
      "seo_redirects",
      "badges",
      "facilities",
      "media",
      "agents",
      "locations",
      "property_types",
      "audit_log",
      "settings",
      "job_runs",
    );
  });

  it("dropping or moving the pin queues the nearby places measurement once", async () => {
    const { db, id, input, version } = await setup();
    const jobs = () =>
      db
        .select({ name: jobRuns.name, status: jobRuns.status })
        .from(jobRuns)
        .where(eq(jobRuns.dedupeKey, `poi.compute:${id}`));
    const a = await saveProperty({
      id,
      data: { ...input, title: "No pin yet" },
      expectedUpdatedAt: version,
    });
    expect(await jobs()).toEqual([]);
    const b = await saveProperty({
      id,
      data: { ...input, point: { lng: 55.27, lat: 25.2 } },
      expectedUpdatedAt: a.ok ? a.data.updatedAt : "",
    });
    expect(await jobs()).toEqual([{ name: "poi.compute", status: "queued" }]);
    // Moved again while the first run still waits: the waiting run covers it.
    await saveProperty({
      id,
      data: { ...input, point: { lng: 55.28, lat: 25.21 } },
      expectedUpdatedAt: b.ok ? b.data.updatedAt : "",
    });
    expect(await jobs()).toHaveLength(1);
  });

  it("saves every section and loads it back the same", async () => {
    const { db, ids, id, input, version } = await setup();
    const data: PropertyInput = {
      ...complete(input, ids),
      buildingName: "Pier Seven",
      addressLine: "7 Quay Road",
      unitNumber: "1204",
      floor: "12",
      mapPinExact: true,
      serviceChargePerArea: 1_850,
      agencyFeeText: "2% + VAT",
      plotSize: null,
      yearBuilt: 2019,
      parkingSpaces: 1,
      furnishing: "Furnished",
      ownership: "Freehold",
      view: ["Sea", "Marina"],
      maidRoom: false,
      study: true,
      expectedRentYearly: 9_000_000,
      isTenanted: true,
      tenancyEndDate: "2027-03-31",
      highlights: ["Sea view", "Walk to the metro"],
      videoUrl: "https://video.example/loft",
      tourUrl: null,
      media: [
        {
          mediaId: ids.photo,
          kind: "photo",
          isCover: true,
          caption: "Front",
          alt: "Front of the loft",
        },
        { mediaId: ids.pdf, kind: "floor_plan", isCover: false, caption: "", alt: "" },
      ],
      facilityIds: [ids.gym, ids.pool],
      badgeIds: [ids.hot],
      permitNumber: "P-7781",
      isVerified: true,
      lastVerifiedAt: "2026-10-01T09:00:00.000Z",
      isFeatured: true,
      featuredUntil: "2026-12-31",
      seoTitle: "Harbour loft with sea view",
      seoDescription: "One-bed loft in Pier Seven.",
    };
    const res = await saveProperty({ id, data, expectedUpdatedAt: version });
    expect(res).toMatchObject({ ok: true, data: { slug: "harbour-loft" } });
    const back = (await loadProperty(db, id))!;
    expect(back.input).toEqual({ ...data, facilityIds: back.input.facilityIds });
    expect([...back.input.facilityIds].sort()).toEqual([ids.gym, ids.pool].sort());
    expect(back.row.descriptionHtml).toBe("<p>A loft by the old harbour.</p>");
    expect(back.row.searchText).toBe("Old Harbour Coastal City Apartment");
    expect(back.row.expectedYield).toBe(6);
    expect(back.row.verifiedBy).toBe(testAdmin.id);
  });

  it("refuses a save based on an old version", async () => {
    const { id, input, version } = await setup();
    expect(
      await saveProperty({ id, data: { ...input, title: "First" }, expectedUpdatedAt: version }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await saveProperty({ id, data: { ...input, title: "Second" }, expectedUpdatedAt: version }),
    ).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("the slug follows the title until the listing is published, then redirects", async () => {
    const { db, ids, id, input, version } = await setup();
    const a = await saveProperty({
      id,
      data: { ...input, title: "Quay loft" },
      expectedUpdatedAt: version,
    });
    expect(a).toMatchObject({ ok: true, data: { slug: "quay-loft" } });
    const v1 = a.ok ? a.data.updatedAt : "";
    const data = { ...complete(input, ids), title: "Quay loft", slug: "quay-loft" };
    const b = await saveProperty({ id, data, expectedUpdatedAt: v1 });
    const published = await setPropertyStatus({ id, status: "available" });
    expect(published).toMatchObject({ ok: true, data: { firstPublish: true } });
    const [live] = await (await getDb()).select().from(properties).where(eq(properties.id, id));
    expect(live!.wentLiveAt).toEqual(live!.publishedAt);
    const v2 = published.ok ? published.data.updatedAt : "";
    expect(b.ok).toBe(true);
    const c = await saveProperty({
      id,
      data: { ...data, title: "Quay loft, renovated" },
      expectedUpdatedAt: v2,
    });
    expect(c).toMatchObject({ ok: true, data: { slug: "quay-loft" } });
    const v3 = c.ok ? c.data.updatedAt : "";
    await saveProperty({
      id,
      data: { ...data, title: "Quay loft, renovated", slug: "quay-loft-renovated" },
      expectedUpdatedAt: v3,
    });
    const redirects = await db.select().from(seoRedirects);
    expect(redirects.map((r) => [r.fromPath, r.toPath])).toEqual([
      ["/property/quay-loft", "/property/quay-loft-renovated"],
    ]);
  });

  it("a live listing keeps its required fields; price changes go to history and badges", async () => {
    const { db, ids, id, input, version } = await setup();
    const data = complete(input, ids);
    const saved = await saveProperty({ id, data, expectedUpdatedAt: version });
    expect(saved.ok).toBe(true);
    const live = await setPropertyStatus({ id, status: "available" });
    let v = live.ok ? live.data.updatedAt : "";

    const broken = await saveProperty({ id, data: { ...data, title: "" }, expectedUpdatedAt: v });
    expect(broken).toMatchObject({
      ok: false,
      code: "LIVE_RULES",
      fieldErrors: { title: ["Add a title."] },
    });

    const lower = await saveProperty({
      id,
      data: { ...data, price: 140_000_000 },
      expectedUpdatedAt: v,
    });
    expect(lower.ok).toBe(true);
    v = lower.ok ? lower.data.updatedAt : "";
    const history = await db.select().from(priceHistory).where(eq(priceHistory.propertyId, id));
    expect(history.map((h) => [h.oldPrice, h.newPrice])).toEqual([[150_000_000, 140_000_000]]);
    const [badge] = await db
      .select()
      .from(propertyBadges)
      .where(and(eq(propertyBadges.propertyId, id), eq(propertyBadges.badgeId, ids.reduced)));
    expect(badge).toMatchObject({ isAuto: true });
    expect(badge!.reason).toMatch(/^Price lowered /);

    // Back up to the original price: no longer reduced.
    await saveProperty({ id, data: { ...data, price: 150_000_000 }, expectedUpdatedAt: v });
    expect(
      await db
        .select()
        .from(propertyBadges)
        .where(and(eq(propertyBadges.propertyId, id), eq(propertyBadges.badgeId, ids.reduced))),
    ).toEqual([]);
  });

  it("publishing names what is missing; a plot needs no bedrooms", async () => {
    const { ids, id, input, version } = await setup();
    const refused = await setPropertyStatus({ id, status: "available" });
    expect(refused).toMatchObject({ ok: false, code: "PUBLISH_RULES" });
    expect(refused.ok ? {} : refused.fieldErrors).toMatchObject({
      locationId: ["Choose the location."],
      point: ["Drop the pin on the map."],
      media: ["Add at least one photo."],
    });
    const plot = { ...complete(input, ids), propertyTypeId: ids.land, beds: null, baths: null };
    expect(await saveProperty({ id, data: plot, expectedUpdatedAt: version })).toMatchObject({
      ok: true,
    });
    expect(await setPropertyStatus({ id, status: "available" })).toMatchObject({ ok: true });
    expect(await setPropertyStatus({ id, status: "draft" })).toMatchObject({
      ok: true,
      data: { firstPublish: false },
    });
  });

  it("keeps its own payment plan and removes it when switched off", async () => {
    const { db, ids, id, input, version } = await setup();
    const plan = planFromTemplate(builtInTemplates.find((t) => t.name === "60/40")!);
    const a = await saveProperty({
      id,
      data: { ...complete(input, ids), completion: "off_plan", paymentPlan: plan },
      expectedUpdatedAt: version,
    });
    expect(a.ok).toBe(true);
    const loaded = (await loadProperty(db, id))!;
    expect(loaded.input.paymentPlan!.steps.map((s) => s.percent)).toEqual([20, 40, 40]);
    const planId = loaded.row.paymentPlanId!;
    // Live with a plan: it must add up to 100%.
    await setPropertyStatus({ id, status: "available" });
    const v = (await loadProperty(db, id))!.row.updatedAt.toISOString();
    const short = { ...plan, steps: plan.steps.slice(0, 2) };
    expect(
      await saveProperty({
        id,
        data: { ...loaded.input, paymentPlan: short },
        expectedUpdatedAt: v,
      }),
    ).toMatchObject({ ok: false, code: "LIVE_RULES" });
    expect(
      await saveProperty({
        id,
        data: { ...loaded.input, paymentPlan: null },
        expectedUpdatedAt: v,
      }),
    ).toMatchObject({ ok: true });
    expect(await db.select().from(paymentPlans).where(eq(paymentPlans.id, planId))).toEqual([]);
  });

  it("checks what the input points at", async () => {
    const { ids, id, input, version } = await setup();
    const check = (patch: Partial<PropertyInput>) =>
      saveProperty({ id, data: { ...input, ...patch }, expectedUpdatedAt: version });
    expect(await check({ facilityIds: [newId()] })).toMatchObject({
      ok: false,
      fieldErrors: { facilityIds: ["Some facilities no longer exist. Reload the page."] },
    });
    expect(await check({ badgeIds: [ids.reduced] })).toMatchObject({
      ok: false,
      fieldErrors: { badgeIds: ["Automatic badges are added by the system."] },
    });
    expect(await check({ agentId: ids.retired })).toMatchObject({
      ok: false,
      fieldErrors: { agentId: ["This agent profile is turned off."] },
    });
    expect(
      await check({
        media: [{ mediaId: ids.pdf, kind: "photo", isCover: true, caption: "", alt: "" }],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { media: ["This file (application/pdf) cannot be used as a photo."] },
    });
    adminState.user = { ...testAdmin, readOnly: true };
    expect(await check({ title: "Read only" })).toMatchObject({ ok: false, code: "READ_ONLY" });
    const db = await getDb();
    const [row] = await db.select().from(properties).where(eq(properties.id, id));
    expect(row!.title).toBe("Harbour loft");
  });
});
