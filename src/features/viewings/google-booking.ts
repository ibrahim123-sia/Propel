/**
 * Viewings booked through a Google Calendar appointment schedule (Settings -> Viewings). The
 * agency makes a booking page in Google Calendar (Create -> Appointment schedule) and pastes
 * its link; the site then shows Google's own booking page, with the agency's real calendar
 * behind it, instead of its own free times. No database or Node APIs: the client uses it too.
 */

const FULL =
  /^https:\/\/calendar\.google\.com\/calendar\/(?:u\/\d+\/)?appointments\/schedules\/[\w-]+/;
const SHORT = /^https:\/\/calendar\.app\.google\/[\w-]+\/?$/;

export function isGoogleBookingUrl(value: string): boolean {
  return FULL.test(value) || SHORT.test(value);
}

/**
 * The address to show inside the site, or null when Google only allows opening it on its own
 * site: the short `calendar.app.google` links redirect, and the redirect drops the embed flag.
 */
export function googleBookingEmbedUrl(value: string): string | null {
  if (!FULL.test(value)) return null;
  const url = new URL(value);
  url.searchParams.set("gv", "true");
  return url.toString();
}
