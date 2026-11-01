import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { GET as exportReport } from "@/app/api/admin/reports/[report]/route";
import { getDb } from "@/db/client";
import { aiUsage } from "@/db/schema/ai";
import { currentAgencyId } from "@/db/schema/_common";
import {
  contacts,
  conversations,
  leadEvents,
  leads,
  messages,
  viewings,
  type Touch,
} from "@/db/schema/crm";
import { leadStages } from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { priceHistory, properties, propertyDailyStats } from "@/db/schema/properties";
import { reportDeliveries } from "@/db/schema/reports";
import { auditLog, emailLog, jobRuns } from "@/db/schema/system";
import { buildReport } from "@/features/reports/build";
import { queueWeeklyReport, sendWeeklyReport } from "@/features/reports/weekly";
import type { ReportData, ReportTable } from "@/features/reports/types";
import { patchSettings } from "@/features/settings/mutations";
import { runDueJobs } from "@/jobs/runner";
import { parseCsv } from "@/lib/csv";
import { newId } from "@/lib/ids";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
// "Now" for the reports: 24 Oct 2026, noon in Dubai.
const now = new Date("2026-10-24T08:00:00Z");
// 1-7 Oct 2026 in Dubai (UTC+4); the previous period is 24-30 Sep.
const week = { period: "custom", from: "2026-10-01", to: "2026-10-07" };

const ids = {
  agentA: newId(),
  agentB: newId(),
  agentIdle: newId(),
  agentGone: newId(),
  stage: {
    new: newId(),
    contacted: newId(),
    viewing: newId(),
    offer: newId(),
    won: newId(),
    lost: newId(),
  },
  l1: newId(),
  l2: newId(),
  l3: newId(),
  l4: newId(),
  l5: newId(),
  p1: newId(),
  p2: newId(),
  p5: newId(),
};

const google: Touch = {
  utm_source: "google",
  utm_medium: "cpc",
  utm_campaign: "marina-2bed",
  landing_path: "/",
  channel: "paid_search",
  at: "2026-10-01T00:00:00Z",
};

const tables = (data: ReportData) => Object.fromEntries(data.tables.map((t) => [t.id, t]));
const rowsOf = (table: ReportTable) => Object.fromEntries(table.rows.map((r) => [r.key, r.cells]));
const kpis = (data: ReportData) => Object.fromEntries(data.kpis.map((k) => [k.key, k]));

