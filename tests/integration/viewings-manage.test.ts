import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { viewings } from "@/db/schema/crm";
import { agents } from "@/db/schema/people";
import { properties } from "@/db/schema/properties";
import { jobRuns } from "@/db/schema/system";
import { patchSettings } from "@/features/settings/mutations";
import { availableSlots } from "@/features/viewings/availability";
import { bookViewing } from "@/features/viewings/book";
import {
  cancelViewing,
  rescheduleViewing,
  saveViewingFeedback,
  viewingByToken,
} from "@/features/viewings/manage";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const now = new Date("2026-10-26T04:00:00Z");

async function booked() {
  const db = await getDb();
  await patchSettings(db, "general", { timeZone: "Asia/Dubai" }, actor);
  await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
  const agent = newId();
  await db.insert(agents).values({ id: agent, name: "Layla Haddad", slug: "layla" });
  const listing = newId();
  await db.insert(properties).values({
    id: listing,
    reference: "HD-2041",
    title: "Two bed",
    slug: "two-bed",
    purpose: "sale",
    status: "available",
    publishedAt: now,
    agentId: agent,
  });
  const slots = (await availableSlots(db, agent, now)).slots;
  const res = await bookViewing(db, {
    propertyId: listing,
    type: "in_person",
    start: slots[0]!.start,
    name: "Sam",
    email: "sam@example.com",
    phone: "0501234567",
    notes: "",
    timeZone: null,
    now,
  });
  return { db, agent, slots, token: res.manageToken, viewingId: res.viewingId };
}

describe("viewing links (09 §5)", () => {
  beforeEach(async () => {
    await truncate(
      "viewings",
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "properties",
      "agents",
      "job_runs",
      "email_log",
      "settings",
      "audit_log",
    );
  });

  it("opens Google Calendar's new-event page filled in for the viewing", async () => {
    const { token, slots } = await booked();
    const { GET } = await import("@/app/api/viewings/[token]/google/route");
    const call = (t: string) =>
      GET(new Request(`http://localhost/api/viewings/${t}/google`), {
        params: Promise.resolve({ token: t }),
      } as never);
    const res = await call(token);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(to.searchParams.get("action")).toBe("TEMPLATE");
    expect(to.searchParams.get("text")).toContain("Viewing: HD-2041 · Two bed");
    const stamp = (d: string | Date) =>
      new Date(d)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    expect(to.searchParams.get("dates")).toBe(`${stamp(slots[0]!.start)}/${stamp(slots[0]!.end)}`);
    expect(to.searchParams.get("details")).toContain(`/viewings/${token}`);
    expect((await call("x".repeat(32))).status).toBe(404);
  });

  it("finds the viewing by its link only", async () => {
    const { db, token, viewingId } = await booked();
    expect((await viewingByToken(db, token))?.viewing.id).toBe(viewingId);
    expect(await viewingByToken(db, "x".repeat(32))).toBeNull();
    expect(await viewingByToken(db, "short")).toBeNull();
  });

  it("moves to another free time (its own time counts free) and asks for reminders again", async () => {
    const { db, slots, token } = await booked();
    await db.update(viewings).set({ reminderDaySentAt: now });
    await rescheduleViewing(db, token, slots[3]!.start, now);
    const [v] = await db.select().from(viewings);
    expect(v).toMatchObject({ startsAt: slots[3]!.start, reminderDaySentAt: null });
    // Back to the first time: free again now that the viewing left it.
    await rescheduleViewing(db, token, slots[0]!.start, now);
    // A time outside the free ones is refused.
    await expect(
      rescheduleViewing(db, token, new Date("2026-10-26T01:00:00Z"), now),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    const events = (await db.select({ name: jobRuns.name, payload: jobRuns.payload }).from(jobRuns))
      .filter((j) => j.name === "viewing.notify")
      .map((j) => (j.payload as { event: string }).event);
    expect(events.filter((e) => e === "rescheduled")).toHaveLength(2);
  });

  it("cancels once, frees the time, and feedback opens only after the viewing", async () => {
    const { db, agent, slots, token } = await booked();
    await expect(saveViewingFeedback(db, token, 5, "Lovely", now)).rejects.toMatchObject({
      code: "LOCKED",
    });
    await cancelViewing(db, token, now);
    await cancelViewing(db, token, now); // a second click changes nothing
    const [v] = await db.select().from(viewings);
    expect(v!.status).toBe("cancelled");
    expect((await availableSlots(db, agent, now)).slots[0]!.start).toEqual(slots[0]!.start);
    await expect(rescheduleViewing(db, token, slots[1]!.start, now)).rejects.toMatchObject({
      code: "LOCKED",
    });

    // A viewing that happened: feedback is saved on it.
    await db.update(viewings).set({ status: "done" });
    const after = new Date(v!.endsAt.getTime() + 3_600_000);
    await saveViewingFeedback(db, token, 4, "Bright, a little noisy", after);
    const [rated] = await db.select().from(viewings);
    expect(rated).toMatchObject({ feedbackRating: 4, feedbackText: "Bright, a little noisy" });
  });
});
