import "server-only";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { calendarBusy, calendarConnections, contacts, viewings } from "@/db/schema/crm";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { properties } from "@/db/schema/properties";
import { loadSettings } from "@/features/settings/queries";
import { getSecret } from "@/features/settings/secrets";
import { recordIntegrationResult } from "@/features/system/alerts";
import { siteOrigin } from "@/features/site/url";
import { zonedTime } from "@/features/viewings/slots";
import { defineJob } from "@/jobs/types";
import { ActionError } from "@/lib/actions";
import { writeAudit, type AuditActor } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { signToken, verifyToken } from "@/lib/signed-token";
import { calendarApi, CalendarApiError, type BusyEvent, type CalendarEvent } from "./api";

/** Google Calendar per agent profile (13 §1): connect, busy times, viewing events. */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export const callbackPath = "/api/integrations/google/callback";
export const redirectUri = () => `${siteOrigin()}${callbackPath}`;

/** Client id and secret, or null when Google Calendar is off or not set up. */
export async function googleConfig(
  db: DbOrTx,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const { googleCalendar } = await loadSettings("integrations", db);
  if (!googleCalendar.enabled || !googleCalendar.clientId) return null;
  const clientSecret = await getSecret("google_oauth_client_secret", db);
  return clientSecret ? { clientId: googleCalendar.clientId, clientSecret } : null;
}

const STATE_PURPOSE = "google-calendar-connect";

/** Google's consent screen for one agent; the signed state says which (10 minutes). */
export async function connectUrl(db: DbOrTx, agentId: string): Promise<string> {
  const config = await googleConfig(db);
  if (!config)
    throw new ActionError(
      "Turn on Google Calendar and add the OAuth client in Settings -> Integrations first.",
      "NOT_CONFIGURED",
    );
  const state = await signToken(STATE_PURPOSE, { agentId }, 600);
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    // Always ask, so Google sends a refresh token even for a second connection.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function agentFromState(state: string | null): Promise<string | null> {
  const payload = await verifyToken<{ agentId: string }>(STATE_PURPOSE, state);
  return payload && z.uuid().safeParse(payload.agentId).success ? payload.agentId : null;
}

/** The OAuth callback: tokens stored encrypted on the agent's connection. */
export async function completeConnect(
  db: DbOrTx,
  input: { code: string; state: string | null; actor: AuditActor },
): Promise<{ agentId: string; email: string | null }> {
  const agentId = await agentFromState(input.state);
  if (!agentId) throw new ActionError("The link expired. Please connect again.", "BAD_STATE");
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.agencyId, currentAgencyId())));
  if (!agent) throw new ActionError("This agent no longer exists.", "NOT_FOUND");
  const config = await googleConfig(db);
  if (!config) throw new ActionError("Google Calendar is not set up.", "NOT_CONFIGURED");
  const t = await calendarApi().exchangeCode({
    code: input.code,
    redirectUri: redirectUri(),
    ...config,
  });
  if (!t.refreshToken)
    throw new ActionError(
      "Google did not allow offline access. Remove Propel from the Google account's apps and connect again.",
      "NO_REFRESH_TOKEN",
    );
  const values = {
    calendarId: "primary",
    accountEmail: t.email,
    encryptedRefreshToken: await encryptSecret(t.refreshToken),
    encryptedAccessToken: await encryptSecret(t.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + t.expiresIn * 1000),
    scope: t.scope,
    lastError: null,
    lastErrorAt: null,
  };
  await db
    .insert(calendarConnections)
    .values({ agentId, provider: "google", ...values, createdBy: input.actor.id })
    .onConflictDoUpdate({
      target: [calendarConnections.agentId, calendarConnections.provider],
      set: { ...values, updatedBy: input.actor.id },
    });
  await db
    .update(agents)
    .set({ calendarConnected: true, googleCalendarId: t.email ?? "primary" })
    .where(eq(agents.id, agentId));
  await writeAudit(db, {
    actor: input.actor,
    action: "agent.calendar_connect",
    entityType: "agent",
    entityId: agentId,
    after: { provider: "google", account: t.email },
  });
  return { agentId, email: t.email };
}