async function seed() {
  const db = await getDb();
  await patchSettings(
    db,
    "general",
    { timeZone: "Asia/Dubai", agencyName: "Propel Demo Homes" },
    actor,
  );
  await patchSettings(
    db,
    "market",
    {
      baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
      visitorCurrencies: [
        {
          code: "USD",
          symbol: "$",
          symbolPosition: "before",
          decimals: 2,
          rate: 0.25,
          isExample: false,
        },
      ],
    },
    actor,
  );
  await db.insert(agents).values([
    { id: ids.agentA, name: "Agent Amal", slug: "agent-amal", sortOrder: 0 },
    { id: ids.agentB, name: "Agent Bilal", slug: "agent-bilal", sortOrder: 1 },
    { id: ids.agentIdle, name: "Agent Idle", slug: "agent-idle", sortOrder: 2 },
    { id: ids.agentGone, name: "Agent Gone", slug: "agent-gone", isActive: false, sortOrder: 3 },
  ]);
  const s = ids.stage;
  await db.insert(leadStages).values([
    { id: s.new, name: "Fresh", kind: "open", sortOrder: 0 },
    { id: s.contacted, name: "Talking", kind: "open", sortOrder: 1 },
    { id: s.viewing, name: "Touring", kind: "open", sortOrder: 2 },
    { id: s.offer, name: "Negotiating", kind: "open", sortOrder: 3 },
    { id: s.won, name: "Done deal", kind: "won", sortOrder: 4 },
    { id: s.lost, name: "Gone", kind: "lost", sortOrder: 5 },
  ]);
  const [c] = await db.insert(contacts).values({ name: "Demo Contact" }).returning();
  const at = (iso: string) => new Date(iso);
  const minutes = (iso: string, n: number) => new Date(at(iso).getTime() + n * 60_000);
  const base = { contactId: c!.id, source: "form" as const };
  await db.insert(leads).values([
    // 1 Oct 00:30 Dubai (30 Sep 20:30 UTC): inside. Answered in 10 minutes.
    {
      ...base,
      id: ids.l1,
      agentId: ids.agentA,
      stageId: s.contacted,
      firstTouch: google,
      lastTouch: google,
      createdAt: at("2026-09-30T20:30:00Z"),
      firstResponseAt: minutes("2026-09-30T20:30:00Z", 10),
    },
    // 3 Oct: chat lead, answered in 2 hours, won on 5 Oct for AED 1,000,000.
    {
      ...base,
      id: ids.l2,
      source: "chat",
      agentId: ids.agentA,
      stageId: s.won,
      status: "won",
      dealValue: 100_000_000,
      dealCurrency: "AED",
      wonAt: at("2026-10-05T08:00:00Z"),
      createdAt: at("2026-10-03T06:00:00Z"),
      firstResponseAt: minutes("2026-10-03T06:00:00Z", 120),
    },
    // 7 Oct 23:59 Dubai: the last minute of the period. Never answered.
    {
      ...base,
      id: ids.l3,
      source: "portal",
      agentId: ids.agentB,
      stageId: s.new,
      createdAt: at("2026-10-07T19:59:00Z"),
    },
    // 2 Oct: nobody's lead, answered in 30 minutes, got to an offer, then lost.
    {
      ...base,
      id: ids.l4,
      stageId: s.lost,
      status: "lost",
      lostReason: "Budget",
      createdAt: at("2026-10-02T06:00:00Z"),
      firstResponseAt: minutes("2026-10-02T06:00:00Z", 30),
    },
    // 30 Sep 23:30 Dubai: the previous period. Won the same day for USD 100,000.
    {
      ...base,
      id: ids.l5,
      agentId: ids.agentB,
      stageId: s.won,
      status: "won",
      dealValue: 10_000_000,
      dealCurrency: "USD",
      wonAt: at("2026-09-30T19:45:00Z"),
      createdAt: at("2026-09-30T19:30:00Z"),
      firstResponseAt: minutes("2026-09-30T19:30:00Z", 5),
    },
    // 8 Oct 00:00 Dubai: just outside. Still waiting for a reply.
    { ...base, agentId: ids.agentA, createdAt: at("2026-10-07T20:00:00Z") },
  ]);
  // A merged duplicate inside the period never counts.
  await db.insert(leads).values({
    ...base,
    mergedIntoId: ids.l1,
    createdAt: at("2026-10-02T06:00:00Z"),
  });
  await db.insert(leadEvents).values({
    leadId: ids.l4,
    type: "stage_changed",
    meta: { from: null, to: { id: s.offer, name: "Negotiating" }, kind: "open" },
    createdAt: at("2026-10-03T06:00:00Z"),
  });
  const viewing = (
    leadId: string,
    startsAt: string,
    status: "done" | "cancelled" | "confirmed",
    agentId: string,
  ) => ({
    leadId,
    contactId: c!.id,
    agentId,
    startsAt: at(startsAt),
    endsAt: minutes(startsAt, 30),
    status,
  });
  await db.insert(viewings).values([
    viewing(ids.l2, "2026-10-04T06:00:00Z", "done", ids.agentA),
    viewing(ids.l2, "2026-10-05T06:00:00Z", "cancelled", ids.agentA),
    // 8 Oct 00:30 Dubai: outside the period, but it shows the lead got to a viewing.
    viewing(ids.l3, "2026-10-07T20:30:00Z", "confirmed", ids.agentB),
  ]);
  return { db, contactId: c!.id };
}

