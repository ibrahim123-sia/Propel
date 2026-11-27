import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { leadEvents, leads, viewings } from "@/db/schema/crm";
import { agents } from "@/db/schema/people";
import { properties } from "@/db/schema/properties";
import { emailLog, jobRuns } from "@/db/schema/system";
import { patchSettings } from "@/features/settings/mutations";
import { availableSlots } from "@/features/viewings/availability";
import { bookViewing, manageTokenFor, manageTokenHash } from "@/features/viewings/book";
import { queueViewingReminders, viewingTimes } from "@/features/viewings/notify";
import { runDueJobs } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
// Monday 26 October 2026, 08:00 in Dubai.
const now = new Date("2026-10-26T04:00:00Z");

async function runJobs() {
  for (let i = 0; i < 5; i++) if ((await runDueJobs()).ran === 0) return;
}

async function world() {
  const db = await getDb();
  await patchSettings(db, "general", { agencyName: "Haven & Dune", timeZone: "Asia/Dubai" }, actor);
  await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
  await patchSettings(
    db,
    "contact",
    { email: "hello@agency.example", leadNotifyEmails: [] },
    actor,
  );
  const agent = newId();
  await db.insert(agents).values({
    id: agent,
    name: "Layla Haddad",
    slug: "layla",
    email: "layla@agency.example",
  });
  const listing = newId();
  await db.insert(properties).values({
    id: listing,
    reference: "HD-2041",
    title: "Two bed with a marina view",
    slug: "two-bed-marina",
    purpose: "sale",
    status: "available",
    publishedAt: now,
    agentId: agent,
  });
  return { db, agent, listing };
}

const visitor = {
  type: "in_person" as const,
  name: "Sam Visitor",
  email: "sam@example.com",
  phone: "050 123 4567",
  notes: "Parking?",
  timeZone: "Europe/London",
  now,
};

describe("viewings (09 §5)", () => {
  beforeEach(async () => {
    await truncate(
      "viewings",
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "properties",
      "agents",
      "email_log",
      "job_runs",
      "settings",
      "audit_log",
    );
  });

  it("books a real free slot: a lead, a confirmed viewing, and the slot is gone", async () => {
    const { db, agent, listing } = await world();
    const { slots } = await availableSlots(db, agent, now);
    // 4 hours' notice from 08:00 Dubai: Monday 12:00 is the first time.
    expect(slots[0]!.start.toISOString()).toBe("2026-10-26T08:00:00.000Z");
    const start = slots[0]!.start;

    const booked = await bookViewing(db, { ...visitor, propertyId: listing, start });
    const [viewing] = await db.select().from(viewings);
    expect(viewing).toMatchObject({
      id: booked.viewingId,
      leadId: booked.leadId,
      propertyId: listing,
      agentId: agent,
      status: "confirmed",
      startsAt: start,
      endsAt: new Date(start.getTime() + 30 * 60_000),
      visitorTimeZone: "Europe/London",
      source: "site",
    });
    // The link token is never stored: only its hash, and it can be worked out again.
    expect(booked.manageToken).toBe(await manageTokenFor(booked.viewingId));
    expect(viewing!.manageTokenHash).toBe(await manageTokenHash(booked.manageToken));
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({ source: "tour", sourceDetail: "booking", agentId: agent });
    const types = (
      await db
        .select({ type: leadEvents.type })
        .from(leadEvents)
        .where(eq(leadEvents.leadId, lead!.id))
    ).map((e) => e.type);
    expect(types).toContain("viewing_booked");

    // The time (and its buffer) is no longer offered; a second visitor cannot take it.
    const after = (await availableSlots(db, agent, now)).slots.map((s) => s.start.toISOString());
    expect(after).not.toContain(start.toISOString());
    expect(after).not.toContain("2026-10-26T08:30:00.000Z");
    await expect(
      bookViewing(db, {
        ...visitor,
        email: "other@example.com",
        phone: "",
        propertyId: listing,
        start,
      }),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
  });

  it("emails the visitor in their own time with the agency's, and the team", async () => {
    const { db, agent, listing } = await world();
    const start = (await availableSlots(db, agent, now)).slots[0]!.start;
    await bookViewing(db, { ...visitor, propertyId: listing, start });
    await runJobs();
    const mails = await db
      .select({
        to: emailLog.to,
        template: emailLog.template,
        subject: emailLog.subject,
        text: emailLog.text,
      })
      .from(emailLog);
    const confirmed = mails.find((m) => m.template === "viewing.confirmed")!;
    expect(confirmed.to).toBe("sam@example.com");
    // 12:00 in Dubai is 08:00 in London.
    expect(confirmed.subject).toBe("Your viewing is booked: Monday 26 October at 08:00");
    expect(confirmed.text).toContain("(12:00 Dubai time)");
    expect(confirmed.text).toMatch(/\/viewings\/[A-Za-z0-9_-]{32}/);
    expect(
      mails
        .filter((m) => m.template === "viewing.booked")
        .map((m) => m.to)
        .sort(),
    ).toEqual(["hello@agency.example", "layla@agency.example"]);
  });

  it("reminders go once at each time before the viewing", async () => {
    const { db, agent, listing } = await world();
    const start = (await availableSlots(db, agent, now)).slots.at(-1)!.start;
    await bookViewing(db, { ...visitor, propertyId: listing, start });
    // Booked at the test's "now", not the real clock (a later real date made it look booked
    // inside the reminder window).
    await db.update(viewings).set({ createdAt: now });
    await db.delete(jobRuns);
    const hoursBefore = (h: number) => new Date(start.getTime() - h * 3_600_000);
    expect(await queueViewingReminders(db, hoursBefore(25))).toBe(0);
    expect(await queueViewingReminders(db, hoursBefore(23))).toBe(1);
    expect(await queueViewingReminders(db, hoursBefore(22))).toBe(0);
    expect(await queueViewingReminders(db, hoursBefore(1.5))).toBe(1);
    expect(await queueViewingReminders(db, hoursBefore(1))).toBe(0);
    const jobs = await db.select({ name: jobRuns.name }).from(jobRuns);
    expect(jobs.map((j) => j.name)).toEqual(["viewing.notify", "viewing.notify"]);
  });

  it("times read naturally in either time zone", () => {
    const at = new Date("2026-10-26T08:00:00Z");
    expect(viewingTimes(at, "Asia/Dubai", "Asia/Dubai")).toEqual({
      when: "Monday 26 October at 12:00",
      agencyTime: "",
    });
    expect(viewingTimes(at, "Not/AZone", "Asia/Dubai").when).toBe("Monday 26 October at 12:00");
    expect(viewingTimes(at, "America/New_York", "Asia/Dubai")).toEqual({
      when: "Monday 26 October at 04:00",
      agencyTime: " (12:00 Dubai time)",
    });
  });
});
