import "../../../scripts/_env";
import { parseArgs } from "node:util";
import { backfillEmbeddings } from "@/features/ai/embeddings";
import { closeDb, getDb } from "../client";
import { demoPresets } from "./presets";
import { seedPreset } from "./run";
import type { SeedPreset } from "./types";

/**
 * `pnpm db:seed [--preset=haven-dune|us-demo] [--reset]` (16 §1, §2). Prints the demo logins
 * once. Switching market is a reseed with the other preset: only settings and data change.
 * --reset replaces the demo data (listings, projects, master data, files) in this database.
 */
const presets: Record<string, SeedPreset> = demoPresets;

const { values } = parseArgs({
  options: {
    preset: { type: "string", default: "haven-dune" },
    reset: { type: "boolean", default: false },
  },
});

const preset = presets[values.preset!];
if (!preset) {
  console.error(`Unknown preset "${values.preset}". Presets: ${Object.keys(presets).join(", ")}`);
  process.exit(1);
}

try {
  const db = await getDb();
  const started = Date.now();
  const { admins, customers, counts } = await seedPreset(db, preset, {
    reset: values.reset,
    onProgress: (step) => console.log(`  ${step}…`),
  });
  // The assistants' search index (10 §1); test embeddings unless running on Cloudflare.
  const indexed = await backfillEmbeddings(db);
  console.log(`  search index: ${indexed.indexed} indexed, ${indexed.unchanged} unchanged`);
  console.log(`Seeded "${preset.key}" in ${Math.round((Date.now() - started) / 1000)} s:`);
  for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(16)} ${n}`);
  console.log("\nStart (or restart) the app after seeding so it reads the new data.");
  console.log("\nDemo logins (shown once; two-step verification is off for the demo):");
  for (const a of admins)
    console.log(
      `  ${a.email.padEnd(22)} ${a.password}${a.readOnly ? "   (read-only viewer)" : ""}`,
    );
  console.log("\nDemo customers (the site's /account area):");
  for (const c of customers) console.log(`  ${c.email.padEnd(26)} ${c.password}`);
} catch (err) {
  console.error("Seeding failed:", err);
  process.exitCode = 1;
} finally {
  await closeDb();
}
