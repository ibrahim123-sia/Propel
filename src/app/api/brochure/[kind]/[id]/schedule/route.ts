import { getDb } from "@/db/client";
import { loadBrochure } from "@/features/brochure/data";
import { paymentScheduleDocument } from "@/features/brochure/render";
import { brochureParamsSchema } from "@/features/brochure/schema";
import { loadSettings } from "@/features/settings/queries";
import { brochure as t } from "@/lib/i18n/dictionaries/brochure";
import { localDateString } from "@/lib/local-date";
import { PdfUnavailableError, renderPdf } from "@/lib/pdf/render";
import { hit, rateLimitRules } from "@/lib/rate-limit";
import { clientIpFromHeaders, truncateIp } from "@/lib/request";

const text = (body: string, status: number, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });

/**
 * "Download payment schedule" (06 §5.8, 07 §5): the listing's or project's payment plan with
 * amounts, as a one-page PDF. Made on request (the plan and the price can change any day);
 * the same rate limit as brochures.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/brochure/[kind]/[id]/schedule">,
): Promise<Response> {
  const parsed = brochureParamsSchema.safeParse(await ctx.params);
  if (!parsed.success) return text("Not found", 404);
  const { kind, id } = parsed.data;
  const db = await getDb();
  const ip = truncateIp(clientIpFromHeaders(request.headers)) ?? "unknown";
  const limit = await hit(`brochure:${ip}`, rateLimitRules.tool, db);
  if (!limit.allowed)
    return text(t.errors.tooMany, 429, {
      "Retry-After": String(Math.max(1, Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000))),
    });

  const loaded = await loadBrochure(db, kind, id);
  if (!loaded) return text(t.errors.gone, 404);
  const { timeZone } = await loadSettings("general", db);
  const day = localDateString(new Date(), timeZone);
  const html = await paymentScheduleDocument(
    loaded.data,
    new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(`${day}T00:00:00Z`),
    ),
  );
  if (!html) return text(t.errors.gone, 404);
  let bytes: Uint8Array;
  try {
    bytes = await renderPdf(html);
  } catch (err) {
    if (err instanceof PdfUnavailableError)
      return text(t.errors.unavailable, 503, { "Retry-After": "120" });
    throw err;
  }
  const name = `payment-schedule-${loaded.data.reference ?? loaded.data.slug}.pdf`.toLowerCase();
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name.replace(/[^a-z0-9.-]+/g, "-")}"`,
      "Cache-Control": "no-store",
    },
  });
}
