import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { queueIdleSummaries } from "@/features/ai/assistant/summary";
import { TOPICS_JOB } from "@/features/ai/topics";
import { queueEmbeddingBackfill } from "@/features/ai/embeddings";
import { runAlertDigest } from "@/features/alerts/jobs";
import { jobRuns } from "@/db/schema/system";
import { publishDuePages } from "@/features/cms/schedule";
import { publishDueContent } from "@/features/content/schedule";
import { alertUnansweredLeads } from "@/features/leads/process";
import { cleanupStaleUploads } from "@/features/media/maintenance";
import { recountAllMediaUsage } from "@/features/media/usage";
import { refreshStalePois, refreshStaleProjectPois } from "@/features/pois/distances";
import { dailyListingMaintenance } from "@/features/properties/maintenance";
import { CRAWL_JOB } from "@/features/seo/crawl-job";
import { pruneNotFound } from "@/features/seo/not-found-log";
import { queueDailySummary } from "@/features/reports/daily";
import { queueNightlyDemoReset } from "@/features/demo/reset";
import { queueWeeklyReport } from "@/features/reports/weekly";
import { remindExchangeRates } from "@/features/system/alerts";
import { runRetention } from "@/features/system/retention";
import { enqueue } from "./enqueue";
import { loadSettings } from "@/features/settings/queries";
import { queueViewingReminders } from "@/features/viewings/notify";
import { refreshCalendarBusy } from "@/features/integrations/google-calendar/calendar";
import { newId } from "@/lib/ids";
import { log } from "@/lib/log";
import { purgeExpired } from "@/lib/rate-limit";
import { computeLastMonthPriceStats } from "@/features/price-trends/compute";
import { requeueStuckJobs, runDueJobs } from "./runner";

/**
 * Scheduled work (13-integrations-and-jobs.md §2 "Cron jobs"). Cloudflare fires one trigger
 * every minute; each task says when it is due in the agency's own time zone, so "daily at
 * 06:00 agency time" works in any market.
 */
export type LocalTime = { hour: number; minute: number; weekday: number; day: number };

export type CronTask = {
  name: string;
  /** When it runs, for the System page ("every minute", "daily at 02:00"). */
  schedule: string;
  due: (t: LocalTime) => boolean;
  run: () => Promise<unknown>;
  /** Every-minute housekeeping is not logged, or the Jobs page would drown in it. */
  quiet?: boolean;
};

export const at =
  (hour: number, minute = 0) =>
  (t: LocalTime) =>
    t.hour === hour && t.minute === minute;
export const every = (minutes: number) => (t: LocalTime) =>
  (t.hour * 60 + t.minute) % minutes === 0;

