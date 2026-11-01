import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { calendarBusy, calendarConnections, viewings } from "@/db/schema/crm";
import { agents } from "@/db/schema/people";
import { properties } from "@/db/schema/properties";
import { auditLog } from "@/db/schema/system";
import {
  CalendarApiError,
  setCalendarApi,
  type CalendarApi,
  type CalendarEvent,
} from "@/features/integrations/google-calendar/api";
import {
  agentFromState,
  completeConnect,
  connectUrl,
  disconnectCalendar,
  refreshCalendarBusy,
  syncViewingEvent,
  testGoogleCalendar,
} from "@/features/integrations/google-calendar/calendar";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { setSecret } from "@/features/settings/secrets";
import { availableSlots } from "@/features/viewings/availability";
import { bookViewing } from "@/features/viewings/book";
import { cancelViewing, rescheduleViewing } from "@/features/viewings/manage";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
// Monday 26 October 2026, 08:00 in Dubai.
const now = new Date("2026-10-26T04:00:00Z");

type Call = { op: string; args: unknown[] };
function fakeApi(calls: Call[], busy: Awaited<ReturnType<CalendarApi["busy"]>> = []): CalendarApi {
  let n = 0;
  return {
    async exchangeCode(input) {
      calls.push({ op: "exchange", args: [input.code] });
      return {
        accessToken: "access-1",
        refreshToken: input.code === "no-refresh" ? null : "refresh-1",
        expiresIn: 3600,
        scope: "calendar.events",
        email: "layla@gmail.example",
      };
    },
    async refresh(input) {
      calls.push({ op: "refresh", args: [input.refreshToken] });
      if (input.refreshToken === "propel-connection-test")
        throw new CalendarApiError("Google answered 400: invalid_grant", 400);
      return { accessToken: `access-${calls.length}`, expiresIn: 3600, scope: null };
    },
    async revoke(token) {
      calls.push({ op: "revoke", args: [token] });
    },
    async busy(token, calendarId, from, to) {
      calls.push({ op: "busy", args: [token, calendarId, from, to] });
      return busy;
    },
    async insertEvent(_token, _cal, event: CalendarEvent) {
      calls.push({ op: "insert", args: [event] });
      const id = `evt-${++n}`;
      return { id, meetUrl: event.meet ? `https://meet.google.com/${id}` : null };
    },
    async updateEvent(_token, _cal, id, event) {
      calls.push({ op: "update", args: [id, event] });
      return { id, meetUrl: event.meet ? `https://meet.google.com/${id}` : null };
    },
    async deleteEvent(_token, _cal, id) {
      calls.push({ op: "delete", args: [id] });
    },
  };
}

async function world(configured = true) {
  const db = await getDb();
  await patchSettings(db, "general", { timeZone: "Asia/Dubai" }, actor);
  await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
  if (configured) {
    await patchSettings(
      db,
      "integrations",
      { googleCalendar: { enabled: true, clientId: "client-1.apps.googleusercontent.com" } },
      actor,
    );
    await setSecret(db, "google_oauth_client_secret", "secret-1", actor);
  }
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
  return { db, agent, listing };
}

async function connect(db: Awaited<ReturnType<typeof getDb>>, agent: string) {
  const url = new URL(await connectUrl(db, agent));
  return completeConnect(db, { code: "code-1", state: url.searchParams.get("state"), actor });
}

