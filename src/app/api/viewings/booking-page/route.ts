import { connection } from "next/server";
import { getSettings } from "@/features/settings/queries";
import { googleBookingEmbedUrl } from "@/features/viewings/google-booking";

/**
 * The Google Calendar booking page from Settings -> Viewings, for "Book a tour": `link` opens
 * it on Google, `embed` shows it inside the site (null for short links). Both null: the site's
 * own free times are used.
 */
export async function GET(): Promise<Response> {
  await connection();
  const link = (await getSettings("viewings")).googleBookingUrl || null;
  return Response.json(
    { link, embed: link ? googleBookingEmbedUrl(link) : null },
    { headers: { "cache-control": "private, no-store" } },
  );
}