export const cronTasks: CronTask[] = [
  // Every minute: queued jobs whose time has come (retries, delayed jobs, lost messages).
  {
    name: "jobs.run-due",
    schedule: "every minute",
    due: () => true,
    run: () => runDueJobs(),
    quiet: true,
  },
  // Every minute: scheduled posts and area guides go on the site at their time (08 §3).
  {
    name: "content.publish-scheduled",
    schedule: "every minute",
    due: () => true,
    run: async () => publishDueContent(await getDb()),
    quiet: true,
  },
  // 09 §3.8: leads nobody answered in time alert the team once.
  {
    name: "leads.response-timer",
    schedule: "every minute",
    due: () => true,
    run: async () => alertUnansweredLeads(await getDb()),
    quiet: true,
  },
  // 10 §2: chats with the assistant, quiet for 15 minutes, get a summary and a new score.
  {
    name: "ai.conversation-summaries",
    schedule: "every 5 minutes",
    due: every(5),
    run: async () => queueIdleSummaries(await getDb()),
    quiet: true,
  },
  // 13 §2: busy times from connected Google Calendars, for the free viewing slots.
  {
    name: "calendar.busy-refresh",
    schedule: "every 15 minutes",
    due: every(15),
    run: async () => refreshCalendarBusy(await getDb()),
    quiet: true,
  },
  // 13 §2: viewing reminders that are due.
  {
    name: "viewings.reminders",
    schedule: "every 10 minutes",
    due: every(10),
    run: async () => queueViewingReminders(await getDb()),
  },
  {
    name: "jobs.requeue-stuck",
    schedule: "every 15 minutes",
    due: every(15),
    run: () => requeueStuckJobs(),
  },
  // Pages scheduled in the page builder go live on the minute (08 §1).
  {
    name: "pages.publish-scheduled",
    schedule: "every minute",
    due: () => true,
    run: async () => publishDuePages(await getDb()),
    quiet: true,
  },
  {
    name: "media.cleanup",
    schedule: "every hour",
    due: every(60),
    run: () => cleanupStaleUploads(),
  },
  // 12 §3: saved-search digests at 06:00 agency time, daily, and weekly on Mondays.
  {
    name: "alerts.daily-digest",
    schedule: "daily at 06:00",
    due: at(6),
    run: async () => runAlertDigest(await getDb(), "daily"),
  },
  {
    name: "alerts.weekly-digest",
    schedule: "Mondays at 06:00",
    due: (t) => t.weekday === 1 && at(6)(t),
    run: async () => runAlertDigest(await getDb(), "weekly"),
  },
  // Just after midnight: featured dates end, automatic badges start and end (05 §3).
  {
    name: "listings.daily",
    schedule: "daily at 00:15",
    due: at(0, 15),
    run: async () => dailyListingMaintenance(await getDb()),
  },
  // Daily summary to admins (13 §3): checked every 5 minutes, sent once a day from the time
  // in Settings -> Notifications.
  {
    name: "reports.daily-summary",
    schedule: "every 5 minutes (sends once a day from the time in Settings -> Notifications)",
    due: every(5),
    run: async () => queueDailySummary(await getDb()),
    quiet: true,
  },
  // Daily 02:00-03:30: clean-ups and repairs.
  { name: "rate-limits.purge", schedule: "daily at 02:00", due: at(2), run: () => purgeExpired() },
  // 16 §3: the public demo goes back to the seed every night (Node hosts; on Cloudflare the
  // GitHub Action does it). Nothing happens unless DEMO_MODE=true.
  {
    name: "demo.reset",
    schedule: "daily at 02:30 (demo builds only)",
    due: at(2, 30),
    run: async () => queueNightlyDemoReset(await getDb()),
  },
  // 04 §11, 14 §3: old guest chats, lost leads past their months, visitor events after 180 days.
  {
    name: "data-retention",
    schedule: "daily at 02:10",
    due: at(2, 10),
    run: async () => runRetention(await getDb()),
  },
  {
    name: "seo.not-found-prune",
    schedule: "daily at 03:15",
    due: at(3, 15),
    run: async () => ({ removed: await pruneNotFound(await getDb()) }),
  },
  // 10 §1: the assistants' search index catches up with anything changed outside the admin.
  {
    name: "ai.embed-reconcile",
    schedule: "daily at 03:45",
    due: at(3, 45),
    run: async () => ({ queued: Boolean(await queueEmbeddingBackfill()) }),
  },
  {
    name: "media.recount",
    schedule: "daily at 03:30",
    due: at(3, 30),
    run: async () => recountAllMediaUsage(await getDb()),
  },
  // Weekly (10 §5): the last seven days of chat questions grouped into topics.
  {
    name: "ai.chat-topics",
    schedule: "weekly on Monday at 05:00",
    due: (t) => t.weekday === 1 && at(5)(t),
    run: async () => ({
      queued: (await enqueue(TOPICS_JOB, {}, { dedupeKey: TOPICS_JOB, maxAttempts: 2 })) !== null,
    }),
  },
  // Weekly: the SEO report's broken-link check (a queue job: it can take a few minutes).
  {
    name: "seo.crawl",
    schedule: "weekly on Monday at 04:30",
    due: (t) => t.weekday === 1 && at(4, 30)(t),
    run: async () => ({
      queued: (await enqueue(CRAWL_JOB, {}, { dedupeKey: CRAWL_JOB, maxAttempts: 2 })) !== null,
    }),
  },
  // Weekly report email (09 §7): checked hourly, sent on the day and hour in Settings ->
  // Notifications, once per week (the job records each week it sent).
  {
    name: "reports.weekly",
    schedule: "hourly (sends on the day and hour in Settings -> Notifications)",
    due: (t) => t.minute === 0,
    run: async () => queueWeeklyReport(await getDb()),
    quiet: true,
  },
  // Monthly (13 §2): last month's price trend figures from the agency's listings and deals (11 §7).
  {
    name: "price-stats.monthly",
    schedule: "monthly on the 1st at 03:00",
    due: (t) => t.day === 1 && at(3)(t),
    run: async () => computeLastMonthPriceStats(await getDb()),
  },
  // Monthly (13 §2): a reminder when the visitor currencies' display rates are a month old.
  {
    name: "rates.reminder",
    schedule: "monthly on the 1st at 09:00",
    due: (t) => t.day === 1 && at(9)(t),
    run: async () => remindExchangeRates(await getDb()),
  },
  // Monthly: distances to nearby places older than 90 days are measured again (07 §4.7).
  {
    name: "poi.refresh",
    schedule: "monthly on the 1st at 04:00",
    due: (t) => t.day === 1 && at(4)(t),
    run: async () => {
      const db = await getDb();
      const listings = await refreshStalePois(db);
      const projects = await refreshStaleProjectPois(db);
      return { queued: listings.queued, projects: projects.queued };
    },
  },
];

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localTime(date: Date, timeZone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      day: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
  } catch {
    return localTime(date, "UTC");
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    day: Number(get("day")),
  };
}

/** Runs the tasks due at `scheduled`; each run is recorded in job_runs for the Jobs page. */
export async function runCron(
  scheduled: Date,
  tasks: CronTask[] = cronTasks,
): Promise<Array<{ task: string; ok: boolean; error?: string }>> {
  const db = await getDb();
  const general = await loadSettings("general", db);
  const t = localTime(scheduled, general.timeZone);
  const results: Array<{ task: string; ok: boolean; error?: string }> = [];

  for (const task of tasks.filter((x) => x.due(t))) {
    const id = newId();
    const logged = !task.quiet;
    if (logged) {
      await db.insert(jobRuns).values({
        id,
        name: `cron:${task.name}`,
        status: "running",
        attempts: 1,
        maxAttempts: 1,
        startedAt: new Date(),
      });
    }
    try {
      const result = await task.run();
      if (logged) {
        await db
          .update(jobRuns)
          .set({ status: "succeeded", finishedAt: new Date(), result: (result ?? null) as never })
          .where(eq(jobRuns.id, id));
      }
      results.push({ task: task.name, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "cron.failed", { cron: task.name, error: message });
      if (logged) {
        await db
          .update(jobRuns)
          .set({ status: "failed", finishedAt: new Date(), lastError: message.slice(0, 2000) })
          .where(eq(jobRuns.id, id));
      }
      results.push({ task: task.name, ok: false, error: message });
    }
  }
  return results;
}
