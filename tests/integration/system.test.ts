import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { jobRuns } from "@/db/schema/system";
import { saveIntegrationKey } from "@/features/integrations/actions";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { recordSecretTest } from "@/features/settings/secrets";
import { retryJobRuns } from "@/features/system/actions";
import {
  cronStatus,
  isCronLate,
  scheduleMinutes,
  integrationStatus,
  jobSortable,
  jobSummary,
  listJobRuns,
} from "@/features/system/queries";
import { newId } from "@/lib/ids";
import { parseTableParams } from "@/lib/table-params";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const params = (sp: Record<string, string>) =>
  parseTableParams(sp, { sortable: jobSortable, defaultSort: { id: "newest", desc: false } });

describe("system page", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    adminState.signedInAt = undefined;
    await truncate("job_runs", "secrets", "settings", "audit_log");
  });

  it("summarises the queue, lists and filters runs, and retries the ones that gave up", async () => {
    const db = await getDb();
    const dead = newId();
    const now = new Date();
    await db.insert(jobRuns).values([
      {
        id: dead,
        name: "email.send",
        status: "dead",
        attempts: 5,
        maxAttempts: 5,
        lastError: "Resend answered 500",
        payload: { emailId: "x" },
      },
      { name: "media.process", status: "queued", lastError: "temporary", attempts: 1 },
      { name: "media.process", status: "succeeded", attempts: 1, startedAt: now, finishedAt: now },
      { name: "cron:rate-limits.purge", status: "succeeded", attempts: 1, finishedAt: now },
    ]);

    expect(await jobSummary()).toMatchObject({
      queued: 1,
      running: 0,
      dead: 1,
      retrying: 1,
      succeededDay: 2,
    });
    expect((await listJobRuns(params({ status: "dead" }))).rows.map((r) => r.id)).toEqual([dead]);
    expect((await listJobRuns(params({ name: "media.process" }))).total).toBe(2);
    expect((await listJobRuns(params({ problems: "1" }))).total).toBe(2);
    const cron = await cronStatus();
    expect(cron.find((t) => t.name === "rate-limits.purge")).toMatchObject({
      schedule: "daily at 02:00",
      lastStatus: "succeeded",
    });
    expect(cron.find((t) => t.name === "media.recount")?.lastRunAt).toBeNull();

    const res = await retryJobRuns({ ids: [dead] });
    expect(res).toMatchObject({ ok: true, data: { count: 1 } });
    const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, dead));
    expect(row).toMatchObject({ status: "queued" });
    expect(row!.maxAttempts).toBeGreaterThan(row!.attempts);
  });

  it("flags jobs nobody picked up, jobs stuck running and scheduled tasks that are late", async () => {
    const db = await getDb();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.insert(jobRuns).values([
      { name: "email.send", status: "queued", attempts: 0, runAfter: ago(12) },
      { name: "email.send", status: "queued", attempts: 0, runAfter: ago(1) },
      { name: "media.process", status: "running", attempts: 1, startedAt: ago(40) },
      // The hourly listing task last ran three hours ago; the daily one an hour ago.
      { name: "cron:listings.daily", status: "succeeded", attempts: 1, finishedAt: ago(60) },
    ]);
    expect(await jobSummary()).toMatchObject({ queued: 2, overdue: 1, running: 1, stuck: 1 });
    const cron = await cronStatus();
    expect(cron.every((t) => typeof t.late === "boolean")).toBe(true);
    expect(cron.find((t) => t.name === "listings.daily")?.late ?? false).toBe(false);
    expect(isCronLate("every hour", ago(180), new Date())).toBe(true);
    expect(isCronLate("every hour", ago(30), new Date())).toBe(false);
    expect(isCronLate("daily at 06:00", ago(26 * 60), new Date())).toBe(false);
    expect(isCronLate("daily at 06:00", ago(50 * 60), new Date())).toBe(true);
    expect(isCronLate("daily at 06:00", null, new Date())).toBe(false);
    expect(
      ["every minute", "every 15 minutes", "Mondays at 06:00", "monthly on the 1st at 04:00"].map(
        scheduleMinutes,
      ),
    ).toEqual([1, 15, 7 * 24 * 60, 31 * 24 * 60]);
  });

  it("reports each integration as off, missing a key, untested, failing or working", async () => {
    const db = await getDb();
    expect((await integrationStatus()).every((i) => i.state === "off")).toBe(true);
    const integrations = await loadSettings("integrations", db);
    const actor = { type: "admin" as const, id: testAdmin.id };
    await patchSettings(
      db,
      "integrations",
      {
        googleMaps: { ...integrations.googleMaps, enabled: true },
        whatsapp: { ...integrations.whatsapp, enabled: true },
        ai: { ...integrations.ai, enabled: true },
      },
      actor,
    );
    await saveIntegrationKey({ key: "google_maps_server_key", value: "maps-key" });
    await saveIntegrationKey({ key: "whatsapp_access_token", value: "wa-token" });
    await recordSecretTest("whatsapp_access_token", "Meta answered 401: invalid");

    const byName = Object.fromEntries((await integrationStatus()).map((i) => [i.name, i.state]));
    expect(byName).toEqual({
      "Google Maps Platform": "untested",
      "WhatsApp Cloud API": "error",
      "Email (SMTP)": "off", // no SMTP_* in the test environment
      "Google Calendar": "off",
      "AI provider": "ok", // the built-in test provider needs no key
    });
  });
});