describe("Google Calendar (13 §1)", () => {
  const calls: Call[] = [];
  beforeEach(async () => {
    calls.length = 0;
    setCalendarApi(fakeApi(calls));
    await truncate(
      "calendar_connections",
      "calendar_busy",
      "viewings",
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "properties",
      "agents",
      "job_runs",
      "email_log",
      "secrets",
      "settings",
      "audit_log",
    );
  });
  afterEach(() => setCalendarApi(null));

  it("connects an agent: consent link with signed state, tokens stored encrypted", async () => {
    const { db, agent } = await world();
    const url = new URL(await connectUrl(db, agent));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-1.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/integrations/google/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(await agentFromState(url.searchParams.get("state"))).toBe(agent);
    expect(await agentFromState("forged.state")).toBeNull();

    expect(await connect(db, agent)).toEqual({ agentId: agent, email: "layla@gmail.example" });
    const [conn] = await db.select().from(calendarConnections);
    expect(conn).toMatchObject({ agentId: agent, accountEmail: "layla@gmail.example" });
    expect(conn!.encryptedRefreshToken).not.toContain("refresh-1");
    expect((await db.select().from(agents))[0]).toMatchObject({ calendarConnected: true });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "agent.calendar_connect"));
    expect(audit).toBeTruthy();

    // Without offline access there is nothing to keep: refused.
    const again = new URL(await connectUrl(db, agent));
    await expect(
      completeConnect(db, { code: "no-refresh", state: again.searchParams.get("state"), actor }),
    ).rejects.toMatchObject({ code: "NO_REFRESH_TOKEN" });
  });

  it("busy times from the calendar block viewing slots, all-day events included", async () => {
    const { db, agent } = await world();
    await connect(db, agent);
    setCalendarApi(
      fakeApi(calls, [
        { start: new Date("2026-10-26T08:00:00Z"), end: new Date("2026-10-26T09:00:00Z") },
        { allDay: true, startDate: "2026-10-27", endDate: "2026-10-28" },
      ]),
    );
    expect(await refreshCalendarBusy(db, now)).toBe(1);
    expect(await db.select().from(calendarBusy)).toHaveLength(2);
    const slots = (await availableSlots(db, agent, now)).slots.map((s) => s.start.toISOString());
    // 12:00-13:00 Dubai is busy (with the buffer around it); Tuesday is busy all day.
    expect(slots).not.toContain("2026-10-26T08:00:00.000Z");
    expect(slots).not.toContain("2026-10-26T08:30:00.000Z");
    expect(slots.some((s) => s.startsWith("2026-10-27"))).toBe(false);
    expect(slots.some((s) => s.startsWith("2026-10-28"))).toBe(true);
    const [conn] = await db.select().from(calendarConnections);
    expect(conn!.lastSyncAt).toEqual(now);
  });

  it("the agent's calendar follows the viewing: created, moved, removed", async () => {
    const { db, agent, listing } = await world();
    await connect(db, agent);
    const slots = (await availableSlots(db, agent, now)).slots;
    const booked = await bookViewing(db, {
      propertyId: listing,
      type: "in_person",
      start: slots[0]!.start,
      name: "Sam",
      email: "sam@example.com",
      phone: "0501234567",
      notes: "Parking?",
      timeZone: null,
      now,
    });
    expect(await syncViewingEvent(db, booked.viewingId)).toEqual({ created: "evt-1" });
    const insert = calls.find((c) => c.op === "insert")!.args[0] as CalendarEvent;
    expect(insert).toMatchObject({
      summary: "Viewing: HD-2041 · Two bed · Sam",
      start: slots[0]!.start,
      viewingId: booked.viewingId,
    });
    expect(insert.description).toContain("Parking?");
    expect((await db.select().from(viewings))[0]!.googleEventId).toBe("evt-1");

    await rescheduleViewing(db, booked.manageToken, slots[3]!.start, now);
    expect(await syncViewingEvent(db, booked.viewingId)).toEqual({ updated: "evt-1" });
    await cancelViewing(db, booked.manageToken, now);
    expect(await syncViewingEvent(db, booked.viewingId)).toEqual({ removed: true });
    expect(calls.filter((c) => c.op === "delete").map((c) => c.args[0])).toEqual(["evt-1"]);
    expect((await db.select().from(viewings))[0]!.googleEventId).toBeNull();
  });

  it("a video viewing gets its Google Meet link from the event when Meet is the video tool", async () => {
    const { db, agent, listing } = await world();
    await connect(db, agent);
    const viewingSettings = await loadSettings("viewings", db);
    await patchSettings(db, "viewings", { ...viewingSettings, videoTool: "google_meet" }, actor);
    const slots = (await availableSlots(db, agent, now)).slots;
    const booked = await bookViewing(db, {
      propertyId: listing,
      type: "video",
      start: slots[0]!.start,
      name: "Sam",
      email: "sam@example.com",
      phone: "0501234567",
      notes: "",
      timeZone: null,
      now,
    });
    expect(await syncViewingEvent(db, booked.viewingId)).toEqual({
      created: "evt-1",
      meetUrl: "https://meet.google.com/evt-1",
    });
    expect((calls.find((c) => c.op === "insert")!.args[0] as CalendarEvent).meet).toBe(true);
    expect((await db.select().from(viewings))[0]!.meetingUrl).toBe("https://meet.google.com/evt-1");
    // Moved later: the link stays, Google is not asked for another one.
    await rescheduleViewing(db, booked.manageToken, slots[2]!.start, now);
    await syncViewingEvent(db, booked.viewingId);
    expect((calls.find((c) => c.op === "update")!.args[1] as CalendarEvent).meet).toBe(false);
    expect((await db.select().from(viewings))[0]!.meetingUrl).toBe("https://meet.google.com/evt-1");
  });

  it("refreshes an expired access token; disconnecting revokes and clears", async () => {
    const { db, agent } = await world();
    await connect(db, agent);
    await db.update(calendarConnections).set({ accessTokenExpiresAt: new Date(0) });
    await refreshCalendarBusy(db, now);
    expect(calls.some((c) => c.op === "refresh" && c.args[0] === "refresh-1")).toBe(true);
    const [conn] = await db.select().from(calendarConnections);
    expect(conn!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    await disconnectCalendar(db, agent, actor);
    expect(calls.some((c) => c.op === "revoke" && c.args[0] === "refresh-1")).toBe(true);
    expect(await db.select().from(calendarConnections)).toEqual([]);
    expect((await db.select().from(agents))[0]).toMatchObject({
      calendarConnected: false,
      googleCalendarId: null,
    });
  });

  it("not set up: nothing is called and nothing pretends to work", async () => {
    const { db, agent, listing } = await world(false);
    await expect(connectUrl(db, agent)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(await refreshCalendarBusy(db, now)).toBe(0);
    const start = (await availableSlots(db, agent, now)).slots[0]!.start;
    const booked = await bookViewing(db, {
      propertyId: listing,
      type: "in_person",
      start,
      name: "Sam",
      email: "",
      phone: "0501234567",
      notes: "",
      timeZone: null,
      now,
    });
    expect(await syncViewingEvent(db, booked.viewingId)).toEqual({ skipped: "not connected" });
    expect(calls).toEqual([]);
    expect(await testGoogleCalendar(db)).toEqual({
      ok: false,
      message: "Enter the OAuth client ID first.",
    });
  });

  it("Test connection: Google knows the OAuth client", async () => {
    const { db } = await world();
    expect(await testGoogleCalendar(db)).toMatchObject({ ok: true });
    setCalendarApi({
      ...fakeApi(calls),
      async refresh() {
        throw new CalendarApiError("Google answered 401: invalid_client", 401);
      },
    });
    expect(await testGoogleCalendar(db)).toEqual({
      ok: false,
      message: "Google answered 401: invalid_client",
    });
  });
});