export async function disconnectCalendar(db: DbOrTx, agentId: string, actor: AuditActor) {
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.agentId, agentId),
        eq(calendarConnections.agencyId, currentAgencyId()),
      ),
    );
  if (conn) {
    // Best effort: the grant is removed at Google too.
    await calendarApi()
      .revoke(await decryptSecret(conn.encryptedRefreshToken))
      .catch(() => undefined);
    await db.delete(calendarConnections).where(eq(calendarConnections.id, conn.id));
  }
  await db.delete(calendarBusy).where(eq(calendarBusy.agentId, agentId));
  await db
    .update(agents)
    .set({ calendarConnected: false, googleCalendarId: null })
    .where(eq(agents.id, agentId));
  await writeAudit(db, {
    actor,
    action: "agent.calendar_disconnect",
    entityType: "agent",
    entityId: agentId,
    before: conn ? { provider: "google", account: conn.accountEmail } : null,
  });
}

type Connection = typeof calendarConnections.$inferSelect;

async function recordError(db: DbOrTx, conn: Connection, err: unknown) {
  await db
    .update(calendarConnections)
    .set({ lastError: (err as Error).message.slice(0, 500), lastErrorAt: new Date() })
    .where(eq(calendarConnections.id, conn.id));
}

/** A working access token, refreshed (and stored) when it is about to expire. */
export async function accessToken(db: DbOrTx, conn: Connection): Promise<string> {
  if (
    conn.encryptedAccessToken &&
    conn.accessTokenExpiresAt &&
    conn.accessTokenExpiresAt.getTime() > Date.now() + 60_000
  )
    return decryptSecret(conn.encryptedAccessToken);
  const config = await googleConfig(db);
  if (!config) throw new ActionError("Google Calendar is not set up.", "NOT_CONFIGURED");
  const t = await calendarApi().refresh({
    refreshToken: await decryptSecret(conn.encryptedRefreshToken),
    ...config,
  });
  await db
    .update(calendarConnections)
    .set({
      encryptedAccessToken: await encryptSecret(t.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + t.expiresIn * 1000),
    })
    .where(eq(calendarConnections.id, conn.id));
  return t.accessToken;
}

export async function connectionFor(db: DbOrTx, agentId: string): Promise<Connection | null> {
  const [conn] = await db
    .select()
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.agentId, agentId),
        eq(calendarConnections.agencyId, currentAgencyId()),
        eq(calendarConnections.provider, "google"),
      ),
    );
  return conn ?? null;
}

/** An all-day event blocks its days in the agency's time zone. */
export function busyInterval(e: BusyEvent, timeZone: string): { start: Date; end: Date } {
  if ("allDay" in e)
    return { start: zonedTime(e.startDate, 0, timeZone), end: zonedTime(e.endDate, 0, timeZone) };
  return e;
}

/**
 * Every 15 minutes (13 §2): each connected agent's busy times for the booking window are read
 * from Google into calendar_busy, where the free slots look for them.
 */
export async function refreshCalendarBusy(db: DbOrTx, now = new Date()): Promise<number> {
  if (!(await googleConfig(db))) return 0;
  const [viewingSettings, general] = [
    await loadSettings("viewings", db),
    await loadSettings("general", db),
  ];
  const to = new Date(now.getTime() + (viewingSettings.bookingWindowDays + 1) * 86_400_000);
  const conns = await db
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.agencyId, currentAgencyId()));
  let refreshed = 0;
  for (const conn of conns) {
    try {
      const events = await calendarApi().busy(
        await accessToken(db, conn),
        conn.calendarId,
        now,
        to,
      );
      await db.delete(calendarBusy).where(eq(calendarBusy.agentId, conn.agentId));
      if (events.length)
        await db.insert(calendarBusy).values(
          events.map((e) => ({
            agentId: conn.agentId,
            ...(({ start, end }) => ({ startsAt: start, endsAt: end }))(
              busyInterval(e, general.timeZone),
            ),
            fetchedAt: now,
          })),
        );
      await db
        .update(calendarConnections)
        .set({ lastSyncAt: now, lastError: null, lastErrorAt: null })
        .where(eq(calendarConnections.id, conn.id));
      refreshed++;
    } catch (err) {
      await recordError(db, conn, err);
    }
  }
  return refreshed;
}

