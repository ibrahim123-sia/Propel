import "server-only";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { reports as t } from "@/lib/i18n/dictionaries/reports";
import { agency, num, within } from "./context";
import type { DateRange } from "./period";
import type { ReportContext, ReportData } from "./types";

export type AiReportNumbers = {
  /** False until the assistant has replied in any conversation (the report shows an empty state). */
  setUp: boolean;
  conversationsHandled: number;
  handedOver: number;
  viewingsBooked: number;
  /** The assistant's answers to visitor messages in the period (cards and notices left out). */
  answers: number;
  /** Of those, answers that used a lookup tool first (10 §6 "answer grounded rate"). */
  groundedAnswers: number;
  /** Of those, answers an admin flagged as bad in the inbox (10 §2). */
  flaggedAnswers: number;
  /** Estimated AI spend in the period (every AI feature), USD cents. */
  costCents: number | null;
};

/**
 * The AI report's numbers (09 §7 AI), in one function so the AI layer can fill in more:
 * - conversations handled: conversations where the assistant replied in the period;
 * - handed over: of those, the ones a person took over or that wait for a person;
 * - viewings booked by AI: viewings created in the period from the website chat or WhatsApp;
 * - AI cost: the estimated spend of every AI feature in the period (`ai_usage`, by the
 *   agency's calendar day).
 */
/** Tools that look something up: an answer after one of these is backed by data. */
export const GROUNDING_TOOLS = [
  "search_listings",
  "get_listing",
  "get_project",
  "nearby",
  "area_info",
  "answer_faq",
  "mortgage_estimate",
  "rental_return",
  "compare",
  "available_slots",
  "book_viewing",
  "send_brochure",
] as const;

export async function aiReportNumbers(
  db: DbOrTx,
  range: DateRange,
  timeZone: string,
): Promise<AiReportNumbers> {
  const any = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from messages m where m.agency_id = ${agency()} and m.sender = 'ai' limit 1
    ) x`);
  if (num(any.rows[0]?.n) === 0)
    return {
      setUp: false,
      conversationsHandled: 0,
      handedOver: 0,
      viewingsBooked: 0,
      answers: 0,
      groundedAnswers: 0,
      flaggedAnswers: 0,
      costCents: null,
    };
  const res = await db.execute<{
    handled: number;
    handed: number;
    viewings: number;
    micros: number;
    answers: number;
    grounded: number;
    flagged: number;
  }>(sql`
    with handled as (
      select distinct c.id, c.status
      from messages m join conversations c on c.id = m.conversation_id
      where m.agency_id = ${agency()} and m.sender = 'ai'
        and ${within(sql`m.created_at`, range, timeZone)}
    ), answers as (
      select m.tool_calls, m.flagged_at from messages m
      where m.agency_id = ${agency()} and m.sender = 'ai' and m.in_reply_to is not null
        and ${within(sql`m.created_at`, range, timeZone)}
    )
    select
      (select count(*) from answers)::int as answers,
      (select count(*) from answers a where exists (
        select 1 from jsonb_array_elements(a.tool_calls) e
        where e->>'tool' = any(${sql.raw(`array[${GROUNDING_TOOLS.map((x) => `'${x}'`).join(",")}]`)})))::int as grounded,
      (select count(*) from answers a where a.flagged_at is not null)::int as flagged,
      (select count(*) from handled)::int as handled,
      (select count(*) from handled h where h.status in ('needs_human', 'human')
        or exists (select 1 from messages a where a.conversation_id = h.id
          and a.sender = 'admin'))::int as handed,
      (select count(*) from viewings v where v.agency_id = ${agency()}
        and v.source in ('chat', 'whatsapp')
        and ${within(sql`v.created_at`, range, timeZone)})::int as viewings,
      (select coalesce(sum(u.cost_estimate_micros), 0) from ai_usage u
        where u.agency_id = ${agency()} and u.date >= ${range.from}::date
          and u.date <= ${range.to}::date) as micros`);
  const r = res.rows[0]!;
  return {
    setUp: true,
    conversationsHandled: num(r.handled),
    handedOver: num(r.handed),
    viewingsBooked: num(r.viewings),
    answers: num(r.answers),
    groundedAnswers: num(r.grounded),
    flaggedAnswers: num(r.flagged),
    costCents: Math.round(num(r.micros) / 10_000),
  };
}

export async function aiReport(db: DbOrTx, ctx: ReportContext): Promise<ReportData> {
  const n = await aiReportNumbers(db, ctx.period, ctx.timeZone);
  const base: ReportData = {
    key: "ai",
    title: t.nav.ai,
    period: ctx.period,
    kpis: [],
    charts: [],
    tables: [],
    notes: t.ai.notes,
  };
  if (!n.setUp)
    return { ...base, emptyState: { title: t.ai.notSetUp, description: t.ai.notSetUpBody } };
  const k = t.ai.kpis;
  const kpi = (key: string, label: string, value: number, higherIsBetter = true) => ({
    key,
    label,
    format: "int" as const,
    value,
    previous: null,
    change: null,
    higherIsBetter,
  });
  return {
    ...base,
    kpis: [
      kpi("handled", k.handled, n.conversationsHandled),
      kpi("handedOver", k.handedOver, n.handedOver, false),
      kpi("viewings", k.viewings, n.viewingsBooked),
      {
        ...kpi("grounded", k.grounded, n.answers ? n.groundedAnswers / n.answers : 0),
        format: "percent" as const,
      },
      kpi("flagged", k.flagged, n.flaggedAnswers, false),
    ],
    tables: [
      {
        id: "ai",
        title: t.ai.table,
        columns: [
          { key: "metric", label: t.ai.columns.metric, format: "text" },
          { key: "value", label: t.ai.columns.value, format: "int" },
        ],
        rows: [
          { key: "handled", cells: { metric: k.handled, value: n.conversationsHandled } },
          { key: "handedOver", cells: { metric: k.handedOver, value: n.handedOver } },
          { key: "viewings", cells: { metric: k.viewings, value: n.viewingsBooked } },
          { key: "answers", cells: { metric: k.answers, value: n.answers } },
          {
            key: "grounded",
            cells: {
              metric: k.grounded,
              value: n.answers
                ? `${n.groundedAnswers} (${Math.round((n.groundedAnswers / n.answers) * 100)}%)`
                : "0",
            },
          },
          { key: "flagged", cells: { metric: k.flagged, value: n.flaggedAnswers } },
          {
            key: "cost",
            cells: {
              metric: k.cost,
              value:
                n.costCents === null
                  ? t.ai.costNotRecorded
                  : `USD ${(n.costCents / 100).toFixed(2)}`,
            },
          },
        ],
        empty: "",
      },
    ],
  };
}
