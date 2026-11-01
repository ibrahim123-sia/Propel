import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { leadEvents, leads } from "@/db/schema/crm";
import { facilities, locations, poiTypes, pois, propertyTypes } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { paymentPlanSteps, paymentPlans } from "@/db/schema/payment-plans";
import { agents } from "@/db/schema/people";
import { projectPois, projects, projectUnitTypes, projectMedia } from "@/db/schema/projects";
import {
  properties,
  propertyDailyStats,
  propertyFacilities,
  propertyMedia,
  propertyPois,
} from "@/db/schema/properties";
import { emailLog, jobRuns } from "@/db/schema/system";
import { requestBrochure } from "@/features/brochure/actions";
import { brochureFileName, brochureVersion, loadBrochure } from "@/features/brochure/data";
import { brochureRenderJob } from "@/features/brochure/jobs";
import { brochureTokenValid } from "@/features/brochure/links";
import {
  brochureDocument,
  brochureFile,
  paymentScheduleDocument,
} from "@/features/brochure/render";
import { revalidateListings } from "@/features/properties/write";
import { patchSettings } from "@/features/settings/mutations";
import { desertModernColors } from "@/features/settings/schema";
import { newId } from "@/lib/ids";
import { memoryStorage, setStorage } from "@/lib/storage";
import { GET as adminGet } from "@/app/api/admin/brochure/[kind]/[id]/route";
import { GET as publicGet } from "@/app/api/brochure/[kind]/[id]/route";
import { GET as scheduleGet } from "@/app/api/brochure/[kind]/[id]/schedule/route";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));
// Route handlers read cookies; outside a Next request there are none.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

// Tests never reach Google Fonts: the PDF uses fallback fonts.
process.env.BROCHURE_WEB_FONTS = "off";

const actor = { type: "admin" as const, id: testAdmin.id };
const AGENCY = "Harbour Lane Homes";
const ACCENT = "#2F6FA9";
// A valid 1x1 PNG.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const pin = { lng: 55.1412, lat: 25.0812 };
const north = (km: number) => ({ lng: pin.lng, lat: pin.lat + km / 111.2 });
const east = (km: number) => ({ lng: pin.lng + km / 100.6, lat: pin.lat });

const pageCount = (pdf: Uint8Array) =>
  new TextDecoder("latin1").decode(pdf).match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;

let storage = memoryStorage();

async function world() {
  const db = await getDb();
  await patchSettings(db, "general", { agencyName: AGENCY, licenceNumber: "ORN-4471" }, actor);
  await patchSettings(db, "branding", { colors: { ...desertModernColors, accent: ACCENT } }, actor);
  await patchSettings(
    db,
    "market",
    {
      baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
      areaUnit: "sqft",
      permit: { enabled: true, label: "Permit no.", requiredOnPublish: false },
    },
    actor,
  );
  await patchSettings(
    db,
    "contact",
    { phone: "+971 4 555 0100", email: "hello@harbourlane.example", whatsapp: "+971500000001" },
    actor,
  );
  const ids = {
    type: newId(),
    area: newId(),
    agent: newId(),
    photo1: newId(),
    photo2: newId(),
    plan: newId(),
    floor: newId(),
    pool: newId(),
    school: newId(),
    metro: newId(),
    poiSchool: newId(),
    poiMetro: newId(),
    paymentPlan: newId(),
  };
  await db.insert(propertyTypes).values({ id: ids.type, name: "Apartment", slug: "apartments" });
  await db
    .insert(locations)
    .values({ id: ids.area, level: "area", name: "Dubai Marina", slug: "dubai-marina" });
  await db.insert(agents).values({
    id: ids.agent,
    name: "Layla Haddad",
    slug: "layla",
    title: "Senior consultant",
    email: "layla@harbourlane.example",
    phone: "+971501112233",
    whatsapp: "+971501112233",
  });
  const files = [
    { id: ids.photo1, key: "2026/10/brochaaaaa/living.png", alt: "Living room" },
    { id: ids.photo2, key: "2026/10/brochbbbbb/kitchen.png", alt: "Kitchen" },
    { id: ids.floor, key: "2026/10/brochccccc/plan.png", alt: "Floor plan" },
  ];
  for (const f of files) {
    await storage.put(f.key, png, "image/png");
    await db.insert(media).values({
      id: f.id,
      r2Key: f.key,
      fileName: f.key.split("/").pop()!,
      mime: "image/png",
      status: "ready",
      alt: f.alt,
    });
  }
  await db.insert(facilities).values({ id: ids.pool, name: "Infinity pool" });
  await db.insert(poiTypes).values([
    { id: ids.school, name: "School", category: "schools" },
    { id: ids.metro, name: "Metro station", category: "transport", travelMode: "walk" },
  ]);
  await db.insert(pois).values([
    { id: ids.poiSchool, poiTypeId: ids.school, name: "Marina Primary", point: north(0.6) },
    { id: ids.poiMetro, poiTypeId: ids.metro, name: "Marina Station", point: east(0.4) },
  ]);
  await db.insert(paymentPlans).values({ id: ids.paymentPlan, name: "60/40" });
  await db.insert(paymentPlanSteps).values([
    { paymentPlanId: ids.paymentPlan, stage: "booking", label: "Down payment", percent: 60 },
    { paymentPlanId: ids.paymentPlan, stage: "handover", label: "On handover", percent: 40 },
  ]);
  return { db, ids };
}

