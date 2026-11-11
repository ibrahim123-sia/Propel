import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "@/db/client";
import { leadEvents, leads, leadTasks, listingRequests, valuationRequests } from "@/db/schema/crm";
import { locations, propertyTypes } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { agents } from "@/db/schema/people";
import { properties } from "@/db/schema/properties";
import { emailLog } from "@/db/schema/system";
import { patchSettings } from "@/features/settings/mutations";
import { sendValuationRequest, startOwnerPhotoUpload } from "@/features/valuation/actions";
import {
  cleanupOwnerPhotos,
  OWNER_PHOTO_FOLDER,
  PhotoRefused,
  receiveOwnerPhoto,
} from "@/features/valuation/photos";
import { createDraftFromListingRequest } from "@/features/valuation/admin-actions";
import { loadOwnerRequests } from "@/features/valuation/admin";
import { listingRequestSchema } from "@/features/valuation/schema";
import { submitOwnerRequest } from "@/features/valuation/submit";
import { auditLog } from "@/db/schema/system";
import { runDueJobs } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { memoryStorage, setStorage } from "@/lib/storage";
import { setTurnstileVerifier } from "@/lib/turnstile";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const SQFT = 0.09290304;
const ids = { city: newId(), marina: newId(), gate: newId(), downtown: newId(), apt: newId() };
const agentId = newId();

async function drain() {
  for (let i = 0; i < 6; i++) if ((await runDueJobs()).ran === 0) break;
}

let ref = 1000;
async function listing(over: Partial<typeof properties.$inferInsert> = {}) {
  ref += 1;
  const id = newId();
  await (await getDb()).insert(properties).values({
    id,
    reference: `T-${ref}`,
    title: `Two-bed ${ref}`,
    slug: `two-bed-${ref}`,
    purpose: "sale",
    status: "available",
    propertyTypeId: ids.apt,
    locationId: ids.marina,
    beds: 2,
    size: 1200 * SQFT,
    price: 240_000_000,
    currency: "AED",
    publishedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  });
  return id;
}

const owner = {
  purpose: "sell" as const,
  locationId: ids.marina,
  building: "Marina Gate 1",
  propertyTypeId: ids.apt,
  beds: 2,
  baths: 2,
  size: 1180,
  condition: "good" as const,
  upgrades: ["kitchen" as const],
  name: "Rana Owner",
  email: "rana@example.com",
  phone: "050 123 4567",
  notes: "Vacant on transfer",
  consent: true as const,
  captchaToken: "good-token",
};

