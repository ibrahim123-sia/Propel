import "server-only";
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { z } from "zod";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { users } from "@/db/schema/auth";
import { reportDeliveries } from "@/db/schema/reports";
import { loadEmailBrand } from "@/emails/brand";
import { renderEmail } from "@/emails/render";
import { WeeklyReportEmail } from "@/emails/report-email";
import { queueEmail } from "@/features/notifications/email";
import { loadSettings } from "@/features/settings/queries";
import type { SettingsOf } from "@/features/settings/schema";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { format } from "@/lib/i18n";
import { reports as t } from "@/lib/i18n/dictionaries/reports";
import { localDateString } from "@/lib/local-date";
import { exportHref, reportHref } from "./build";
import { loadReportContext } from "./context";
import { formatChange, formatValue } from "./format";
import { overviewKpis } from "./overview";
import { addDays, type DateRange } from "./period";

/**
 * The weekly report email (09 §7 "schedule a weekly email report", 13 §2 weekly cron): on the
 * chosen day and hour in the agency's time zone, the overview of the 7 days before goes to the
 * chosen recipients with links to the report and its PDF.
 *
 * Never twice: `report_deliveries` has one row per week (unique on the period's first day),
 * written in the same transaction as the emails, so a second cron tick, a retried job or two
 * workers racing each other all end up sending nothing.
 */
export const WEEKLY_REPORT_JOB = "reports.weekly";

type WeeklySetting = SettingsOf<"notifications">["weeklyReport"];

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0 = Sunday) and hour of an instant in a time zone. */
export function localWeekdayHour(now: Date, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: WEEKDAYS[get("weekday")] ?? 0, hour: Number(get("hour")) };
}

/**
 * Due on the chosen weekday from the chosen hour to the end of that day, so a missed hourly
 * tick is caught up the same day (the delivery row stops repeats).
 */
export function weeklyReportDue(setting: WeeklySetting, local: { weekday: number; hour: number }) {
  return setting.enabled && local.weekday === setting.weekday && local.hour >= setting.hour;
}

/** The 7 days before the send day. */
export function weeklyReportPeriod(today: string): DateRange {
  return { from: addDays(today, -7), to: addDays(today, -1) };
}

async function alreadySent(db: Db, periodStart: string): Promise<boolean> {
  const [row] = await db
    .select({ id: reportDeliveries.id })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.agencyId, currentAgencyId()),
        eq(reportDeliveries.kind, "weekly"),
        eq(reportDeliveries.periodStart, periodStart),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Hourly cron: queues this week's report job when it is due and not sent yet. */
export async function queueWeeklyReport(
  db: Db,
  now: Date = new Date(),
): Promise<{ queued: boolean; period?: DateRange }> {
  const [general, notifications] = [
    await loadSettings("general", db),
    await loadSettings("notifications", db),
  ];
  if (!weeklyReportDue(notifications.weeklyReport, localWeekdayHour(now, general.timeZone)))
    return { queued: false };
  const period = weeklyReportPeriod(localDateString(now, general.timeZone));
  if (await alreadySent(db, period.from)) return { queued: false, period };
  const id = await enqueue(WEEKLY_REPORT_JOB, period, {
    db,
    dedupeKey: `${WEEKLY_REPORT_JOB}:${period.from}`,
    maxAttempts: 3,
  });
  return { queued: id !== null, period };
}

/** The chosen recipients, or every active admin (not the read-only demo viewer). */
async function recipientsFor(db: Db, setting: WeeklySetting): Promise<string[]> {
  if (setting.recipients.length)
    return [...new Set(setting.recipients.map((e) => e.toLowerCase()))];
  return activeAdminEmails(db);
}

/** Every active admin's email, without the read-only demo viewer. */
export async function activeAdminEmails(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.agencyId, currentAgencyId()),
        eq(users.role, "admin"),
        eq(users.isActive, true),
        eq(users.readOnly, false),
      ),
    );
  return [...new Set(rows.map((r) => r.email.toLowerCase()))].sort();
}

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

export type WeeklySendResult =
  | { sent: number; recipients: string[]; period: DateRange }
  | { skipped: "already sent" | "no recipients"; period: DateRange };

/** Builds the overview for the week and queues one email per recipient, once per week. */
export async function sendWeeklyReport(
  db: Db,
  period: DateRange,
  now: Date = new Date(),
): Promise<WeeklySendResult> {
  if (await alreadySent(db, period.from)) return { skipped: "already sent", period };
  const [general, notifications] = [
    await loadSettings("general", db),
    await loadSettings("notifications", db),
  ];
  const recipients = await recipientsFor(db, notifications.weeklyReport);
  if (recipients.length === 0) return { skipped: "no recipients", period };

  const ctx = await loadReportContext(db, { period: "custom", ...period }, now);
  const kpis = await overviewKpis(db, ctx);
  const brand = await loadEmailBrand(db);
  const query = { period: "custom", from: period.from, to: period.to };
  const from = dayLabel(period.from);
  const to = dayLabel(period.to);
  const value = (key: string) => {
    const k = kpis.find((x) => x.key === key);
    return k ? formatValue(k.value, k.format, ctx.currency) : "–";
  };
  const subject = format(t.weekly.subject, { agency: general.agencyName, from, to });
  const { html, text } = await renderEmail(
    createElement(WeeklyReportEmail, {
      brand,
      preview: format(t.weekly.preview, {
        leads: value("leads"),
        viewings: value("viewings"),
        won: value("won"),
      }),
      heading: t.weekly.heading,
      intro: format(t.weekly.intro, { from, to }),
      kpis: kpis.map((k) => ({
        label: k.label,
        value: formatValue(k.value, k.format, ctx.currency),
        change: k.change
          ? `${formatChange(k.change, k.format, ctx.currency)} ${t.kpis.vsPrevious}`
          : (k.hint ?? null),
      })),
      reportUrl: `${brand.appUrl}${reportHref("overview", query)}`,
      reportLabel: t.weekly.openReport,
      pdfUrl: `${brand.appUrl}${exportHref("overview", "pdf", query)}`,
      pdfLabel: t.weekly.downloadPdf,
      note: t.weekly.signInNote,
    }),
  );

  return db.transaction(async (tx): Promise<WeeklySendResult> => {
    const inserted = await tx
      .insert(reportDeliveries)
      .values({
        kind: "weekly",
        periodStart: period.from,
        periodEnd: period.to,
        recipients,
        emailCount: recipients.length,
        sentAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: reportDeliveries.id });
    if (inserted.length === 0) return { skipped: "already sent", period };
    for (const to of recipients)
      await queueEmail(
        {
          to,
          subject,
          template: "report.weekly",
          html,
          text,
          related: { type: "report_delivery", id: inserted[0]!.id },
        },
        tx,
      );
    return { sent: recipients.length, recipients, period };
  });
}

export const weeklyReportJob = defineJob({
  name: WEEKLY_REPORT_JOB,
  payload: z.object({ from: z.iso.date(), to: z.iso.date() }).strict(),
  maxAttempts: 3,
  run: async (period, { db }) => sendWeeklyReport(db, period),
});
