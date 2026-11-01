import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { z } from "zod";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { leads, viewings } from "@/db/schema/crm";
import { reportDeliveries } from "@/db/schema/reports";
import { loadEmailBrand } from "@/emails/brand";
import { renderEmail } from "@/emails/render";
import { WeeklyReportEmail } from "@/emails/report-email";
import { queueEmail } from "@/features/notifications/email";
import { loadSettings } from "@/features/settings/queries";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { format } from "@/lib/i18n";
import { reports as t } from "@/lib/i18n/dictionaries/reports";
import { localDateString } from "@/lib/local-date";
import { exportHref, reportHref } from "./build";
import { loadReportContext } from "./context";
import { formatChange, formatValue } from "./format";
import { overviewKpis } from "./overview";
import { addDays, utcBounds } from "./period";
import { activeAdminEmails } from "./weekly";

/**
 * The daily summary email to admins (04 §10, 13 §2 "Daily 06:00", 13 §3 "Daily summary: email
 * at set time"): yesterday's overview against the day before, plus today's viewings and the
 * leads still waiting for a first reply. Sent from the time in Settings -> Notifications
 * (agency time zone) when the admins' "Daily summary" email box is ticked; once per day, like
 * the weekly report (`report_deliveries`).
 */
export const DAILY_SUMMARY_JOB = "reports.daily";

/** "08:00" -> minutes after midnight. */
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

async function alreadySent(db: Db, day: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reportDeliveries.id })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.agencyId, currentAgencyId()),
        eq(reportDeliveries.kind, "daily"),
        eq(reportDeliveries.periodStart, day),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Every 5 minutes: queues yesterday's summary once the set time has passed today. */
export async function queueDailySummary(
  db: Db,
  now: Date = new Date(),
): Promise<{ queued: boolean; day?: string }> {
  const [general, notifications] = [
    await loadSettings("general", db),
    await loadSettings("notifications", db),
  ];
  if (!notifications.admins.dailySummary.email) return { queued: false };
  if (localMinutes(now, general.timeZone) < minutesOf(notifications.dailySummaryTime))
    return { queued: false };
  const day = addDays(localDateString(now, general.timeZone), -1);
  if (await alreadySent(db, day)) return { queued: false, day };
  const id = await enqueue(
    DAILY_SUMMARY_JOB,
    { day },
    { db, dedupeKey: `${DAILY_SUMMARY_JOB}:${day}`, maxAttempts: 3 },
  );
  return { queued: id !== null, day };
}

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

export type DailySendResult =
  | { sent: number; recipients: string[]; day: string }
  | { skipped: "already sent" | "no recipients"; day: string };

export async function sendDailySummary(
  db: Db,
  day: string,
  now: Date = new Date(),
): Promise<DailySendResult> {
  if (await alreadySent(db, day)) return { skipped: "already sent", day };
  const [general] = [await loadSettings("general", db)];
  const recipients = await activeAdminEmails(db);
  if (recipients.length === 0) return { skipped: "no recipients", day };

  const ctx = await loadReportContext(db, { period: "custom", from: day, to: day }, now);
  const kpis = await overviewKpis(db, ctx);
  const today = addDays(day, 1);
  const bounds = utcBounds({ from: today, to: today }, general.timeZone);
  const agency = currentAgencyId();
  const [counts] = (
    await db.execute<{ viewings: number; waiting: number }>(sql`
      select
        (select count(*)::int from ${viewings}
          where agency_id = ${agency} and status in ('requested', 'confirmed')
            and starts_at >= ${bounds.start}::timestamptz
            and starts_at < ${bounds.end}::timestamptz) as viewings,
        (select count(*)::int from ${leads}
          where agency_id = ${agency} and status = 'open' and merged_into_id is null
            and first_response_at is null) as waiting`)
  ).rows;

  const brand = await loadEmailBrand(db);
  const query = { period: "custom", from: day, to: day };
  const label = dayLabel(day);
  const value = (key: string) => {
    const k = kpis.find((x) => x.key === key);
    return k ? formatValue(k.value, k.format, ctx.currency) : "–";
  };
  const viewingsToday = String(counts?.viewings ?? 0);
  const waiting = String(counts?.waiting ?? 0);
  const { html, text } = await renderEmail(
    createElement(WeeklyReportEmail, {
      brand,
      preview: format(t.daily.preview, { leads: value("leads"), today: viewingsToday, waiting }),
      heading: t.daily.heading,
      intro: format(t.daily.intro, { day: label }),
      kpis: [
        { label: t.daily.viewingsToday, value: viewingsToday, change: null },
        { label: t.daily.waitingReply, value: waiting, change: null },
        ...kpis.map((k) => ({
          label: k.label,
          value: formatValue(k.value, k.format, ctx.currency),
          change: k.change
            ? `${formatChange(k.change, k.format, ctx.currency)} ${t.kpis.vsPrevious}`
            : (k.hint ?? null),
        })),
      ],
      reportUrl: `${brand.appUrl}${reportHref("overview", query)}`,
      reportLabel: t.weekly.openReport,
      pdfUrl: `${brand.appUrl}${exportHref("overview", "pdf", query)}`,
      pdfLabel: t.weekly.downloadPdf,
      note: t.weekly.signInNote,
    }),
  );
  const subject = format(t.daily.subject, { agency: general.agencyName, day: label });

  return db.transaction(async (tx): Promise<DailySendResult> => {
    const inserted = await tx
      .insert(reportDeliveries)
      .values({
        kind: "daily",
        periodStart: day,
        periodEnd: day,
        recipients,
        emailCount: recipients.length,
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: reportDeliveries.id });
    if (inserted.length === 0) return { skipped: "already sent", day };
    for (const to of recipients)
      await queueEmail(
        {
          to,
          subject,
          template: "report.daily",
          html,
          text,
          related: { type: "report_delivery", id: inserted[0]!.id },
        },
        tx,
      );
    return { sent: recipients.length, recipients, day };
  });
}

export const dailySummaryJob = defineJob({
  name: DAILY_SUMMARY_JOB,
  payload: z.object({ day: z.iso.date() }).strict(),
  maxAttempts: 3,
  run: async ({ day }, { db }) => sendDailySummary(db, day),
});
