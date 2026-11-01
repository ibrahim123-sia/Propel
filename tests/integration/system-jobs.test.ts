import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema/auth";
import { contacts, conversations, leads, messages, visitorEvents, visitors } from "@/db/schema/crm";
import { emailLog, secrets } from "@/db/schema/system";
import { queueDailySummary } from "@/features/reports/daily";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { setSecret } from "@/features/settings/secrets";
import { recordIntegrationResult, remindExchangeRates } from "@/features/system/alerts";
import { ANONYMISED_NAME, runRetention } from "@/features/system/retention";
import { integrationStatus } from "@/features/system/queries";
import { cronTasks } from "@/jobs/cron";
import { runDueJobs } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };

beforeEach(async () => {
  await truncate(
    "email_log",
    "job_runs",
    "report_deliveries",
    "messages",
    "conversations",
    "lead_events",
    "leads",
    "contacts",
    "visitor_events",
    "visitors",
    "secrets",
    "settings",
    "users",
  );
  const db = await getDb();
  await db.insert(users).values([
    { id: newId(), email: "owner@agency.example", name: "Owner", role: "admin" },
    { id: newId(), email: "viewer@agency.example", name: "Viewer", role: "admin", readOnly: true },
    { id: newId(), email: "gone@agency.example", name: "Gone", role: "admin", isActive: false },
  ]);
  await patchSettings(db, "general", { timeZone: "Asia/Dubai", agencyName: "Haven & Dune" }, actor);
});

const sentWith = async (template: string) =>
  (await (await getDb()).select().from(emailLog).where(eq(emailLog.template, template))).map(
    (e) => ({ to: e.to, subject: e.subject }),
  );

describe("daily summary email (13 §3)", () => {
  it("goes to active admins once a day, from the time in Settings -> Notifications", async () => {
    const db = await getDb();
    await patchSettings(db, "notifications", { dailySummaryTime: "08:00" }, actor);
    // 07:55 in Dubai: too early.
    expect(await queueDailySummary(db, new Date("2026-10-24T03:55:00Z"))).toEqual({
      queued: false,
    });
    expect(await queueDailySummary(db, new Date("2026-10-24T04:05:00Z"))).toEqual({
      queued: true,
      day: "2026-10-23",
    });
    expect((await queueDailySummary(db, new Date("2026-10-24T04:10:00Z"))).queued).toBe(false);
    await runDueJobs();
    expect(await sentWith("report.daily")).toEqual([
      { to: "owner@agency.example", subject: "Haven & Dune: daily summary for Fri 23 Oct" },
    ]);
    // Later ticks that day send nothing; the next day sends again.
    expect((await queueDailySummary(db, new Date("2026-10-24T12:00:00Z"))).queued).toBe(false);
    expect((await queueDailySummary(db, new Date("2026-10-25T04:05:00Z"))).queued).toBe(true);

    // Unticked in the notifications grid: never queued.
    const { admins } = await loadSettings("notifications", db);
    await patchSettings(
      db,
      "notifications",
      { admins: { ...admins, dailySummary: { email: false, whatsapp: false } } },
      actor,
    );
    expect((await queueDailySummary(db, new Date("2026-10-26T04:05:00Z"))).queued).toBe(false);
  });
});

