import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { leads, listingRequests } from "@/db/schema/crm";
import { locations, propertyTypes } from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { properties } from "@/db/schema/properties";
import { auditLog } from "@/db/schema/system";
import { captureLead } from "@/features/leads/capture";
import { patchSettings } from "@/features/settings/mutations";
import { createDraftFromListingRequest } from "@/features/valuation/admin-actions";
import { loadOwnerRequests } from "@/features/valuation/admin";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const SQFT = 0.09290304;
const ids = { city: newId(), marina: newId(), apt: newId() };
const agentId = newId();

/**
 * Owners no longer send requests from the site (the agency lists every home), but requests
 * sent before still show on their lead, and a listing request still becomes a draft listing.
 */
describe("owner requests sent before the public forms were removed", () => {
  beforeEach(async () => {
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
      "job_runs",
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
    await patchSettings(db, "leads", { assignmentRule: "area_match" }, actor);
    await db.insert(propertyTypes).values({ id: ids.apt, name: "Apartment", slug: "apartments" });
    await db.insert(locations).values([
      { id: ids.city, level: "city", name: "Dubai", slug: "dubai" },
      { id: ids.marina, parentId: ids.city, level: "area", name: "Dubai Marina", slug: "marina" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      name: "Layla Haddad",
      slug: "layla",
      email: "layla@agency.example",
      areas: [ids.marina],
    });
  });

  it("admin: a listing request becomes a draft listing in one click, once, audited", async () => {
    const db = await getDb();
    const lead0 = await captureLead(db, {
      source: "listing_request",
      contact: { name: "Rana Owner", email: "rana@example.com", phone: "050 123 4567" },
      requirements: { purpose: "sale", locationIds: [ids.marina] },
    });
    await db.insert(listingRequests).values({
      contactId: lead0.contactId,
      leadId: lead0.leadId,
      purpose: "sell",
      propertyTypeId: ids.apt,
      locationId: ids.marina,
      building: "Marina Gate 1",
      beds: 2,
      baths: 2,
      size: 1180 * SQFT,
      condition: "good",
      upgrades: ["kitchen"],
      currency: "AED",
      askingPrice: 240_000_000,
    });
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
