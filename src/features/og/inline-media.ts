import "server-only";
import { keyFromMediaUrl } from "@/features/brochure/data";
import { variantPrefix } from "@/features/media/queries";
import { bytesToBase64 } from "@/lib/crypto";
import { formatFromName, isRaster } from "@/lib/images/inspect";
import { getImageTransformer } from "@/lib/images/transformer";
import { getStorage } from "@/lib/storage";

/**
 * A library image as a data URL for a share card, read from storage rather than fetched over
 * HTTP: the card renderer refuses its own host (SSRF protection), and a self-request would
 * cost a round trip anyway. On Workers a resized variant is made once and kept with the
 * others; elsewhere (development, tests) the original is used when it is small enough.
 */

const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024;
const mimeOf: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export async function inlineMedia(url: string | null, width = 800): Promise<string | null> {
  if (!url) return null;
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
  const key = keyFromMediaUrl(path);
  if (!key) return null;
  const format = formatFromName(key);
  if (!format) return null;
  const storage = await getStorage();
  try {
    const transformer = isRaster(format) ? await getImageTransformer() : null;
    if (transformer) {
      const variantKey = `${variantPrefix(key)}${width}-75.jpg`;
      let bytes = await storage.getBytes(variantKey);
      if (!bytes) {
        const source = await storage.getBytes(key);
        if (!source) return null;
        bytes = await transformer.resize(source, { width, quality: 75, format: "image/jpeg" });
        await storage.put(variantKey, bytes, "image/jpeg");
      }
      return `data:image/jpeg;base64,${bytesToBase64(bytes)}`;
    }
    const bytes = await storage.getBytes(key);
    if (!bytes || bytes.byteLength > MAX_ORIGINAL_BYTES) return null;
    return `data:${mimeOf[format] ?? "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
  } catch (err) {
    console.warn("[og] image skipped", key, (err as Error).message);
    return null;
  }
}
