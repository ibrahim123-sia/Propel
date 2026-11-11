import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema/auth";
import {
  alertsSent,
  customerPreferences,
  savedHomes,
  savedLists,
  savedSearches,
} from "@/db/schema/customer";
import { locations, propertyTypes } from "@/db/schema/master-data";
import { properties } from "@/db/schema/properties";
import { emailLog, jobRuns } from "@/db/schema/system";
import {
  alertNewListing,
  alertPriceDrop,
  alertStatusChange,
  runAlertDigest,
} from "@/features/alerts/jobs";
import { queueListingAlerts } from "@/features/alerts/triggers";
import { changeStatus } from "@/features/properties/status-change";
import { patchSettings } from "@/features/settings/mutations";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  connection: async () => {},
}));

const actor = { type: "admin" as const, id: testAdmin.id };
const now = new Date("2026-10-22T08:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

type Db = Awaited<ReturnType<typeof getDb>>;

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
    city: newId(),
    marina: newId(),
    downtown: newId(),
    sam: newId(),
    rania: newId(),
  };
  await db.insert(propertyTypes).values({ id: ids.apt, name: "Apartment", slug: "apartments" });
  await db.insert(locations).values([
    { id: ids.city, level: "city", name: "Dubai", slug: "dubai" },
    {
      id: ids.marina,
      parentId: ids.city,
      level: "area",
      name: "Dubai Marina",
      slug: "dubai-marina",
    },
    { id: ids.downtown, parentId: ids.city, level: "area", name: "Downtown", slug: "downtown" },
  ]);
  await db.insert(users).values([
    {
      id: ids.sam,
      name: "Sam Visitor",
      email: "sam@example.com",
      phone: "+971501234567",
      role: "customer",
    },
    { id: ids.rania, name: "Rania Saleh", email: "rania@example.com", role: "customer" },
  ]);
  return { db, ids };
}

let n = 0;
async function listing(
  db: Db,
  ids: Awaited<ReturnType<typeof world>>["ids"],
  values: Partial<typeof properties.$inferInsert> = {},
) {
  const id = newId();
  n++;
  await db.insert(properties).values({
    id,
    reference: `HD-${9000 + n}`,
    title: `Two bed ${n}`,
    slug: `two-bed-${n}-${id.slice(-6)}`,
    purpose: "sale",
    status: "available",
    publishedAt: now,
    price: 200_000_000,
    currency: "AED",
    beds: 2,
    locationId: ids.marina,
    propertyTypeId: ids.apt,
    point: { lng: 55.14, lat: 25.08 },
    ...values,
  });
  return id;
}

async function search(
  db: Db,
  userId: string,
  values: Partial<typeof savedSearches.$inferInsert> & { filters: Record<string, unknown> },
) {
  const id = newId();
  await db.insert(savedSearches).values({
    id,
    userId,
    name: "Marina two beds",
    alertFrequency: "instant",
    createdAt: hoursAgo(48),
    ...values,
  });
  return id;
}

async function save(db: Db, userId: string, propertyId: string) {
  const list = newId();
  await db.insert(savedLists).values({ id: list, userId, name: "Saved", isDefault: true });
  const id = newId();
  await db
    .insert(savedHomes)
    .values({ id, userId, listId: list, propertyId, priceWhenSaved: 200_000_000 });
  return id;
}

const mails = async (db: Db) =>
  db
    .select({
      to: emailLog.to,
      template: emailLog.template,
      subject: emailLog.subject,
      text: emailLog.text,
    })
    .from(emailLog);

