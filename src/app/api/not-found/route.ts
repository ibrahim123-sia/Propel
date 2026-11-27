import { z } from "zod";
import { getDb } from "@/db/client";
import { recordNotFound } from "@/features/seo/not-found-log";
import { hit, rateLimitRules } from "@/lib/rate-limit";
import { clientIpFromHeaders, truncateIp } from "@/lib/request";

const reportSchema = z.object({
  path: z.string().startsWith("/").max(500),
  referrer: z.string().max(2000).nullable(),
});

const done = () => new Response(null, { status: 204 });

/**
 * 404 monitor (08 §6): the not-found page reports its address once it is on screen
 * (components/site/not-found-logger.tsx). Next renders the not-found page into every page's
 * payload, so only the browser knows when it was really shown. Always answers 204.
 */
export async function POST(request: Request): Promise<Response> {
  // Crawlers count too: an old address they still visit is what the monitor is for.
  let body: unknown;
  try {
    // sendBeacon posts text/plain; the JSON text is the same.
    body = JSON.parse(await request.text());
  } catch {
    return done();
  }
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return done();
  const db = await getDb();
  const ip = truncateIp(clientIpFromHeaders(request.headers)) ?? "unknown";
  if (!(await hit(`not-found:${ip}`, rateLimitRules.notFound, db)).allowed) return done();
  try {
    await recordNotFound(db, parsed.data.path, parsed.data.referrer);
  } catch (err) {
    console.error("[404 monitor]", err);
  }
  return done();
}
