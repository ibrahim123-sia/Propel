import { connection } from "next/server";
import { getDb } from "@/db/client";
import { loadSettings } from "@/features/settings/queries";
import { siteUrl } from "@/features/site/url";
import { viewingByToken } from "@/features/viewings/manage";

/** Google Calendar's own "new event" page, filled in for this viewing (no Google key needed). */
const stamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** "Add to Google Calendar" for a booked viewing, from its private link (as /ics). */
export async function GET(_request: Request, ctx: RouteContext<"/api/viewings/[token]/google">) {
  try {
    await connection();
  } catch {
    // Outside a request (tests): nothing to opt out of.
  }
  const { token } = await ctx.params;
  const db = await getDb();
  const row = await viewingByToken(db, token);
  if (!row || row.viewing.status === "cancelled") return new Response("Not found", { status: 404 });
  const { viewing: v, property, project } = row;
  const general = await loadSettings("general", db);
  const what = property
    ? `${property.reference} · ${property.title}`
    : (project?.name ?? "Viewing");
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", `Viewing: ${what} (${general.agencyName})`);
  url.searchParams.set("dates", `${stamp(v.startsAt)}/${stamp(v.endsAt)}`);
  url.searchParams.set(
    "details",
    [
      v.type === "video" ? "Video tour" : "In person",
      v.meetingUrl,
      `Change or cancel: ${siteUrl(`/viewings/${token}`)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}
