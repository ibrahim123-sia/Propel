import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  badges,
  facilities,
  locations,
  poiTypes,
  pois,
  propertyTypes,
} from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { paymentPlanSteps, paymentPlans } from "@/db/schema/payment-plans";
import { projects } from "@/db/schema/projects";
import {
  properties,
  propertyBadges,
  propertyFacilities,
  propertyPois,
} from "@/db/schema/properties";
import { encodePolygon, parseSearch } from "@/features/search/params";
import { searchListings, searchPins } from "@/features/search/query";
import { patchSettings } from "@/features/settings/mutations";
import { newId } from "@/lib/ids";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
let n = 0;

async function world() {
  const db = await getDb();
  await patchSettings(
    db,
    "market",
    {
      areaUnit: "sqm",
      baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
      visitorCurrencies: [
        {
          code: "USD",
          symbol: "$",
          symbolPosition: "before",
          decimals: 2,
          rate: 0.25,
          isExample: true,
        },
      ],
    },
    actor,
  );
  const ids = {
    apt: newId(),
    villa: newId(),
    city: newId(),
    marina: newId(),
    tower: newId(),
    hills: newId(),
    agent: newId(),
    pool: newId(),
    gym: newId(),
    hot: newId(),
    project: newId(),
    plan: newId(),
  };
  await db.insert(propertyTypes).values([
    { id: ids.apt, name: "Apartment", slug: "apartments" },
    { id: ids.villa, name: "Villa", slug: "villas" },
  ]);
  await db.insert(locations).values([
    { id: ids.city, level: "city", name: "Dubai", slug: "dubai" },
    {
      id: ids.marina,
      parentId: ids.city,
      level: "area",
      name: "Dubai Marina",
      slug: "dubai-marina",
    },
    {
      id: ids.tower,
      parentId: ids.marina,
      level: "building",
      name: "Marina Gate",
      slug: "marina-gate",
    },
    { id: ids.hills, parentId: ids.city, level: "area", name: "Dubai Hills", slug: "dubai-hills" },
  ]);
  await db.insert(agents).values({ id: ids.agent, name: "Sara", slug: "sara" });
  await db.insert(facilities).values([
    { id: ids.pool, name: "Pool" },
    { id: ids.gym, name: "Gym" },
  ]);
  await db.insert(badges).values({ id: ids.hot, name: "Hot deal" });
  await db.insert(paymentPlans).values({ id: ids.plan, name: "70/30" });
  await db.insert(paymentPlanSteps).values([
    { paymentPlanId: ids.plan, stage: "booking", label: "Down", percent: 70 },
    { paymentPlanId: ids.plan, stage: "post_handover", label: "After", percent: 30 },
  ]);
  await db.insert(projects).values({
    id: ids.project,
    name: "The Linden",
    slug: "the-linden",
    locationId: ids.hills,
    handoverDate: "2027-09-30",
    paymentPlanId: ids.plan,
  });
  return { db, ids };
}

type Listing = Partial<typeof properties.$inferInsert>;
async function listing(db: Awaited<ReturnType<typeof getDb>>, values: Listing) {
  const id = newId();
  n++;
  await db.insert(properties).values({
    id,
    reference: `LT-${5000 + n}`,
    title: `Listing ${n}`,
    slug: `listing-${n}-${id.slice(-6)}`,
    purpose: "sale",
    status: "available",
    publishedAt: new Date(Date.UTC(2026, 9, n)),
    currency: "AED",
    ...values,
  });
  return id;
}

