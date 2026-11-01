import "./_env";
import { parseArgs } from "node:util";
import { closeDb, getDb } from "../src/db/client";
import { demoPresets, isDemoPresetKey, type DemoPresetKey } from "../src/db/seed/presets";
import { seedPreset } from "../src/db/seed/run";
import { backfillEmbeddings } from "../src/features/ai/embeddings";
import { DEMO_TAGS, nextDemoPreset } from "../src/features/demo/reset";
import { env } from "../src/lib/env";

/**
 * `pnpm demo:reset [--preset=haven-dune|us-demo]` (16 §2-3): puts the public demo back to the
 * seed. Without --preset it loads the requested switch, else the preset loaded now. Every demo
 * login gets DEMO_PASSWORD, so the logins on the demo page keep working night after night.
 * Refuses unless DEMO_MODE=true. When APP_URL and INTERNAL_JOB_SECRET are set it then asks the
 * running site to expire its caches (needed when it runs outside the app, e.g. GitHub Actions).
 */
const { values } = parseArgs({ options: { preset: { type: "string" } } });

if (!env().DEMO_MODE) {
  console.error("[demo] DEMO_MODE is not true: refusing to reset this database.");
  process.exit(1);
}
const password = process.env.DEMO_PASSWORD ?? "";
if (password.length < 8) {
  console.error("[demo] set DEMO_PASSWORD (8+ characters) so the demo logins stay the same.");
  process.exit(1);
}
if (values.preset !== undefined && !isDemoPresetKey(values.preset)) {
  console.error(`[demo] unknown preset "${values.preset}"`);
  process.exit(1);
}

try {
  const db = await getDb();
  const key: DemoPresetKey =
    (values.preset as DemoPresetKey | undefined) ?? (await nextDemoPreset(db));
  const preset = demoPresets[key];
  const started = Date.now();
  console.log(`[demo] resetting to "${key}"…`);
  const passwords = Object.fromEntries(
    [...preset.admins.map((a) => a.email), ...preset.customers.map((c) => c.email)].map((e) => [
      e,
      password,
    ]),
  );
  const { counts } = await seedPreset(db, preset, {
    reset: true,
    passwords,
    onProgress: (step) => console.log(`  ${step}…`),
  });
  const indexed = await backfillEmbeddings(db);
  console.log(
    `[demo] "${key}" loaded in ${Math.round((Date.now() - started) / 1000)} s: ${counts.properties ?? 0} listings, ${indexed.indexed} indexed`,
  );

  const appUrl = process.env.APP_URL;
  const secret = process.env.INTERNAL_JOB_SECRET;
  if (appUrl && secret && !appUrl.includes("localhost")) {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/internal/revalidate`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ tags: DEMO_TAGS }),
    });
    console.log(`[demo] site caches expired: ${res.status}`);
  }
} catch (err) {
  console.error("[demo] reset failed:", err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