async function home(w: Awaited<ReturnType<typeof world>>) {
  const { db, ids } = w;
  const id = newId();
  await db.insert(properties).values({
    id,
    reference: "HL-1042",
    title: "Two bed with a marina view",
    slug: "two-bed-marina-view",
    purpose: "sale",
    status: "available",
    completion: "off_plan",
    handoverText: "Q4 2027",
    publishedAt: new Date(),
    currency: "AED",
    price: 245_000_000,
    beds: 2,
    baths: 2,
    size: 120,
    propertyTypeId: ids.type,
    locationId: ids.area,
    agentId: ids.agent,
    permitNumber: "PRM-778812",
    point: pin,
    mapPinExact: true,
    paymentPlanId: ids.paymentPlan,
    highlights: ["Marina view", "Walk to the metro"],
  });
  await db.insert(propertyMedia).values([
    { propertyId: id, mediaId: ids.photo1, kind: "photo", isCover: true, sortOrder: 0 },
    { propertyId: id, mediaId: ids.photo2, kind: "photo", sortOrder: 1 },
    { propertyId: id, mediaId: ids.floor, kind: "floor_plan", sortOrder: 0 },
  ]);
  await db.insert(propertyFacilities).values({ propertyId: id, facilityId: ids.pool });
  await db.insert(propertyPois).values([
    { propertyId: id, poiId: ids.poiSchool, straightDistanceM: 600, driveSeconds: 240 },
    { propertyId: id, poiId: ids.poiMetro, straightDistanceM: 400, walkSeconds: 300 },
  ]);
  return id;
}