describe("public search", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    await truncate(
      "properties",
      "property_pois",
      "pois",
      "poi_types",
      "property_facilities",
      "property_badges",
      "projects",
      "payment_plans",
      "payment_plan_steps",
      "badges",
      "facilities",
      "agents",
      "locations",
      "property_types",
      "settings",
      "audit_log",
    );
  });

  it("shows only live listings of the purpose, and areas include what is inside them", async () => {
    const { db, ids } = await world();
    const inTower = await listing(db, { locationId: ids.tower, propertyTypeId: ids.apt });
    const inHills = await listing(db, { locationId: ids.hills, propertyTypeId: ids.villa });
    await listing(db, { locationId: ids.tower, status: "draft", publishedAt: null });
    await listing(db, { locationId: ids.tower, status: "sold" });
    await listing(db, { locationId: ids.tower, deletedAt: new Date() });
    await listing(db, { locationId: ids.tower, purpose: "rent" });
    const ids_ = async (sp: Record<string, string | string[]>) =>
      (await searchListings(parseSearch(sp))).cards.map((c) => c.id);
    expect((await ids_({})).sort()).toEqual([inTower, inHills].sort());
    expect(await ids_({ loc: "dubai-marina" })).toEqual([inTower]);
    expect((await ids_({ loc: "dubai" })).sort()).toEqual([inTower, inHills].sort());
    expect(await ids_({ type: "villas" })).toEqual([inHills]);
  });

  it("compares prices in the base currency, also for listings in another currency", async () => {
    const { db } = await world();
    const aed = await listing(db, { price: 200_000_000 }); // AED 2,000,000
    const usd = await listing(db, { price: 60_000_000, currency: "USD" }); // $600,000 = AED 2.4M
    await listing(db, { price: null, priceOnRequest: true });
    const run = async (sp: Record<string, string>) =>
      (await searchListings(parseSearch(sp))).cards.map((c) => c.id);
    expect(await run({ min: "2100000" })).toEqual([usd]);
    expect(await run({ max: "2100000" })).toEqual([aed]);
    expect(await run({ sort: "price_asc", min: "1" })).toEqual([aed, usd]);
    expect(await run({ sort: "price_desc", min: "1" })).toEqual([usd, aed]);
  });

  it("filters specs, facilities, badges, plans, handover, payments and keywords", async () => {
    const { db, ids } = await world();
    const studio = await listing(db, { beds: 0, baths: 1, size: 40, title: "Cosy studio" });
    const big = await listing(db, { beds: 6, baths: 5, size: 600, title: "Garden mansion" });
    const offPlan = await listing(db, {
      beds: 2,
      completion: "off_plan",
      projectId: ids.project,
      title: "Linden two bed",
    });
    const rent = await listing(db, { purpose: "rent", beds: 1, rentPaymentOptions: [1, 4] });
    await db.insert(propertyFacilities).values([
      { propertyId: big, facilityId: ids.pool },
      { propertyId: big, facilityId: ids.gym },
      { propertyId: studio, facilityId: ids.pool },
    ]);
    await db.insert(propertyBadges).values({ propertyId: studio, badgeId: ids.hot });
    const run = async (sp: Record<string, string | string[]>) =>
      (await searchListings(parseSearch(sp))).cards.map((c) => c.id).sort();
    expect(await run({ beds: "studio" })).toEqual([studio]);
    expect(await run({ beds: "5" })).toEqual([big]);
    expect(await run({ baths: "4" })).toEqual([big]);
    expect(await run({ smin: "100" })).toEqual([big]);
    expect(await run({ fac: [ids.pool, ids.gym] })).toEqual([big]);
    expect(await run({ fac: ids.pool })).toEqual([studio, big].sort());
    expect(await run({ badge: ids.hot })).toEqual([studio]);
    expect(await run({ plan: "post_handover" })).toEqual([offPlan]);
    expect(await run({ handover: "2027" })).toEqual([offPlan]);
    expect(await run({ handover: "2027-Q2" })).toEqual([]);
    expect(await run({ loc: "p.the-linden" })).toEqual([offPlan]);
    expect(await run({ completion: "off_plan" })).toEqual([offPlan]);
    expect(await run({ purpose: "rent", cheques: "4" })).toEqual([rent]);
    expect(await run({ purpose: "rent", cheques: "2" })).toEqual([]);
    expect(await run({ q: "mansion" })).toEqual([big]);
    expect(await run({ q: "mansoin" })).toEqual([]);
    // Typo-tolerant on the whole title: one misspelt word of two still finds it.
    expect(await run({ q: "garden mansoin" })).toEqual([big]);
  });

  it("pages, and keeps exact pins private when the listing asks for it", async () => {
    const { db } = await world();
    for (let i = 0; i < 23; i++)
      await listing(db, { point: { lng: 55.14 + i / 1000, lat: 25.08 }, mapPinExact: true });
    const secret = await listing(db, {
      point: { lng: 55.123456, lat: 25.098765 },
      mapPinExact: false,
    });
    const page2 = await searchListings(parseSearch({ page: "2" }));
    expect(page2).toMatchObject({ total: 24, page: 2, pages: 2 });
    expect(page2.cards).toHaveLength(4);
    const pins = await searchPins(parseSearch({}));
    expect(pins).toHaveLength(24);
    const pin = pins.find((p) => p.id === secret)!;
    expect(pin.approx).toBe(true);
    expect([pin.lng, pin.lat]).not.toEqual([55.123456, 25.098765]);
    expect(Math.abs(pin.lng - 55.123456)).toBeLessThan(0.006);
    expect(Math.abs(pin.lat - 25.098765)).toBeLessThan(0.006);
    expect(pins.filter((p) => !p.approx)).toHaveLength(23);
  });

  it("drawn areas and commute times return the right homes (11 §8, §9)", async () => {
    const { db } = await world();
    const type = newId();
    const mall = newId();
    await db.insert(poiTypes).values({ id: type, name: "Mall", category: "shopping" });
    const at = { lng: 55.14, lat: 25.08 };
    await db.insert(pois).values({ id: mall, poiTypeId: type, name: "Marina Mall", point: at });
    // ~200 m away with a measured 10-minute drive and 15-minute walk; ~3 km away, never
    // measured; ~20 km away.
    const near = await listing(db, { point: { lng: at.lng + 0.002, lat: at.lat } });
    const mid = await listing(db, { point: { lng: at.lng + 0.03, lat: at.lat } });
    const far = await listing(db, { point: { lng: at.lng + 0.2, lat: at.lat } });
    await db.insert(propertyPois).values({
      propertyId: near,
      poiId: mall,
      straightDistanceM: 200,
      driveSeconds: 600,
      walkSeconds: 900,
    });
    const ids = async (sp: Record<string, string>) =>
      (await searchListings(parseSearch(sp))).cards.map((c) => c.id).sort();

    // A drawn area around the first two homes only.
    const ring: Array<[number, number]> = [
      [at.lng - 0.01, at.lat - 0.01],
      [at.lng + 0.05, at.lat - 0.01],
      [at.lng + 0.05, at.lat + 0.01],
      [at.lng - 0.01, at.lat + 0.01],
    ];
    expect(await ids({ poly: encodePolygon(ring) })).toEqual([near, mid].sort());

    // 3 km by car is about 9 minutes (estimate); the measured 10 minutes counts as measured.
    const res = await searchListings(parseSearch({ commute: `${mall}.drive.10` }));
    expect(res.cards.map((c) => c.id).sort()).toEqual([near, mid].sort());
    expect(res.cards.find((c) => c.id === near)!.commute).toEqual({
      minutes: 10,
      mode: "drive",
      place: "Marina Mall",
      estimate: false,
    });
    expect(res.cards.find((c) => c.id === mid)!.commute).toMatchObject({
      minutes: 9,
      estimate: true,
    });
    expect(await ids({ commute: `${mall}.drive.60` })).toEqual([near, mid, far].sort());
    // On foot: only the measured 15-minute walk is within 15 minutes.
    expect(await ids({ commute: `${mall}.walk.15` })).toEqual([near]);
    // An inactive place matches nothing; a malformed one is ignored.
    await db.update(pois).set({ isActive: false }).where(eq(pois.id, mall));
    expect(await ids({ commute: `${mall}.drive.60` })).toEqual([]);
    expect(parseSearch({ commute: `${mall}.drive.7` }).commute).toBeNull();
  });
});
