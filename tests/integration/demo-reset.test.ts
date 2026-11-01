import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { jobRuns } from "@/db/schema/system";
import {
  DEMO_RESET_JOB,
  nextDemoPreset,
  queueNightlyDemoReset,
  switchDemoMarket,
} from "@/features/demo/reset";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { resetEnvCache } from "@/lib/env";
import { cronTasks } from "@/jobs/cron";
import { truncate } from "../helpers/db";

const actor = { type: "system" as const, id: null };

describe("demo market switch and nightly reset (16 §2-3)", () => {
  beforeEach(async () => {
    await truncate("settings", "job_runs");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("does nothing outside a demo build", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    resetEnvCache();
    expect(await queueNightlyDemoReset(await getDb())).toEqual({ queued: false });
    expect(await (await getDb()).select().from(jobRuns)).toEqual([]);
  });

  it("switches to the other preset now on a Node host, and the nightly reset keeps it", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    resetEnvCache();
    const db = await getDb();
    await patchSettings(db, "demo", { preset: "haven-dune" }, actor);
    expect(await nextDemoPreset(db)).toBe("haven-dune");

    expect(await switchDemoMarket(db, actor)).toEqual({ preset: "us-demo", when: "now" });
    expect(await loadSettings("demo", db)).toMatchObject({
      preset: "haven-dune",
      requestedPreset: "us-demo",
    });
    expect(await nextDemoPreset(db)).toBe("us-demo");
    const [job] = await db.select().from(jobRuns).where(eq(jobRuns.name, DEMO_RESET_JOB));
    expect(job!.payload).toEqual({ preset: "us-demo" });

    // Nightly: once a day, with the preset the next reset loads.
    expect(await queueNightlyDemoReset(db)).toEqual({ queued: true });
    expect(await queueNightlyDemoReset(db)).toEqual({ queued: false });
    const runs = await db.select().from(jobRuns).where(eq(jobRuns.name, DEMO_RESET_JOB));
    expect(runs.map((r) => (r.payload as { preset: string }).preset).sort()).toEqual([
      "us-demo",
      "us-demo",
    ]);
    expect(cronTasks.find((t) => t.name === "demo.reset")?.schedule).toContain("02:30");
  });

  it("a second switch before the reset goes back to the first preset", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    resetEnvCache();
    const db = await getDb();
    await patchSettings(db, "demo", { preset: "us-demo" }, actor);
    expect((await switchDemoMarket(db, actor)).preset).toBe("haven-dune");
    expect((await switchDemoMarket(db, actor)).preset).toBe("us-demo");
  });
});
