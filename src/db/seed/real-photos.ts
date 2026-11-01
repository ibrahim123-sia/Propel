import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { localDataRoot } from "@/lib/local-data";
import type { Picture } from "./images";

/**
 * Real photos for the demo listings, when `pnpm seed:photos` has downloaded them (Pexels,
 * free to use; see scripts/seed-photos.ts): ~/.propel/seed-photos/<kind>/*.jpg with
 * credits.json. Without them the seed draws its placeholder scenes as before.
 */

export type RealPhoto = Picture & { alt: string | null; credit: string | null };

export function seedPhotosDir(): string {
  return process.env.SEED_PHOTOS_DIR || join(localDataRoot(), "seed-photos");
}

type Credit = { file: string; alt?: string | null; color?: string | null; photographer?: string };

export async function loadRealPhotos(
  dir: string = seedPhotosDir(),
  perKind = 24,
): Promise<Map<string, RealPhoto[]>> {
  const out = new Map<string, RealPhoto[]>();
  if (!existsSync(dir)) return out;
  for (const kind of await readdir(dir)) {
    const folder = join(dir, kind);
    const creditsFile = join(folder, "credits.json");
    if (!existsSync(creditsFile)) continue;
    const credits = JSON.parse(await readFile(creditsFile, "utf8")) as Credit[];
    const photos: RealPhoto[] = [];
    for (const c of credits.slice(0, perKind)) {
      const path = join(folder, c.file);
      if (!existsSync(path)) continue;
      const bytes = new Uint8Array(await readFile(path));
      const meta = await sharp(bytes).metadata();
      if (!meta.width || !meta.height) continue;
      photos.push({
        bytes,
        mime: "image/jpeg",
        width: meta.width,
        height: meta.height,
        color: c.color ?? "#d8d2c8",
        alt: c.alt?.trim() || null,
        credit: c.photographer ? `Photo: ${c.photographer} / Pexels` : null,
      });
    }
    if (photos.length) out.set(kind, photos);
  }
  return out;
}