describe("data retention (04 §11, 14 §3)", () => {
  it("removes old guest chats and visitor events, and anonymises people whose leads were lost long ago", async () => {
    const db = await getDb();
    await patchSettings(
      db,
      "legal",
      { retention: { guestChatMonths: 6, anonymiseLostLeadsMonths: 12 } },
      actor,
    );
    const now = new Date("2026-10-31T00:00:00Z");
    const old = new Date("2025-06-01T00:00:00Z");
    const recent = new Date("2026-10-01T00:00:00Z");

    // Guest chats: one old, one recent, and an old one that became a lead (kept).
    const [oldChat, newChat] = await db
      .insert(conversations)
      .values([
        { channel: "web_chat", lastMessageAt: old, createdAt: old },
        { channel: "web_chat", lastMessageAt: recent, createdAt: old },
      ])
      .returning();
    await db.insert(messages).values({
      conversationId: oldChat!.id,
      direction: "in",
      sender: "customer",
      body: "Hi",
    });

    // People: lost long ago (anonymised); lost long ago but another lead still open (kept);
    // lost recently (kept); has a customer account (kept: theirs to delete).
    const [gone, busy, fresh, member] = await db
      .insert(contacts)
      .values([
        { name: "Old Lost", email: "old@example.com", phone: "+971500000001", updatedAt: old },
        { name: "Busy Person", email: "busy@example.com", updatedAt: old },
        { name: "Fresh Lost", email: "fresh@example.com", updatedAt: old },
        {
          name: "Member",
          email: "member@example.com",
          updatedAt: old,
          userId: (await db.select().from(users).limit(1))[0]!.id,
        },
      ])
      .returning();
    await db.insert(leads).values([
      { contactId: gone!.id, source: "form", status: "lost", lostAt: old, updatedAt: old },
      { contactId: busy!.id, source: "form", status: "lost", lostAt: old, updatedAt: old },
      { contactId: busy!.id, source: "chat", status: "open" },
      { contactId: fresh!.id, source: "form", status: "lost", lostAt: recent },
      { contactId: member!.id, source: "form", status: "lost", lostAt: old, updatedAt: old },
    ]);
    const [goneChat] = await db
      .insert(conversations)
      .values({ channel: "web_chat", contactId: gone!.id, aiSummary: "Wants 2 beds" })
      .returning();
    await db.insert(messages).values({
      conversationId: goneChat!.id,
      direction: "in",
      sender: "customer",
      body: "Call me on 050 000 0001",
    });

    // Visitor events: one older than 180 days, one recent.
    const [visitor] = await db.insert(visitors).values({ visitorKey: "v-1" }).returning();
    await db.insert(visitorEvents).values([
      { visitorId: visitor!.id, type: "page_view", path: "/", createdAt: old },
      { visitorId: visitor!.id, type: "page_view", path: "/buy", createdAt: recent },
    ]);

    expect(await runRetention(db, now)).toEqual({
      guestChats: 1,
      anonymisedContacts: 1,
      visitorEvents: 1,
    });
    const chats = (await db.select().from(conversations)).map((c) => c.id);
    expect(chats).not.toContain(oldChat!.id);
    expect(chats).toEqual(expect.arrayContaining([newChat!.id, goneChat!.id]));
    const people = Object.fromEntries((await db.select().from(contacts)).map((c) => [c.id, c]));
    expect(people[gone!.id]).toMatchObject({ name: ANONYMISED_NAME, email: null, phone: null });
    expect(people[busy!.id]!.email).toBe("busy@example.com");
    expect(people[fresh!.id]!.email).toBe("fresh@example.com");
    expect(people[member!.id]!.email).toBe("member@example.com");
    const [said] = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, goneChat!.id));
    expect(said!.body).toBe("[removed]");
    expect((await db.select().from(visitorEvents)).map((e) => e.path)).toEqual(["/buy"]);

    // A second night finds nothing new.
    expect(await runRetention(db, now)).toEqual({
      guestChats: 0,
      anonymisedContacts: 0,
      visitorEvents: 0,
    });
    expect(cronTasks.find((t) => t.name === "data-retention")?.schedule).toBe("daily at 02:10");
  });
});

describe("integration error alerts (13 §3)", () => {
  it("emails admins when a working key starts failing, once a day, and shows it as failing", async () => {
    const db = await getDb();
    const { resend } = await loadSettings("integrations", db);
    await patchSettings(db, "integrations", { resend: { ...resend, enabled: true } }, actor);
    await setSecret(db, "resend_api_key", "re_test", actor);
    await recordIntegrationResult("resend_api_key", null, db);
    expect(await sentWith("system.integration_error")).toEqual([]);

    await recordIntegrationResult("resend_api_key", "Resend answered 401: API key is invalid", db);
    // Still failing on the next try: no second email.
    await recordIntegrationResult("resend_api_key", "Resend answered 401: API key is invalid", db);
    expect(await sentWith("system.integration_error")).toEqual([
      { to: "owner@agency.example", subject: "Email (Resend) is not working" },
    ]);
    const states = await integrationStatus(db);
    expect(states.find((s) => s.name === "Email (Resend)")).toMatchObject({
      state: "error",
      detail: "Resend answered 401: API key is invalid",
    });

    // Fixed, then broken again the same day: the day's email was already sent.
    await recordIntegrationResult("resend_api_key", null, db);
    await recordIntegrationResult("resend_api_key", "Timeout", db);
    expect(await sentWith("system.integration_error")).toHaveLength(1);
    const [row] = await db.select().from(secrets).where(eq(secrets.key, "resend_api_key"));
    expect(row!.lastError).toBe("Timeout");
  });
});

describe("exchange-rate reminder (13 §2 monthly)", () => {
  it("reminds admins when visitor currencies' rates are a month old, not when they are fresh", async () => {
    const db = await getDb();
    const now = new Date("2026-11-01T05:00:00Z");
    expect(await remindExchangeRates(db, now)).toEqual({
      sent: 0,
      reason: "no other currencies",
    });
    const usd = { code: "USD", symbol: "$", symbolPosition: "before", decimals: 2 } as const;
    await patchSettings(
      db,
      "market",
      {
        baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
        visitorCurrencies: [{ ...usd, rate: 0.27, isExample: false }],
        ratesUpdatedAt: "2026-10-20T00:00:00.000Z",
      },
      actor,
    );
    expect(await remindExchangeRates(db, now)).toEqual({ sent: 0, reason: "rates are recent" });
    await patchSettings(db, "market", { ratesUpdatedAt: "2026-09-01T00:00:00.000Z" }, actor);
    expect(await remindExchangeRates(db, now)).toEqual({ sent: 1 });
    // The cron firing twice the same month sends nothing more.
    expect(await remindExchangeRates(db, now)).toEqual({ sent: 0 });
    expect(await sentWith("system.rates_reminder")).toEqual([
      { to: "owner@agency.example", subject: "Time to check the exchange rates" },
    ]);
  });
});