/** The busy times read from an agent's calendar (used by the free slots). */
export async function storedBusy(db: DbOrTx, agentId: string, from: Date, to: Date) {
  const rows = await db
    .select({ start: calendarBusy.startsAt, end: calendarBusy.endsAt })
    .from(calendarBusy)
    .where(
      and(
        eq(calendarBusy.agentId, agentId),
        lt(calendarBusy.startsAt, to),
        gt(calendarBusy.endsAt, from),
      ),
    );
  return rows;
}

/** What a viewing looks like in the agent's calendar. */
export function viewingEvent(v: {
  id: string;
  type: "in_person" | "video";
  startsAt: Date;
  endsAt: Date;
  notes: string | null;
  meetingUrl: string | null;
  what: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  leadUrl: string | null;
}): CalendarEvent {
  return {
    summary: `Viewing: ${v.what} · ${v.contactName}`,
    description: [
      v.type === "video" ? "Video tour" : "In person",
      v.meetingUrl,
      [v.contactName, v.contactPhone, v.contactEmail].filter(Boolean).join(" · "),
      v.notes,
      v.leadUrl ? `Lead: ${v.leadUrl}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
    start: v.startsAt,
    end: v.endsAt,
    viewingId: v.id,
  };
}

// A cancelled viewing leaves the calendar; done and no-show ones stay as a record.
const removedStatuses = new Set(["cancelled", "rescheduled"]);

/**
 * calendar.sync (13 §2): the viewing's event in its agent's calendar follows the viewing —
 * created, moved or removed. Not connected means nothing to do, never a fake success.
 */
export async function syncViewingEvent(
  db: DbOrTx,
  viewingId: string,
  previous?: { agentId: string; eventId: string } | null,
) {
  // Moved to another agent: the event leaves the previous agent's calendar first.
  if (previous) {
    const old = await connectionFor(db, previous.agentId);
    if (old && (await googleConfig(db)))
      try {
        await calendarApi().deleteEvent(
          await accessToken(db, old),
          old.calendarId,
          previous.eventId,
        );
      } catch (err) {
        await recordError(db, old, err);
        throw err;
      }
  }
  const [row] = await db
    .select({
      v: viewings,
      contact: { name: contacts.name, phone: contacts.phone, email: contacts.email },
      property: { reference: properties.reference, title: properties.title },
      project: { name: projects.name },
    })
    .from(viewings)
    .innerJoin(contacts, eq(contacts.id, viewings.contactId))
    .leftJoin(properties, eq(properties.id, viewings.propertyId))
    .leftJoin(projects, eq(projects.id, viewings.projectId))
    .where(and(eq(viewings.id, viewingId), eq(viewings.agencyId, currentAgencyId())));
  if (!row) return { skipped: "missing" };
  const { v } = row;
  if (!v.agentId) return { skipped: "no agent" };
  const conn = await connectionFor(db, v.agentId);
  if (!conn || !(await googleConfig(db))) return { skipped: "not connected" };
  try {
    const token = await accessToken(db, conn);
    if (removedStatuses.has(v.status)) {
      if (v.googleEventId) {
        await calendarApi().deleteEvent(token, conn.calendarId, v.googleEventId);
        await db.update(viewings).set({ googleEventId: null }).where(eq(viewings.id, v.id));
      }
      return { removed: Boolean(v.googleEventId) };
    }
    const event = viewingEvent({
      id: v.id,
      type: v.type,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      notes: v.notes,
      meetingUrl: v.meetingUrl,
      what: row.property
        ? `${row.property.reference} · ${row.property.title}`
        : (row.project?.name ?? "Viewing"),
      contactName: row.contact.name,
      contactPhone: row.contact.phone,
      contactEmail: row.contact.email,
      leadUrl: v.leadId ? `${siteOrigin()}/admin/leads/${v.leadId}` : null,
    });
    // Video viewings with Google Meet as the video tool get their link from the event (06 §5).
    const { videoTool } = await loadSettings("viewings", db);
    event.meet = v.type === "video" && videoTool === "google_meet" && !v.meetingUrl;
    const keepMeet = async (meetUrl: string | null) => {
      if (event.meet && meetUrl)
        await db.update(viewings).set({ meetingUrl: meetUrl }).where(eq(viewings.id, v.id));
    };
    if (v.googleEventId) {
      try {
        const res = await calendarApi().updateEvent(token, conn.calendarId, v.googleEventId, event);
        await keepMeet(res.meetUrl);
        return { updated: v.googleEventId, meetUrl: event.meet ? res.meetUrl : undefined };
      } catch (err) {
        // Deleted in Google meanwhile: create it again.
        if (!(err instanceof CalendarApiError && (err.status === 404 || err.status === 410)))
          throw err;
      }
    }
    const res = await calendarApi().insertEvent(token, conn.calendarId, event);
    await db.update(viewings).set({ googleEventId: res.id }).where(eq(viewings.id, v.id));
    await keepMeet(res.meetUrl);
    return { created: res.id, meetUrl: event.meet ? res.meetUrl : undefined };
  } catch (err) {
    await recordError(db, conn, err);
    throw err;
  }
}

export const calendarSyncJob = defineJob({
  name: "calendar.sync",
  payload: z.object({
    viewingId: z.uuid(),
    previous: z
      .object({ agentId: z.uuid(), eventId: z.string().min(1) })
      .nullable()
      .default(null),
  }),
  maxAttempts: 5,
  run: ({ viewingId, previous }, { db }) => syncViewingEvent(db, viewingId, previous),
});

/** Settings -> Integrations "Test connection": Google accepts the OAuth client. */
export async function testGoogleCalendar(db?: DbOrTx) {
  const conn = db ?? (await getDb());
  const { googleCalendar } = await loadSettings("integrations", conn);
  if (!googleCalendar.clientId) return { ok: false, message: "Enter the OAuth client ID first." };
  const secret = await getSecret("google_oauth_client_secret", conn);
  if (!secret) return { ok: false, message: "Add the OAuth client secret first." };
  let result: { ok: boolean; message: string };
  try {
    // A made-up refresh token: "invalid_grant" means Google knows the client.
    await calendarApi().refresh({
      refreshToken: "propel-connection-test",
      clientId: googleCalendar.clientId,
      clientSecret: secret,
    });
    result = { ok: true, message: "Connected" };
  } catch (err) {
    const message = (err as Error).message;
    if (/invalid_grant/i.test(message)) {
      const connected = await conn
        .select({ id: calendarConnections.id })
        .from(calendarConnections)
        .where(eq(calendarConnections.agencyId, currentAgencyId()));
      result = {
        ok: true,
        message: `The OAuth client works (${connected.length} agent calendar${connected.length === 1 ? "" : "s"} connected)`,
      };
    } else result = { ok: false, message };
  }
  await recordIntegrationResult(
    "google_oauth_client_secret",
    result.ok ? null : result.message,
    conn,
  );
  return result;
}

/** Connection details shown on the agents screen. */
export async function calendarStatusByAgent(db: DbOrTx, agentIds: string[]) {
  if (agentIds.length === 0) return {};
  const rows = await db
    .select({
      agentId: calendarConnections.agentId,
      accountEmail: calendarConnections.accountEmail,
      lastSyncAt: calendarConnections.lastSyncAt,
      lastError: calendarConnections.lastError,
    })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.agencyId, currentAgencyId()),
        inArray(calendarConnections.agentId, agentIds),
      ),
    );
  return Object.fromEntries(
    rows.map((r) => [
      r.agentId,
      {
        accountEmail: r.accountEmail,
        lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
        lastError: r.lastError,
      },
    ]),
  ) as Record<
    string,
    { accountEmail: string | null; lastSyncAt: string | null; lastError: string | null }
  >;
}
