import "server-only";
import { z } from "zod";
import type { Db } from "@/db/client";
import { isDemoPresetKey, otherPreset, type DemoPresetKey } from "@/db/seed/presets";
import { patchSettings } from "@/features/settings/mutations";
import { loadSettings } from "@/features/settings/queries";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import type { AuditActor } from "@/lib/audit";
import { env, isWorkersRuntime } from "@/lib/env";
import { expireTags } from "@/lib/expire-tags";
import { log } from "@/lib/log";

/**
 * The public demo (16 §2-3): every night the database goes back to the seed, and an admin can
 * switch the market (Haven & Dune: AED, sq ft <-> Maple & Main: USD, miles). Only with
 * DEMO_MODE=true.
 *
 * The seeding itself lives in `scripts/demo-reset.ts`: it draws photos with sharp, which only
 * runs on Node and must stay out of the Worker bundle. On a Node host the app runs that script
 * as a child process (the `demo.reset` job, nightly and on "Switch demo market"); on
 * Cloudflare the nightly GitHub Action runs it (.github/workflows/demo-reset.yml) with the
 * bucket through R2's S3 API, and "Switch demo market" asks that run for the other preset.
 */
export const DEMO_RESET_JOB = "demo.reset";

/** Every cache tag family the public site uses: all of them change in a reset. */
export const DEMO_TAGS = [
  "settings",
  "listings",
  "search",
  "locations",
  "projects",
  "developers",
  "agents",
  "page:home",
  "pages",
  "posts",
  "area-guides",
  "faqs",
  "testimonials",
  "master:property-types",
  "master:facilities",
  "master:badges",
  "master:poi-types",
];

/** The preset the next reset loads: the requested switch, else the one loaded now. */
export async function nextDemoPreset(db: Db): Promise<DemoPresetKey> {
  const demo = await loadSettings("demo", db);
  return demo.requestedPreset ?? demo.preset ?? "haven-dune";
}

/** The app can reseed itself only on a Node host (the seed needs sharp and the disk). */
export const canResetInPlace = () => !isWorkersRuntime();

export type SwitchResult = { preset: DemoPresetKey; when: "now" | "next_reset" };

/** "Switch demo market" (16 §2): the other preset, now on Node, at the nightly reset elsewhere. */
export async function switchDemoMarket(db: Db, actor: AuditActor): Promise<SwitchResult> {
  const demo = await loadSettings("demo", db);
  const target = otherPreset(demo.requestedPreset ?? demo.preset ?? "haven-dune");
  await patchSettings(
    db,
    "demo",
    { ...demo, requestedPreset: target, requestedAt: new Date().toISOString() },
    actor,
  );
  if (!canResetInPlace()) return { preset: target, when: "next_reset" };
  await enqueue(DEMO_RESET_JOB, { preset: target }, { db, dedupeKey: `${DEMO_RESET_JOB}:switch` });
  return { preset: target, when: "now" };
}

/** Runs `scripts/demo-reset.ts` next to the app (Node hosts), then expires the site's caches. */
async function runResetScript(preset: DemoPresetKey): Promise<{ preset: DemoPresetKey }> {
  const { spawn } = await import(/* turbopackIgnore: true */ "node:child_process");
  const { createRequire } = await import(/* turbopackIgnore: true */ "node:module");
  const tsx = createRequire(`${process.cwd()}/package.json`).resolve("tsx");
  const code: number = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsx,
        "--import",
        "./scripts/register-server-only.mjs",
        "scripts/demo-reset.ts",
        `--preset=${preset}`,
      ],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`The demo reset script exited with ${code}`);
  expireTags(...DEMO_TAGS);
  log("info", "demo.reset", { preset });
  return { preset };
}

export const demoResetJob = defineJob({
  name: DEMO_RESET_JOB,
  payload: z.object({ preset: z.string().refine(isDemoPresetKey) }).strict(),
  maxAttempts: 1,
  run: async ({ preset }) => {
    if (!env().DEMO_MODE) return { skipped: "not a demo" };
    if (!canResetInPlace()) return { skipped: "runs in the nightly GitHub Action" };
    return runResetScript(preset as DemoPresetKey);
  },
});

/** Nightly (cron): reseed with the next preset, on Node hosts with DEMO_MODE on. */
export async function queueNightlyDemoReset(db: Db): Promise<{ queued: boolean }> {
  if (!env().DEMO_MODE || !canResetInPlace()) return { queued: false };
  const preset = await nextDemoPreset(db);
  const id = await enqueue(
    DEMO_RESET_JOB,
    { preset },
    { db, dedupeKey: `${DEMO_RESET_JOB}:${new Date().toISOString().slice(0, 10)}` },
  );
  return { queued: id !== null };
}
