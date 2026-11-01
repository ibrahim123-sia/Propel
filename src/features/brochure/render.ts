import "server-only";
import type { DbOrTx } from "@/db/client";
import { siteOrigin } from "@/features/site/url";
import { isWorkersRuntime } from "@/lib/env";
import { mimeFromName } from "@/lib/images/inspect";
import { mediaVariant } from "@/lib/media-src";
import { renderPdf } from "@/lib/pdf/render";
import { getStorage } from "@/lib/storage";
import {
  brochureFileName,
  brochureKey,
  brochurePrefix,
  brochureVersion,
  keyFromMediaUrl,
  loadBrochure,
  type LoadedBrochure,
} from "./data";
import { brochureHtml, paymentScheduleHtml, type ImageSource } from "./template";
import type { BrochureData, BrochureImage, BrochureKind } from "./types";

/**
 * Drawing and keeping brochures (11 §4 "cached in R2 per listing version"). The PDF is kept
 * under `brochures/<kind>/<id>/<version>.pdf`; a new version replaces the old ones.
 */

/** Files larger than this are loaded by the browser from /media instead of being inlined. */
const INLINE_LIMIT = 2_500_000;

function imagesOf(d: BrochureData): BrochureImage[] {
  return [d.cover, ...d.gallery, d.floorPlan, d.contact.photo, d.agency.logo].filter(
    (i): i is BrochureImage => i !== null,
  );
}

/**
 * How the browser gets each picture. On Workers, Browser Rendering loads resized copies from
 * the public site (/media/<key>?w=, made once by Cloudflare Images and kept in R2), which keeps
 * the HTML small. Elsewhere (development, CI, tests) files are read from storage and inlined,
 * so no server has to be running (this path only runs on Node, hence Buffer); very large
 * originals fall back to the site address.
 */
async function imageSource(d: BrochureData): Promise<ImageSource> {
  const origin = siteOrigin();
  const absolute: ImageSource = (img, width) => `${origin}${mediaVariant(img.url, width)}`;
  if (isWorkersRuntime()) return absolute;
  const storage = await getStorage();
  const inline = new Map<string, string>();
  for (const img of imagesOf(d)) {
    if (inline.has(img.url)) continue;
    const key = keyFromMediaUrl(img.url);
    const bytes = key ? await storage.getBytes(key) : null;
    if (bytes && bytes.length <= INLINE_LIMIT)
      inline.set(
        img.url,
        `data:${mimeFromName(key!)};base64,${Buffer.from(bytes).toString("base64")}`,
      );
  }
  return (img, width) => inline.get(img.url) ?? absolute(img, width);
}

/** The brochure HTML with its pictures resolved (the integration tests read it too). */
export async function brochureDocument(d: BrochureData): Promise<string> {
  // BROCHURE_WEB_FONTS=off (tests, the e2e server): no request to Google Fonts.
  return brochureHtml(d, await imageSource(d), {
    webFonts: process.env.BROCHURE_WEB_FONTS !== "off",
  });
}

/** The one-page payment schedule (06 §5.8), or null when the home or project has no plan. */
export async function paymentScheduleDocument(
  d: BrochureData,
  generatedOn: string,
): Promise<string | null> {
  return paymentScheduleHtml(d, await imageSource(d), {
    webFonts: process.env.BROCHURE_WEB_FONTS !== "off",
    generatedOn,
  });
}

export type GeneratedBrochure = {
  bytes: Uint8Array;
  key: string;
  version: string;
  /** False when the stored copy of this version was used. */
  rendered: boolean;
};

/** The generated PDF for this version: the stored copy, or drawn now and stored. */
export async function generatedBrochure(loaded: LoadedBrochure): Promise<GeneratedBrochure> {
  const { data } = loaded;
  const version = await brochureVersion(data);
  const key = brochureKey(data.kind, data.id, version);
  const storage = await getStorage();
  const stored = await storage.getBytes(key);
  if (stored) return { bytes: stored, key, version, rendered: false };

  const bytes = await renderPdf(await brochureDocument(data), { format: "A4" });
  // Older versions go first (best effort: a file still being read may stay until next time).
  await storage.deletePrefix(brochurePrefix(data.kind, data.id)).catch(() => undefined);
  await storage.put(key, bytes, "application/pdf");
  return { bytes, key, version, rendered: true };
}

export type BrochureFile = {
  bytes: Uint8Array;
  fileName: string;
  source: "uploaded" | "generated";
  data: BrochureData;
};

/**
 * What a visitor downloads: the uploaded PDF when the admin added one (it wins, 07 §8), else the
 * generated one. `preferGenerated` (admin) always gives the generated brochure. Null when the
 * listing or project is not public.
 */
export async function brochureFile(
  db: DbOrTx,
  kind: BrochureKind,
  id: string,
  options: { preferGenerated?: boolean } = {},
): Promise<BrochureFile | null> {
  const loaded = await loadBrochure(db, kind, id);
  if (!loaded) return null;
  const fileName = brochureFileName(loaded.data);
  if (loaded.uploaded && !options.preferGenerated) {
    const bytes = await (await getStorage()).getBytes(loaded.uploaded.key);
    if (bytes) return { bytes, fileName, source: "uploaded", data: loaded.data };
  }
  const generated = await generatedBrochure(loaded);
  return { bytes: generated.bytes, fileName, source: "generated", data: loaded.data };
}