describe("alerts (12 §3)", () => {
  beforeEach(async () => {
    await truncate(
      "alerts_sent",
      "saved_homes",
      "saved_lists",
      "saved_searches",
      "customer_preferences",
      "properties",
      "locations",
      "property_types",
      "users",
      "email_log",
      "job_runs",
      "settings",
      "audit_log",
    );
  });

  it("publishing a matching listing sends one instant alert, even when the job runs twice", async () => {
    const { db, ids } = await world();
    await search(db, ids.sam, { filters: { loc: ["dubai-marina"], max: "3000000", beds: ["2"] } });
    // Base-currency prices: 500,000 USD is 2,000,000 AED, inside a 2.5M AED limit.
    await search(db, ids.rania, {
      name: "Cheap marina",
      filters: { loc: "dubai-marina", max: "2500000" },
    });
    await search(db, ids.rania, { name: "Downtown", filters: { loc: ["downtown"] } });
    await search(db, ids.rania, {
      name: "Daily",
      alertFrequency: "daily",
      filters: { loc: ["dubai-marina"] },
    });
    const usd = await listing(db, ids, { price: 50_000_000, currency: "USD" });

    expect(await alertNewListing(db, usd, now)).toEqual({ matched: 2, sent: 2, similar: 0 });
    expect(await alertNewListing(db, usd, now)).toEqual({ matched: 2, sent: 0, similar: 0 });
    const sent = await mails(db);
    expect(sent.map((m) => [m.to, m.template]).sort()).toEqual([
      ["rania@example.com", "alerts.new_match"],
      ["sam@example.com", "alerts.new_match"],
    ]);
    const sam = sent.find((m) => m.to === "sam@example.com")!;
    expect(sam.subject).toBe("1 new home for “Marina two beds”");
    expect(sam.text).toContain("Two bed");
    expect(sam.text).toMatch(/\/buy\/dubai-marina\?max=3000000&beds=2/);
    expect(sam.text).toMatch(/\/api\/alerts\/unsubscribe\?token=[A-Za-z0-9_-]{32}/);
    // The mail app's own unsubscribe button (RFC 8058) rides along with the email job.
    const [job] = await db
      .select({ payload: jobRuns.payload })
      .from(jobRuns)
      .where(eq(jobRuns.name, "email.send"));
    expect(job!.payload).toMatchObject({
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });

    // A drawn area: a listing outside it does not match.
    await search(db, ids.sam, {
      name: "Drawn",
      filters: { purpose: "sale" },
      polygon: {
        type: "Polygon",
        coordinates: [
          [
            [55.0, 25.0],
            [55.1, 25.0],
            [55.1, 25.1],
            [55.0, 25.1],
            [55.0, 25.0],
          ],
        ],
      },
    });
    const outside = await listing(db, ids);
    const inside = await listing(db, ids, { point: { lng: 55.05, lat: 25.05 } });
    await db.delete(emailLog);
    await alertNewListing(db, outside, now);
    await alertNewListing(db, inside, now);
    const drawn = (await mails(db)).filter((m) => m.subject.includes("Drawn"));
    expect(drawn).toHaveLength(1);
  });

  it("digests: daily and weekly searches get only listings new since their last email", async () => {
    const { db, ids } = await world();
    const daily = await search(db, ids.sam, {
      name: "Daily marina",
      alertFrequency: "daily",
      filters: { loc: ["dubai-marina"] },
    });
    await search(db, ids.rania, {
      name: "Weekly marina",
      alertFrequency: "weekly",
      filters: { loc: ["dubai-marina"] },
    });
    await search(db, ids.rania, {
      name: "Off",
      alertFrequency: "off",
      filters: { loc: ["dubai-marina"] },
    });
    await listing(db, ids, { publishedAt: hoursAgo(72) }); // before the searches existed
    await listing(db, ids, { publishedAt: hoursAgo(5) });
    await listing(db, ids, { publishedAt: hoursAgo(3) });

    expect(await runAlertDigest(db, "daily", now)).toEqual({ searches: 1, sent: 1 });
    const [mail] = await mails(db);
    expect(mail).toMatchObject({ to: "sam@example.com", template: "alerts.digest" });
    expect(mail!.subject).toBe("2 new homes today for “Daily marina”");
    expect(
      await db.select().from(alertsSent).where(eq(alertsSent.savedSearchId, daily)),
    ).toHaveLength(2);
    // The next morning: nothing new, nothing sent.
    expect(await runAlertDigest(db, "daily", new Date(now.getTime() + 86_400_000))).toEqual({
      searches: 1,
      sent: 0,
    });
    expect(await runAlertDigest(db, "weekly", now)).toEqual({ searches: 1, sent: 1 });
    expect((await mails(db)).map((m) => m.subject)).toContain(
      "2 new homes this week for “Weekly marina”",
    );
  });

  it("digests include a listing that came back on the market (decision 70)", async () => {
    const { db, ids } = await world();
    await search(db, ids.sam, {
      name: "Daily marina",
      alertFrequency: "daily",
      filters: { loc: ["dubai-marina"] },
    });
    // First published long before the search, then back on the market today
    // (changeStatus sets went_live_at when a listing goes live again).
    await listing(db, ids, { publishedAt: hoursAgo(24 * 40), wentLiveAt: hoursAgo(2) });
    await listing(db, ids, { publishedAt: hoursAgo(24 * 40) }); // still the old one
    expect(await runAlertDigest(db, "daily", now)).toEqual({ searches: 1, sent: 1 });
    expect((await mails(db))[0]!.subject).toBe("1 new home today for “Daily marina”");
  });

  it("price drops: the savers and matching instant searches, once per new price", async () => {
    const { db, ids } = await world();
    const home = await listing(db, ids);
    await save(db, ids.sam, home);
    await search(db, ids.sam, { filters: { loc: ["dubai-marina"] } }); // Sam hears once, not twice
    await search(db, ids.rania, { name: "Rania marina", filters: { loc: ["dubai-marina"] } });

    const drop = {
      propertyId: home,
      oldPrice: 200_000_000,
      newPrice: 190_000_000,
      currency: "AED",
    };
    expect(await alertPriceDrop(db, drop, now)).toEqual({ sent: 2 });
    expect(await alertPriceDrop(db, drop, now)).toEqual({ sent: 0 });
    let sent = await mails(db);
    expect(sent.map((m) => m.to).sort()).toEqual(["rania@example.com", "sam@example.com"]);
    expect(sent[0]!.subject).toBe("Price dropped by AED 100,000: Two bed " + n);
    expect(sent.find((m) => m.to === "sam@example.com")!.text).toMatch(/unsubscribe\?pref=/);

    // A further drop is news again.
    await alertPriceDrop(db, { ...drop, oldPrice: 190_000_000, newPrice: 180_000_000 }, now);
    sent = await mails(db);
    expect(sent).toHaveLength(4);
    expect(sent.at(-1)!.subject).toContain("Price dropped by AED 100,000");
    // A price that went up is no drop.
    expect(
      await alertPriceDrop(db, { ...drop, oldPrice: 180_000_000, newPrice: 185_000_000 }, now),
    ).toEqual({
      skipped: "not a live price drop",
    });
  });

  it("a new listing like a saved home reaches its saver once, unless a search told them", async () => {
    const { db, ids } = await world();
    const saved = await listing(db, ids, { title: "Marina two bed" });
    await save(db, ids.sam, saved);
    await save(db, ids.rania, saved);
    await search(db, ids.rania, { name: "Rania marina", filters: { loc: ["dubai-marina"] } });
    // Too dear, another area, another purpose: not like it.
    for (const other of [
      { price: 300_000_000 },
      { locationId: ids.downtown },
      { purpose: "rent" as const, pricePeriod: "year" as const },
    ])
      expect(await alertNewListing(db, await listing(db, ids, other), now)).toMatchObject({
        similar: 0,
      });
    await db.delete(emailLog);

    const like = await listing(db, ids, { title: "Marina two bed, higher floor", beds: 3 });
    expect(await alertNewListing(db, like, now)).toMatchObject({ sent: 1, similar: 1 });
    expect(await alertNewListing(db, like, now)).toMatchObject({ similar: 0 });
    const sent = await mails(db);
    expect(sent.map((m) => [m.to, m.template]).sort()).toEqual([
      ["rania@example.com", "alerts.new_match"],
      ["sam@example.com", "alerts.similar_home"],
    ]);
    const sam = sent.find((m) => m.to === "sam@example.com")!;
    expect(sam.subject).toBe(
      "New on the market, like Marina two bed: Marina two bed, higher floor",
    );
    expect(sam.text).toContain("AED 2,000,000");
    expect(sam.text).toMatch(/unsubscribe\?pref=/);

    // Switched off in the customer's preferences: nothing.
    await db
      .insert(customerPreferences)
      .values({ userId: ids.sam, newMatch: { email: false, whatsapp: false } });
    expect(await alertNewListing(db, await listing(db, ids), now)).toMatchObject({ similar: 0 });
  });

  it("status changes reach the savers once; preferences and WhatsApp opt-in are respected", async () => {
    const { db, ids } = await world();
    const home = await listing(db, ids);
    await save(db, ids.sam, home);
    await save(db, ids.rania, home);
    await db.insert(customerPreferences).values([
      { userId: ids.rania, statusChange: { email: false, whatsapp: false } },
      { userId: ids.sam, statusChange: { email: true, whatsapp: true }, whatsappOptInAt: now },
    ]);
    await db.update(properties).set({ status: "reserved" }).where(eq(properties.id, home));
    expect(await alertStatusChange(db, { propertyId: home, status: "reserved" }, now)).toEqual({
      sent: 1,
    });
    expect(await alertStatusChange(db, { propertyId: home, status: "reserved" }, now)).toEqual({
      sent: 0,
    });
    const sent = await mails(db);
    expect(sent).toEqual([
      expect.objectContaining({ to: "sam@example.com", template: "alerts.status_change" }),
    ]);
    expect(sent[0]!.subject).toBe(`Two bed ${n} is now reserved`);
    // Sam opted in to WhatsApp: an approved-template notice is queued too.
    const wa = await db
      .select({ payload: jobRuns.payload })
      .from(jobRuns)
      .where(eq(jobRuns.name, "whatsapp.notify"));
    expect(wa).toEqual([
      { payload: expect.objectContaining({ to: "+971501234567", key: "alerts.status_change" }) },
    ]);
    // A status that moved on again does nothing.
    expect(await alertStatusChange(db, { propertyId: home, status: "sold" }, now)).toEqual({
      skipped: "status changed again",
    });
  });

  it("one-click unsubscribe switches a search off; a preference link stops one kind of email", async () => {
    const { db, ids } = await world();
    const id = await search(db, ids.sam, { filters: { loc: ["dubai-marina"] } });
    const home = await listing(db, ids);
    await alertNewListing(db, home, now);
    const [mail] = await mails(db);
    const token = mail!.text!.match(/unsubscribe\?token=([A-Za-z0-9_-]{32})/)![1]!;
    const { GET, POST } = await import("@/app/api/alerts/unsubscribe/route");
    const res = await GET(
      new Request(`http://havendune.example/api/alerts/unsubscribe?token=${token}`),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "http://havendune.example/alerts/unsubscribed?search=Marina+two+beds",
    );
    const [row] = await db
      .select({ f: savedSearches.alertFrequency })
      .from(savedSearches)
      .where(eq(savedSearches.id, id));
    expect(row!.f).toBe("off");
    // Off means off: the next listing sends nothing.
    await db.delete(emailLog);
    await alertNewListing(db, await listing(db, ids), now);
    expect(await mails(db)).toEqual([]);

    // A saved home's price drop carries a preference link; the mail app may POST it.
    await save(db, ids.sam, home);
    await alertPriceDrop(
      db,
      { propertyId: home, oldPrice: 200_000_000, newPrice: 150_000_000, currency: "AED" },
      now,
    );
    const [drop] = await mails(db);
    const pref = drop!.text!.match(/unsubscribe\?pref=([A-Za-z0-9_.-]+)/)![1]!;
    expect(
      (
        await POST(
          new Request(`http://havendune.example/api/alerts/unsubscribe?pref=${pref}`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(200);
    const [prefs] = await db
      .select()
      .from(customerPreferences)
      .where(eq(customerPreferences.userId, ids.sam));
    expect(prefs!.priceDrop).toEqual({ email: false, whatsapp: false });
    expect(
      (
        await GET(new Request("http://havendune.example/api/alerts/unsubscribe?token=nope"))
      ).headers.get("location"),
    ).toContain("kind=invalid");
  });

  it("listing changes queue the alert jobs", async () => {
    const { db, ids } = await world();
    const home = await listing(db, ids);
    await db.transaction(async (tx) => {
      await changeStatus(tx, { id: home, next: "reserved", actor, userId: null });
    });
    await queueListingAlerts(db, { kind: "live", propertyId: home });
    await queueListingAlerts(db, {
      kind: "price",
      propertyId: home,
      oldPrice: 2,
      newPrice: 1,
      currency: "AED",
    });
    await queueListingAlerts(db, {
      kind: "price",
      propertyId: home,
      oldPrice: 1,
      newPrice: 2,
      currency: "AED",
    });
    const names = (await db.select({ name: jobRuns.name }).from(jobRuns)).map((j) => j.name).sort();
    expect(names).toEqual(["alerts.new_listing", "alerts.price_drop", "alerts.status_change"]);
  });
});