describe("branded PDF brochure (11 §4)", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    storage = memoryStorage();
    setStorage(storage);
    await truncate(
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "visitors",
      "visitor_events",
      "property_daily_stats",
      "property_pois",
      "project_pois",
      "project_unit_types",
      "project_media",
      "property_facilities",
      "property_media",
      "properties",
      "projects",
      "payment_plans",
      "payment_plan_steps",
      "pois",
      "poi_types",
      "facilities",
      "agents",
      "locations",
      "property_types",
      "media",
      "message_templates",
      "email_log",
      "job_runs",
      "rate_limits",
      "settings",
      "audit_log",
    );
  });
  afterEach(() => setStorage(null));
  afterAll(() => setStorage(null));

  it("renders all four pages with the agency's branding, and keeps the PDF per version", async () => {
    const w = await world();
    const id = await home(w);
    const loaded = (await loadBrochure(w.db, "property", id))!;
    expect(loaded.uploaded).toBeNull();

    const html = await brochureDocument(loaded.data);
    expect(html).toContain(AGENCY);
    expect(html).toContain(`--accent: ${ACCENT}`);
    expect(html).toContain("HL-1042");
    expect(html).toContain("PRM-778812"); // permit number
    expect(html).toContain("Layla Haddad");
    expect(html).toContain("AED 2,450,000");
    expect(html).toContain("Marina Primary");
    expect(html).toContain("Marina Station");
    expect(html).toContain("5 min walk");
    expect(html).toContain("Infinity pool");
    expect(html).toContain("Down payment");
    expect(html).toContain('<a class="qr" href="https://wa.me/971501112233?text='); // QR + link
    expect(html).toMatch(/<svg[^>]+viewBox="0 0 600 600"/); // the location plot
    expect(html).toContain("data:image/png;base64,"); // pictures inlined outside Workers
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html.match(/<section class="page"/g)).toHaveLength(4);

    const file = (await brochureFile(w.db, "property", id))!;
    expect(file.source).toBe("generated");
    expect(file.fileName).toBe("HL-1042-two-bed-marina-view.pdf");
    expect(new TextDecoder("latin1").decode(file.bytes.slice(0, 5))).toBe("%PDF-");
    expect(pageCount(file.bytes)).toBe(4);
    const version = await brochureVersion(loaded.data);
    expect(storage.keys()).toContain(`brochures/property/${id}/${version}.pdf`);

    // The job finds this version stored and does not draw it again.
    const ctx = { db: w.db, jobId: newId(), attempt: 1, log: () => undefined };
    expect(await brochureRenderJob.run({ kind: "property", id }, ctx)).toMatchObject({
      version,
      rendered: false,
    });
  }, 120_000);

  it("downloads the payment schedule as a one-page PDF; a home without a plan has none", async () => {
    const w = await world();
    const id = await home(w);
    const get = (pid: string) =>
      scheduleGet(new Request(`http://localhost/api/brochure/property/${pid}/schedule`), {
        params: Promise.resolve({ kind: "property", id: pid }),
      });
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("payment-schedule-hl-1042.pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(pageCount(bytes)).toBe(1);

    const html = (await paymentScheduleDocument(
      (await loadBrochure(w.db, "property", id))!.data,
      "31 October 2026",
    ))!;
    expect(html).toContain("Payment schedule");
    expect(html).toContain("Down payment");
    expect(html).toContain("On handover");
    expect(html).toContain("AED 1,470,000"); // 60% of AED 2,450,000
    expect(html).toContain("Made on 31 October 2026");

    await w.db.update(properties).set({ paymentPlanId: null }).where(eq(properties.id, id));
    expect((await get(id)).status).toBe(404);
  }, 120_000);

  it("gets a new version when the listing, its agent or the branding changes", async () => {
    const w = await world();
    const id = await home(w);
    const version = async () => brochureVersion((await loadBrochure(w.db, "property", id))!.data);
    const v1 = await version();
    expect(await version()).toBe(v1); // stable while nothing changes

    await w.db.update(properties).set({ price: 239_000_000 }).where(eq(properties.id, id));
    const v2 = await version();
    expect(v2).not.toBe(v1);
    await w.db.update(agents).set({ phone: "+971509998877" }).where(eq(agents.id, w.ids.agent));
    const v3 = await version();
    expect(v3).not.toBe(v2);
    await patchSettings(w.db, "branding", { fontDisplay: "Lora" }, actor);
    const v4 = await version();
    expect(v4).not.toBe(v3);

    // A change queues one render a few minutes later, however many saves come in.
    await revalidateListings([id]);
    await revalidateListings([id]);
    const jobs = await w.db
      .select({ runAfter: jobRuns.runAfter })
      .from(jobRuns)
      .where(eq(jobRuns.name, "brochure.render"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it("offers an uploaded brochure first; the admin always gets the generated one", async () => {
    const w = await world();
    const id = await home(w);
    const pdfId = newId();
    const uploaded = new TextEncoder().encode("%PDF-1.4 developer brochure");
    await storage.put("2026/10/brochddddd/developer.pdf", uploaded, "application/pdf");
    await w.db.insert(media).values({
      id: pdfId,
      r2Key: "2026/10/brochddddd/developer.pdf",
      fileName: "developer.pdf",
      mime: "application/pdf",
      status: "ready",
    });
    await w.db.insert(propertyMedia).values({ propertyId: id, mediaId: pdfId, kind: "brochure" });

    const file = (await brochureFile(w.db, "property", id))!;
    expect(file.source).toBe("uploaded");
    expect(new TextDecoder().decode(file.bytes)).toContain("developer brochure");

    const res = await adminGet(new Request("http://localhost/x"), {
      params: Promise.resolve({ kind: "property", id }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'inline; filename="HL-1042-two-bed-marina-view.pdf"',
    );
    expect(pageCount(new Uint8Array(await res.arrayBuffer()))).toBe(4);

    // Drafts have no brochure: it shows what the site shows.
    await w.db.update(properties).set({ status: "draft" }).where(eq(properties.id, id));
    const draft = await adminGet(new Request("http://localhost/x"), {
      params: Promise.resolve({ kind: "property", id }),
    });
    expect(draft.status).toBe(409);
    adminState.user = null;
    const signedOut = await adminGet(new Request("http://localhost/x"), {
      params: Promise.resolve({ kind: "property", id }),
    });
    expect(signedOut.status).toBe(401);
  }, 120_000);

  it("the email gate makes a brochure lead and emails a link that passes the gate", async () => {
    const w = await world();
    const id = await home(w);
    await patchSettings(w.db, "leads", { brochureEmailGate: true }, actor);
    const params = { params: Promise.resolve({ kind: "property", id }) };

    // Without the emailed link, the download goes back to the page (where the form is).
    const blocked = await publicGet(
      new Request(`http://localhost/api/brochure/property/${id}`),
      params,
    );
    expect(blocked.status).toBe(303);
    expect(blocked.headers.get("location")).toBe(
      "http://localhost/property/two-bed-marina-view?brochure=1#brochure",
    );

    const res = await requestBrochure({
      kind: "property",
      id,
      name: "Sam Visitor",
      email: "Sam@Example.com",
      consent: true,
    });
    if (!res.ok) throw new Error(res.error);
    const token = new URL(res.data.downloadUrl, "http://localhost").searchParams.get("t");
    expect(await brochureTokenValid(token, "property", id)).toBe(true);
    expect(await brochureTokenValid(token, "property", newId())).toBe(false);

    const [lead] = await w.db.select().from(leads);
    expect(lead).toMatchObject({ source: "brochure", sourceDetail: "listing", propertyIds: [id] });
    const sent = await w.db
      .select()
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead!.id), eq(leadEvents.type, "brochure_sent")));
    expect(sent).toHaveLength(1);
    const [mail] = await w.db.select().from(emailLog).where(eq(emailLog.template, "brochure.link"));
    expect(mail).toMatchObject({ to: "sam@example.com" });
    expect(mail!.html).toContain(`/api/brochure/property/${id}?t=`);
    expect(mail!.subject).toBe("Your brochure: Two bed with a marina view (HL-1042)");

    // The emailed link downloads the PDF, named as the spec says, and is counted.
    const download = await publicGet(
      new Request(`http://localhost/api/brochure/property/${id}?t=${encodeURIComponent(token!)}`, {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0" },
      }),
      params,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect(download.headers.get("content-disposition")).toBe(
      'attachment; filename="HL-1042-two-bed-marina-view.pdf"',
    );
    const [stats] = await w.db
      .select()
      .from(propertyDailyStats)
      .where(eq(propertyDailyStats.propertyId, id));
    expect(stats!.brochureDownloads).toBe(1);

    // Bots filling the honeypot get a harmless answer and no lead.
    const bot = await requestBrochure({
      kind: "property",
      id,
      name: "Bot",
      email: "bot@example.com",
      consent: true,
      website: "http://spam.example",
    });
    expect(bot.ok).toBe(true);
    expect(await w.db.select().from(leads)).toHaveLength(1);
    // Consent is required.
    const noConsent = await requestBrochure({
      kind: "property",
      id,
      name: "Sam",
      email: "sam@example.com",
      consent: false as unknown as true,
    });
    expect(noConsent).toMatchObject({ ok: false, code: "VALIDATION" });
  }, 120_000);

  it("a project's brochure has its unit types, amenities and the agency's contact", async () => {
    const w = await world();
    const projectId = newId();
    await w.db.insert(projects).values({
      id: projectId,
      name: "Marina Crest",
      slug: "marina-crest",
      locationId: w.ids.area,
      point: pin,
      status: "under_construction",
      handoverText: "Q2 2028",
      startingPrice: 150_000_000,
      currency: "AED",
      paymentPlanId: w.ids.paymentPlan,
      isPublished: true,
      publishedAt: new Date(),
    });
    await w.db
      .insert(projectMedia)
      .values({ projectId, mediaId: w.ids.photo1, kind: "photo", isCover: true });
    await w.db.insert(projectUnitTypes).values([
      {
        projectId,
        name: "1 bed type A",
        beds: 1,
        sizeMin: 70,
        sizeMax: 80,
        priceFrom: 150_000_000,
      },
      { projectId, name: "2 bed type B", beds: 2, sizeMin: 110, priceFrom: 220_000_000 },
    ]);
    await w.db
      .insert(projectPois)
      .values({ projectId, poiId: w.ids.poiSchool, straightDistanceM: 600, driveSeconds: 240 });

    const loaded = (await loadBrochure(w.db, "project", projectId))!;
    expect(brochureFileName(loaded.data)).toBe("marina-crest.pdf");
    const html = await brochureDocument(loaded.data);
    expect(html).toContain("From AED 1,500,000");
    expect(html).toContain("2 bed type B");
    expect(html).toContain("hello@harbourlane.example");
    expect(html).toContain("Marina Primary");
    const file = (await brochureFile(w.db, "project", projectId))!;
    expect(pageCount(file.bytes)).toBe(4);

    await w.db.update(projects).set({ isPublished: false }).where(eq(projects.id, projectId));
    expect(await loadBrochure(w.db, "project", projectId)).toBeNull();
  }, 120_000);
});
