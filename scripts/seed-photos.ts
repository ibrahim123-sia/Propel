import "./_env";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDataPath } from "./paths";

/**
 * `pnpm seed:photos`: downloads real property photos from Pexels (free to use, also
 * commercially, no attribution required; https://www.pexels.com/license/) into
 * ~/.propel/seed-photos/<kind>/, with credits.json next to them. `pnpm db:seed` then uses
 * them for the demo listings instead of its drawn placeholder scenes. Needs PEXELS_API_KEY
 * (free at https://www.pexels.com/api/). The folder stays on this machine; nothing is committed.
 */

export const photoKinds = {
  living: ["modern living room interior", "luxury apartment living room"],
  bedroom: ["modern bedroom interior", "hotel style master bedroom"],
  kitchen: ["modern kitchen interior", "luxury kitchen island"],
  bathroom: ["modern bathroom interior", "luxury bathroom"],
  tower: ["residential tower building", "modern apartment building exterior"],
  villa: ["modern villa exterior", "luxury house exterior"],
  pool: ["infinity pool residence", "villa swimming pool"],
  office: ["modern office interior", "empty office space"],
  land: ["empty land plot", "vacant land for construction"],
} as const;
export type PhotoKind = keyof typeof photoKinds;

const PER_QUERY = 14;

type PexelsPhoto = {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string | null;
  avg_color: string | null;
  src: { original: string };
};

const key = process.env.PEXELS_API_KEY;
if (!key) {
  console.error("[photos] set PEXELS_API_KEY in .env.local (free at https://www.pexels.com/api/).");
  process.exit(1);
}

const root = process.env.SEED_PHOTOS_DIR ?? localDataPath("seed-photos");
let total = 0;
for (const [kind, queries] of Object.entries(photoKinds)) {
  const dir = join(root, kind);
  await mkdir(dir, { recursive: true });
  const credits: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  for (const query of queries) {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${PER_QUERY}&orientation=landscape&size=large`,
      { headers: { Authorization: key }, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) {
      console.error(`[photos] Pexels answered ${res.status} for "${query}"`);
      process.exit(1);
    }
    const { photos } = (await res.json()) as { photos: PexelsPhoto[] };
    for (const p of photos) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // 1600 px wide JPEG: big enough for the gallery, small enough to seed quickly.
      const img = await fetch(`${p.src.original}?auto=compress&cs=tinysrgb&w=1600`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!img.ok) continue;
      const file = `${p.id}.jpg`;
      await writeFile(join(dir, file), new Uint8Array(await img.arrayBuffer()));
      credits.push({
        file,
        id: p.id,
        alt: p.alt || null,
        color: p.avg_color,
        photographer: p.photographer,
        photographerUrl: p.photographer_url,
        source: p.url,
        license: "Pexels License",
      });
    }
  }
  await writeFile(join(dir, "credits.json"), JSON.stringify(credits, null, 2));
  total += credits.length;
  console.log(`[photos] ${kind}: ${credits.length}`);
}
console.log(`[photos] ${total} photos in ${root}`);