describe("reports (09 §7)", () => {
  let contactId: string;

  beforeAll(async () => {
    await truncate(
      "viewings",
      "lead_events",
      "messages",
      "conversations",
      "leads",
      "contacts",
      "lead_stages",
      "price_history",
      "property_daily_stats",
      "properties",
      "agents",
      "settings",
      "audit_log",
      "email_log",
      "job_runs",
      "report_deliveries",
      "ai_usage",
    );
    ({ contactId } = await seed());
  });

  beforeEach(() => {
    adminState.user = testAdmin;
  });

  it("overview: the period's numbers against the previous period, on local day boundaries", async () => {
    const { data } = await buildReport(await getDb(), "overview", week, { now });
    expect(data.period).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-07",
      previous: { from: "2026-09-24", to: "2026-09-30" },
    });
    const k = kpis(data);
    expect(k.leads).toMatchObject({ value: 4, previous: 1 });
    expect(k.leads!.change).toMatchObject({ delta: 3, ratio: 3 });
    expect(k.viewings).toMatchObject({ value: 1, previous: 0 });
    expect(k.won).toMatchObject({ value: 1, previous: 1 });
    // AED 1,000,000 now; USD 100,000 = AED 400,000 before.
    expect(k.dealValue).toMatchObject({ value: 100_000_000, previous: 40_000_000 });
    // (10 + 120 + 30) / 3 minutes = 53:20.
    expect(k.avgResponse).toMatchObject({ value: 3200, previous: 300, higherIsBetter: false });
    expect(k.conversion).toMatchObject({ value: 0.25, previous: 1 });
    // Open and unanswered now: the 7 Oct portal lead and the 8 Oct lead (not the duplicate).
    expect(k.unanswered).toMatchObject({ value: 2, previous: null, change: null });
    const trend = rowsOf(tables(data).trend!);
    expect(Object.keys(trend)).toHaveLength(7);
    expect(trend["2026-10-01"]).toMatchObject({ leads: 1, won: 0 });
    expect(trend["2026-10-05"]).toMatchObject({ leads: 0, won: 1 });
    expect(trend["2026-10-07"]).toMatchObject({ leads: 1 });
  });

  it("sources: by how they got in touch, and by campaign touch through the campaign report", async () => {
    const db = await getDb();
    const { data } = await buildReport(db, "sources", week, { now });
    const rows = rowsOf(tables(data).sources!);
    expect(rows.form).toMatchObject({ value: "Website form", leads: 2, viewings: 0, won: 0 });
    expect(rows.chat).toMatchObject({
      leads: 1,
      viewings: 1,
      won: 1,
      conversion: 1,
      dealValue: 100_000_000,
    });
    expect(rows.portal).toMatchObject({ leads: 1, viewings: 1 });
    expect(tables(data).sources!.total!.cells).toMatchObject({ leads: 4, won: 1 });
    const utm = await buildReport(
      db,
      "sources",
      { ...week, by: "source", touch: "first" },
      { now },
    );
    const utmRows = rowsOf(tables(utm.data).sources!);
    expect(utmRows.google).toMatchObject({ leads: 1 });
    expect(utmRows["(not tracked)"]).toMatchObject({ leads: 3 });
    expect(utm.query).toMatchObject({ by: "source", touch: "first" });
  });

  it("funnel: steps from stage kinds, stage history, replies, viewings and wins", async () => {
    const { data } = await buildReport(await getDb(), "funnel", week, { now });
    const overall = rowsOf(tables(data).funnel!);
    expect(Object.fromEntries(Object.entries(overall).map(([step, c]) => [step, c.leads]))).toEqual(
      { lead: 4, contacted: 4, viewing: 3, offer: 2, won: 1 },
    );
    expect(overall.viewing!.ofPrevious).toBe(0.75);
    const bySource = rowsOf(tables(data)["funnel-by-source"]!);
    // The lost lead reached the offer stage before it was lost.
    expect(bySource.form).toMatchObject({ lead: 2, contacted: 2, viewing: 1, offer: 1, won: 0 });
    expect(bySource.portal).toMatchObject({ lead: 1, contacted: 1, viewing: 1, offer: 0 });
    expect(bySource.chat).toMatchObject({ won: 1, conversion: 1 });
  });

  it("response time: distribution, unanswered, by agent and by hour in the agency time zone", async () => {
    const { data } = await buildReport(await getDb(), "response-time", week, { now });
    const k = kpis(data);
    expect(k.avg!.value).toBe(3200);
    expect(k.median!.value).toBe(1800);
    expect(k.answered!.value).toBe(0.75);
    expect(k.unanswered!.value).toBe(1);
    const dist = rowsOf(tables(data).distribution!);
    expect(dist.under15!.leads).toBe(1);
    expect(dist.under60!.leads).toBe(1);
    expect(dist.under240!.leads).toBe(1);
    expect(dist.none!.leads).toBe(1);
    expect(dist.under5!.leads).toBe(0);
    const byAgent = rowsOf(tables(data)["by-agent"]!);
    expect(byAgent[ids.agentA]).toMatchObject({ agent: "Agent Amal", leads: 2, avg: 3900 });
    expect(byAgent[ids.agentB]).toMatchObject({ leads: 1, answered: 0, unanswered: 1 });
    expect(byAgent.none).toMatchObject({ agent: "Not assigned", leads: 1 });
    const byHour = rowsOf(tables(data)["by-hour"]!);
    // 00:30 and 23:59 Dubai time, not UTC.
    expect(byHour["0"]).toMatchObject({ hour: "00:00", leads: 1 });
    expect(byHour["23"]).toMatchObject({ hour: "23:00", leads: 1, unanswered: 1 });
    expect(byHour["20"]!.leads).toBe(0);
  });

  it("agents: leads, viewings, wins and reply times per agent; active agents always listed", async () => {
    const { data } = await buildReport(await getDb(), "agents", week, { now });
    const table = tables(data).agents!;
    const rows = rowsOf(table);
    expect(rows[ids.agentA]).toMatchObject({
      leads: 2,
      viewings: 1,
      won: 1,
      dealValue: 100_000_000,
      avgResponse: 3900,
    });
    expect(rows[ids.agentB]).toMatchObject({ leads: 1, viewings: 0, won: 0, unanswered: 1 });
    expect(rows[ids.agentIdle]).toMatchObject({ leads: 0, viewings: 0, won: 0 });
    expect(rows[ids.agentGone]).toBeUndefined();
    expect(rows.none).toMatchObject({ agent: "Not assigned", leads: 1 });
    expect(table.total!.cells).toMatchObject({ leads: 4, viewings: 1, won: 1 });
    expect(table.rows.find((r) => r.key === ids.agentA)!.href).toBe(
      `/admin/leads?agent=${ids.agentA}&from=2026-10-01&to=2026-10-07`,
    );
  });

  it("listings: period counters, days on market, price cuts and stale listings", async () => {
    const db = await getDb();
    const listing = (id: string, ref: string, values: Partial<typeof properties.$inferInsert>) => ({
      id,
      reference: ref,
      title: `Listing ${ref}`,
      slug: ref.toLowerCase(),
      purpose: "sale" as const,
      ...values,
    });
    await db.insert(properties).values([
      listing(ids.p1, "KL-1", {
        status: "available",
        publishedAt: new Date("2026-06-01T08:00:00Z"),
        lastVerifiedAt: new Date("2026-10-20T08:00:00Z"),
      }),
      listing(ids.p2, "KL-2", {
        status: "reserved",
        publishedAt: new Date("2026-01-01T08:00:00Z"),
      }),
      listing(newId(), "KL-3", { status: "draft" }),
      listing(newId(), "KL-4", { status: "sold", publishedAt: new Date("2026-01-01T08:00:00Z") }),
      listing(ids.p5, "KL-5", {
        status: "available",
        publishedAt: new Date("2026-10-20T08:00:00Z"),
        lastVerifiedAt: new Date("2026-10-24T06:00:00Z"),
      }),
    ]);
    await db.insert(propertyDailyStats).values([
      { propertyId: ids.p1, date: "2026-10-02", views: 10, saves: 2, inquiries: 1 },
      { propertyId: ids.p1, date: "2026-10-09", views: 5, inquiries: 1 },
      { propertyId: ids.p2, date: "2026-08-01", views: 3, inquiries: 1 },
    ]);
    await db.insert(priceHistory).values([
      { propertyId: ids.p1, oldPrice: 300, newPrice: 290, currency: "AED" },
      { propertyId: ids.p1, oldPrice: 290, newPrice: 280, currency: "AED" },
      { propertyId: ids.p1, oldPrice: 280, newPrice: 310, currency: "AED" },
    ]);
    const { data, query } = await buildReport(db, "listings", { ...week, verified: "60" }, { now });
    expect(query).toMatchObject({ verified: "60", quiet: "30" });
    const t = tables(data);
    expect(t.listings!.rows.map((r) => r.cells.reference)).toEqual(["KL-1", "KL-2", "KL-5"]);
    expect(rowsOf(t.listings!)[ids.p1]).toMatchObject({
      views: 10,
      saves: 2,
      inquiries: 1,
      inquiryRate: 0.1,
      daysOnMarket: 145,
      priceReductions: 2,
    });
    expect(Object.keys(rowsOf(t.stale!))).toEqual([ids.p2]);
    expect(rowsOf(t.stale!)[ids.p2]!.reasons).toBe("never verified; no inquiries in 30 days");
    const k = kpis(data);
    expect(k.live!.value).toBe(3);
    expect(k.stale!.value).toBe(1);
    // A stricter verification rule flags the listing verified 4 days ago too.
    const strict = await buildReport(db, "listings", { ...week, verified: "3" }, { now });
    expect(rowsOf(tables(strict.data).stale!)[ids.p1]!.reasons).toBe("not verified in 3 days");
  });

  it("AI: an empty state until the assistant replies, then its conversations and bookings", async () => {
    const db = await getDb();
    const before = await buildReport(db, "ai", week, { now });
    expect(before.data.emptyState?.title).toBe("AI is not set up yet");
    const [conv] = await db
      .insert(conversations)
      .values({ channel: "web_chat", contactId, status: "human" })
      .returning();
    await db.insert(messages).values([
      {
        conversationId: conv!.id,
        direction: "out",
        sender: "ai",
        body: "Hello",
        createdAt: new Date("2026-10-02T06:00:00Z"),
      },
      {
        conversationId: conv!.id,
        direction: "out",
        sender: "admin",
        body: "Taking over",
        createdAt: new Date("2026-10-02T07:00:00Z"),
      },
    ]);
    await db.insert(viewings).values({
      contactId,
      startsAt: new Date("2026-10-10T06:00:00Z"),
      endsAt: new Date("2026-10-10T06:30:00Z"),
      source: "chat",
      createdAt: new Date("2026-10-02T06:05:00Z"),
    });
    // Estimated spend inside the period counts; a day outside it does not.
    await db.insert(aiUsage).values([
      { date: "2026-10-02", feature: "customer_chat", model: "m", costEstimateMicros: 1_234_567 },
      { date: "2026-10-03", feature: "summary", model: "m", costEstimateMicros: 765_433 },
      { date: "2026-09-20", feature: "customer_chat", model: "m", costEstimateMicros: 9_000_000 },
    ]);
    const after = await buildReport(db, "ai", week, { now });
    expect(after.data.emptyState).toBeUndefined();
    expect(kpis(after.data)).toMatchObject({
      handled: { value: 1 },
      handedOver: { value: 1 },
      viewings: { value: 1 },
    });
    const cost = after.data.tables[0]!.rows.find((r) => r.key === "cost")!;
    expect(cost.cells.value).toBe("USD 2.00");

    // Answers to visitor messages: one after a search, one without, one flagged as bad.
    const asked = newId();
    await db.insert(messages).values([
      {
        id: asked,
        conversationId: conv!.id,
        direction: "in",
        sender: "customer",
        body: "Two beds in the Marina?",
        createdAt: new Date("2026-10-03T06:00:00Z"),
      },
      {
        conversationId: conv!.id,
        direction: "out",
        sender: "ai",
        body: "Here are three homes.",
        inReplyTo: asked,
        toolCalls: [{ tool: "search_listings", summary: "3 homes" }],
        createdAt: new Date("2026-10-03T06:00:05Z"),
      },
      {
        conversationId: conv!.id,
        direction: "out",
        sender: "ai",
        body: "Would you like to buy or rent?",
        inReplyTo: asked,
        flaggedAt: new Date("2026-10-04T06:00:00Z"),
        flagNote: "Asked again what they had said",
        createdAt: new Date("2026-10-03T06:01:00Z"),
      },
    ]);
    const answered = await buildReport(db, "ai", week, { now });
    expect(kpis(answered.data)).toMatchObject({
      grounded: { value: 0.5, format: "percent" },
      flagged: { value: 1 },
    });
    const row = (key: string) =>
      answered.data.tables[0]!.rows.find((r) => r.key === key)!.cells.value;
    expect(row("answers")).toBe(2);
    expect(row("grounded")).toBe("1 (50%)");
  });

  it("exports CSV and PDF for admins only, and writes the audit log", async () => {
    const db = await getDb();
    const get = (report: string, query: string) =>
      exportReport(new Request(`http://localhost/api/admin/reports/${report}?${query}`), {
        params: Promise.resolve({ report }),
      });
    const res = await get("agents", "period=custom&from=2026-10-01&to=2026-10-07&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(
      "report-agents-2026-10-01-2026-10-07.csv",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = parseCsv(new TextDecoder().decode(bytes));
    expect(rows[0]).toEqual(["Agents"]);
    const header = rows.findIndex((r) => r[0] === "Agent");
    expect(rows[header]).toEqual([
      "Agent",
      "Leads",
      "Viewings",
      "Won",
      "Deal value (AED)",
      "Avg first response (minutes)",
      "Not answered",
    ]);
    expect(rows.find((r) => r[0] === "Agent Amal")).toEqual([
      "Agent Amal",
      "2",
      "1",
      "1",
      "1000000.00",
      "65",
      "0",
    ]);
    // Reports never carry a lead's personal details.
    expect(rows.flat().join(" ")).not.toContain("Demo Contact");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "report.export"));
    expect(audit).toMatchObject({ entityType: "report", actorId: testAdmin.id });
    expect(audit!.after).toMatchObject({ report: "agents", format: "csv", from: "2026-10-01" });

    const pdf = await get("overview", "period=custom&from=2026-10-01&to=2026-10-07&format=pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const pdfText = new TextDecoder("latin1").decode(new Uint8Array(await pdf.arrayBuffer()));
    expect(pdfText.startsWith("%PDF-")).toBe(true);

    expect((await get("nope", "format=csv")).status).toBe(404);
    expect((await get("overview", "format=xls")).status).toBe(400);
    adminState.user = null;
    expect((await get("overview", "format=csv")).status).toBe(401);
  }, 90_000);

  it("weekly email: queued on its day and hour, sent once per week however often it runs", async () => {
    const db = await getDb();
    await patchSettings(
      db,
      "notifications",
      {
        weeklyReport: {
          enabled: true,
          weekday: 1,
          hour: 8,
          recipients: ["owner@example.com", "team@example.com"],
        },
      },
      actor,
    );
    // Monday 19 Oct 2026: 07:00 in Dubai is too early, 08:00 is the time.
    expect(await queueWeeklyReport(db, new Date("2026-10-19T03:00:00Z"))).toEqual({
      queued: false,
    });
    const monday = new Date("2026-10-19T04:00:00Z");
    expect(await queueWeeklyReport(db, monday)).toEqual({
      queued: true,
      period: { from: "2026-10-12", to: "2026-10-18" },
    });
    // The next hourly tick while the job waits: nothing new.
    expect((await queueWeeklyReport(db, new Date("2026-10-19T05:00:00Z"))).queued).toBe(false);
    await runDueJobs();
    const sent = await db.select().from(emailLog).where(eq(emailLog.template, "report.weekly"));
    expect(sent.map((e) => e.to).sort()).toEqual(["owner@example.com", "team@example.com"]);
    expect(sent[0]!.subject).toBe("Propel Demo Homes: weekly report, 12 Oct 2026 to 18 Oct 2026");
    expect(sent[0]!.html).toContain("/admin/reports?period=custom&amp;from=2026-10-12");
    expect(sent[0]!.html).toContain("format=pdf");
    // After it went out: later ticks that day, and a retried job, send nothing.
    expect((await queueWeeklyReport(db, new Date("2026-10-19T09:00:00Z"))).queued).toBe(false);
    expect(await sendWeeklyReport(db, { from: "2026-10-12", to: "2026-10-18" })).toMatchObject({
      skipped: "already sent",
    });
    // Two runs racing for another week: one sends, the other finds the week taken.
    const other = { from: "2026-10-05", to: "2026-10-11" };
    const results = await Promise.all([sendWeeklyReport(db, other), sendWeeklyReport(db, other)]);
    expect(results.filter((r) => "sent" in r)).toHaveLength(1);
    const deliveries = await db.select().from(reportDeliveries);
    expect(deliveries.map((d) => d.periodStart).sort()).toEqual(["2026-10-05", "2026-10-12"]);
    expect(
      (await db.select().from(emailLog).where(eq(emailLog.template, "report.weekly"))).length,
    ).toBe(4);
    const runs = await db.select().from(jobRuns).where(eq(jobRuns.name, "reports.weekly"));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
  });
  it("period filters can use the lead indexes (EXPLAIN)", async () => {
    const db = await getDb();
    // Tables this small are always scanned; with scans off the planner shows the index fits.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const res = await tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select count(*) from leads l
        where l.agency_id = ${currentAgencyId()}::uuid and l.merged_into_id is null
          and l.created_at >= '2026-09-30T20:00:00Z'::timestamptz
          and l.created_at < '2026-10-07T20:00:00Z'::timestamptz`);
      const won = await tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select count(*) from leads w
        where w.agency_id = ${currentAgencyId()}::uuid and w.status = 'won'
          and w.won_at is not null
          and w.won_at >= '2026-09-30T20:00:00Z'::timestamptz
          and w.won_at < '2026-10-07T20:00:00Z'::timestamptz`);
      return [...res.rows, ...won.rows].map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("leads_created_idx");
    expect(plan).toContain("leads_won_idx");
  });
});
