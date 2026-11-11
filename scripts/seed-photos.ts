import "./_env";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDataPath } from "./paths";

/**
 * `pnpm seed:photos`: downloads real property photos into ~/.propel/seed-photos/<kind>/, with
 * credits.json next to them, for `pnpm db:seed` to use instead of its drawn placeholder scenes.
 *
 * Source: Openverse (https://openverse.org, no API key needed), limited to CC0 photos from
 * StockSnap and rawpixel: free to use, also commercially, no attribution required. The
 * photographer is still kept in credits.json and in each photo's caption. The folder stays on
 * this machine; nothing is committed.
 */

export const photoKinds = {
  living: ["modern living room interior", "apartment living room", "luxury living room"],
  bedroom: ["modern bedroom interior", "bedroom interior design", "master bedroom"],
  kitchen: ["modern kitchen interior", "kitchen interior design", "white kitchen"],
  bathroom: ["modern bathroom interior", "bathroom interior design"],
  tower: ["apartment building", "residential building exterior", "modern apartment building"],
  villa: ["luxury house exterior", "modern house exterior", "villa house"],
  pool: ["swimming pool house", "infinity pool", "outdoor swimming pool"],
  office: ["modern office interior", "office space interior"],
  land: ["empty land", "vacant lot", "desert land"],
} as const;
export type PhotoKind = keyof typeof photoKinds;

const SOURCES = "stocksnap,rawpixel";
const PER_KIND = Number(process.env.SEED_PHOTOS_PER_KIND ?? 24);
const UA = "Propel-seed/1.0 (demo data for a real estate website)";

type Result = {
  id: string;
  title: string | null;
  url: string;
  width: number | null;
  height: number | null;
  creator: string | null;
  creator_url: string | null;
  license: string;
  source: string;
  foreign_landing_url: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function search(query: string): Promise<Result[]> {
  const url =
    `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&license=cc0,pdm&source=${SOURCES}&aspect_ratio=wide&page_size=20`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (res?.ok) return ((await res.json()) as { results: Result[] }).results;
    // Openverse limits anonymous use and is sometimes slow: wait and ask again.
    await sleep(5_000 * (attempt + 1));
  }
  console.warn(`[photos] no answer from Openverse for "${query}"`);
  return [];
}

const root = process.env.SEED_PHOTOS_DIR ?? localDataPath("seed-photos");
let total = 0;
for (const [kind, queries] of Object.entries(photoKinds)) {
  const dir = join(root, kind);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const credits: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (credits.length >= PER_KIND) break;
    for (const r of await search(query)) {
      if (credits.length >= PER_KIND) break;
      if (seen.has(r.id) || (r.width ?? 0) < 900) continue;
      seen.add(r.id);
      const img = await fetch(r.url, {
        headers: { "user-agent": `Mozilla/5.0 ${UA}` },
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (!img?.ok || !(img.headers.get("content-type") ?? "").startsWith("image/")) continue;
      const bytes = new Uint8Array(await img.arrayBuffer());
      if (bytes.byteLength < 20_000) continue;
      const file = `${r.id}.jpg`;
      await writeFile(join(dir, file), bytes);
      credits.push({
        file,
        alt: r.title?.replace(/^Free\s+/i, "").trim() || null,
        photographer: r.creator,
        photographerUrl: r.creator_url,
        source: r.foreign_landing_url,
        license: r.license.toUpperCase(),
        via: r.source,
      });
    }
    await sleep(1_500);
  }
  await writeFile(join(dir, "credits.json"), JSON.stringify(credits, null, 2));
  total += credits.length;
  console.log(`[photos] ${kind}: ${credits.length}`);
}
console.log(`[photos] ${total} photos in ${root}`);