describe("owner tools: valuation and list your property", () => {
  beforeAll(() => setStorage(memoryStorage()));
  afterAll(() => setStorage(null));
  beforeEach(async () => {
    setTurnstileVerifier(async (token) => token === "good-token");
    await truncate(
      "properties",
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "valuation_requests",
      "listing_requests",
      "agents",
      "locations",
      "property_types",
      "media",
      "message_templates",
      "email_log",
      "job_runs",
      "rate_limits",
      "audit_log",
      "settings",
    );
    const db = await getDb();
    await patchSettings(
      db,
      "market",
      {
        areaUnit: "sqft",
        phoneCountryCode: "+971",
        rentPeriod: "year",
        baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
      },
      actor,
    );
    await patchSettings(
      db,
      "contact",
      { email: "hello@agency.example", leadNotifyEmails: [] },
      actor,
    );
    await patchSettings(db, "leads", { assignmentRule: "area_match" }, actor);
    await db.insert(propertyTypes).values({ id: ids.apt, name: "Apartment", slug: "apartments" });
    await db.insert(locations).values([
      { id: ids.city, level: "city", name: "Dubai", slug: "dubai" },
      { id: ids.marina, parentId: ids.city, level: "area", name: "Dubai Marina", slug: "marina" },
      { id: ids.gate, parentId: ids.marina, level: "building", name: "Marina Gate", slug: "gate" },
      { id: ids.downtown, parentId: ids.city, level: "area", name: "Downtown", slug: "downtown" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      name: "Layla Haddad",
      slug: "layla",
      email: "layla@agency.example",
      areas: [ids.marina],
    });
  });
  afterEach(() => setTurnstileVerifier(null));

  it("≥ 3 comparables: a range with the homes compared, a lead, a task and the emails", async () => {
    const db = await getDb();
    // Comparables: 2,000 · 2,100 · 2,200 · 2,300 AED per sq ft (one in a building inside the area).
    const used = [
      await listing({ price: 1200 * 200_000 }),
      await listing({ price: 1150 * 210_000, size: 1150 * SQFT, locationId: ids.gate }),
      await listing({ price: 1250 * 220_000, size: 1250 * SQFT, status: "sold" }),
      await listing({ price: 1100 * 230_000, size: 1100 * SQFT }),
    ];
    // Not comparable: another area, 3 beds, too big, a draft, a rental.
    await listing({ locationId: ids.downtown });
    await listing({ beds: 3 });
    await listing({ size: 1500 * SQFT });
    await listing({ status: "draft" });
    await listing({ purpose: "rent", price: 12_000_000 });

    const res = await sendValuationRequest(owner);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.data.estimate;
    expect(e?.status).toBe("estimate");
    if (e?.status !== "estimate") return;
    expect(e.comparables.map((c) => c.id).sort()).toEqual([...used].sort());
    // Quartiles 2,075 / 2,150 / 2,225 per sq ft × 1,180 sq ft, three significant figures.
    expect([e.low, e.mid, e.high]).toEqual([245_000_000, 254_000_000, 263_000_000]);
    expect(res.data).toMatchObject({ areaName: "Dubai Marina", agentName: "Layla" });

    const [request] = await db.select().from(valuationRequests);
    expect(request).toMatchObject({
      purpose: "sell",
      locationId: ids.marina,
      beds: 2,
      building: "Marina Gate 1",
      condition: "good",
      upgrades: ["kitchen"],
      aiRangeMin: 245_000_000,
      aiRangeMax: 263_000_000,
      currency: "AED",
    });
    expect(request!.size).toBeCloseTo(1180 * SQFT, 1);
    expect(request!.aiComparableIds.sort()).toEqual([...used].sort());
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({ source: "valuation", type: "seller", agentId });
    expect(lead!.requirements).toMatchObject({ purpose: "sale", locationIds: [ids.marina] });
    const [task] = await db.select().from(leadTasks);
    expect(task!.title).toContain("Refine the valuation");

    await drain();
    const mails = await db.select().from(emailLog);
    const toOwner = mails.filter((m) => m.to === "rana@example.com");
    expect(toOwner.map((m) => m.template)).toEqual(["valuation.received"]);
    expect(toOwner[0]!.text).toContain("AED 2,450,000 – AED 2,630,000");
    expect(toOwner[0]!.text).toContain("4 similar homes in Dubai Marina");
    const team = mails.filter((m) => m.to !== "rana@example.com");
    expect(team.map((m) => [m.template, m.to]).sort()).toEqual([
      ["valuation.new", "hello@agency.example"],
      ["valuation.new", "layla@agency.example"],
    ]);
    expect(team[0]!.text).toContain("Estimate: AED 2,450,000 – AED 2,630,000 (4 comparables)");
    // The generic new-lead email and auto-reply are replaced by these.
    expect(mails.some((m) => m.template === "lead.new" || m.template === "lead.auto_reply")).toBe(
      false,
    );
    const sent = await db.select().from(leadEvents).where(eq(leadEvents.type, "email_sent"));
    expect(sent).toHaveLength(1);
  });

  it("fewer than 3 comparables: no number, and a task for the agent at once", async () => {
    const db = await getDb();
    await listing();
    await listing();
    await listing({ beds: 3 });
    const res = await sendValuationRequest(owner);
    expect(res).toMatchObject({ ok: true, data: { estimate: { status: "not_enough_data" } } });
    const [request] = await db.select().from(valuationRequests);
    expect(request).toMatchObject({ aiRangeMin: null, aiRangeMax: null });
    // The two near matches are kept for the agent.
    expect(request!.aiComparableIds).toHaveLength(2);
    const [task] = await db.select().from(leadTasks);
    expect(task!.title).toContain("not enough comparables");
    expect(task!.dueAt!.getTime()).toBeLessThanOrEqual(Date.now());
    await drain();
    const [mail] = await db
      .select()
      .from(emailLog)
      .where(eq(emailLog.template, "valuation.received"));
    expect(mail!.text).toContain("quick look");
  });

  it("checks the fields, the type's bedrooms, the honeypot and Turnstile", async () => {
    const db = await getDb();
    expect(await sendValuationRequest({ ...owner, beds: null })).toMatchObject({
      ok: false,
      fieldErrors: { beds: [expect.any(String)] },
    });
    expect(await sendValuationRequest({ ...owner, email: "", phone: "" })).toMatchObject({
      ok: false,
      fieldErrors: { email: [expect.any(String)] },
    });
    expect(await sendValuationRequest({ ...owner, locationId: newId() })).toMatchObject({
      ok: false,
      fieldErrors: { locationId: [expect.any(String)] },
    });
    expect(await sendValuationRequest({ ...owner, captchaToken: "bad" })).toMatchObject({
      ok: false,
      code: "CAPTCHA",
    });
    expect(await sendValuationRequest({ ...owner, website: "spam.example" })).toMatchObject({
      ok: true,
    });
    expect(await db.select().from(leads)).toEqual([]);
  });

  it("photos: signed upload, metadata stripped by the media job, attached by receipt", async () => {
    const db = await getDb();
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c96442" } })
        .withExifMerge({ IFD0: { Copyright: "secret" } })
        .jpeg()
        .toBuffer(),
    );
    const start = await startOwnerPhotoUpload({ fileName: "living room.jpg", size: jpeg.length });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const token = new URL(start.data.uploadUrl, "http://x").searchParams.get("token");
    await expect(receiveOwnerPhoto(db, token, jpeg.slice(1))).rejects.toBeInstanceOf(PhotoRefused);
    const { receipt, id } = await receiveOwnerPhoto(db, token, jpeg);
    // Single use.
    await expect(receiveOwnerPhoto(db, token, jpeg)).rejects.toBeInstanceOf(PhotoRefused);
    await drain();
    const [row] = await db.select().from(media).where(eq(media.id, id));
    expect(row).toMatchObject({ status: "ready", folder: OWNER_PHOTO_FOLDER, width: 40 });

    // Not a photo: refused by its bytes, whatever the name says.
    const fake = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const bad = await startOwnerPhotoUpload({ fileName: "x.png", size: fake.length });
    if (!bad.ok) throw new Error(bad.error);
    const badToken = new URL(bad.data.uploadUrl, "http://x").searchParams.get("token");
    await expect(receiveOwnerPhoto(db, badToken, fake)).rejects.toMatchObject({ status: 415 });
    expect(await startOwnerPhotoUpload({ fileName: "x.pdf", size: 100 })).toMatchObject({
      ok: false,
    });

    const res = await sendValuationRequest({ ...owner, photos: [receipt, "forged.token"] });
    expect(res.ok).toBe(true);
    const [request] = await db.select().from(valuationRequests);
    expect(request!.photoIds).toEqual([id]);

    // A photo left behind is removed after a day; the attached one stays.
    const left = await startOwnerPhotoUpload({ fileName: "left.jpg", size: jpeg.length });
    if (!left.ok) throw new Error(left.error);
    const tomorrow = new Date(Date.now() + 25 * 3600_000);
    expect(await cleanupOwnerPhotos(db, tomorrow)).toEqual({ removed: 2 });
    expect((await db.select().from(media).where(eq(media.id, id))).length).toBe(1);
  });
  it("admin: a listing request becomes a draft listing in one click, once, audited", async () => {
    const db = await getDb();
    // Requests sent before the public form was removed (owners no longer list homes).
    await submitOwnerRequest(
      db,
      "listing",
      listingRequestSchema.parse({ ...owner, askingPrice: 2_400_000 }),
      { visitorKey: null },
    );
    const [request] = await db.select().from(listingRequests);
    const [lead] = await db.select().from(leads);
    const cards = await loadOwnerRequests(db, lead!.id);
    expect(cards).toMatchObject([
      { kind: "listing", askingPrice: "AED 2,400,000", draft: null, upgrades: ["New kitchen"] },
    ]);
    expect(cards[0]!.home).toContain("2-bed apartment");

    const first = await createDraftFromListingRequest({ id: request!.id });
    expect(first).toMatchObject({ ok: true, data: { created: true } });
    if (!first.ok) return;
    const [draft] = await db.select().from(properties).where(eq(properties.id, first.data.id));
    expect(draft).toMatchObject({
      status: "draft",
      purpose: "sale",
      propertyTypeId: ids.apt,
      locationId: ids.marina,
      buildingName: "Marina Gate 1",
      beds: 2,
      baths: 2,
      price: 240_000_000,
      currency: "AED",
      agentId,
    });
    const [linked] = await db.select().from(listingRequests);
    expect(linked!.propertyId).toBe(first.data.id);
    expect(await createDraftFromListingRequest({ id: request!.id })).toMatchObject({
      ok: true,
      data: { id: first.data.id, created: false },
    });
    expect((await db.select().from(properties)).length).toBe(1);
    const actions = (await db.select({ action: auditLog.action }).from(auditLog)).map(
      (a) => a.action,
    );
    expect(actions.filter((a) => !a.startsWith("settings")).sort()).toEqual([
      "listing_request.convert",
      "property.create",
    ]);
    expect((await loadOwnerRequests(db, lead!.id))[0]!.draft?.id).toBe(first.data.id);
  });
});
