import "server-only";
import { base64UrlToBytes } from "@/lib/crypto";

/**
 * Google Calendar and Google OAuth (13 §1), behind an interface so tests use a fake. Only the
 * calls Propel needs: the OAuth code exchange and refresh, the agent's events (for busy times)
 * and creating, updating and deleting a viewing's event.
 */
export type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string | null;
  /** The signed-in account's email, from the ID token. */
  email: string | null;
};

export type CalendarEvent = {
  summary: string;
  description: string;
  location?: string;
  start: Date;
  end: Date;
  /** Our viewing id, so our own events are never read back as busy time. */
  viewingId: string;
  /** Ask Google to add a Meet link (video viewings with Google Meet as the video tool). */
  meet?: boolean;
};

/** What Google answers for a written event: its id and the Meet link when one was asked for. */
export type WrittenEvent = { id: string; meetUrl: string | null };

export type BusyEvent =
  { start: Date; end: Date } | { allDay: true; startDate: string; endDate: string };

export interface CalendarApi {
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<TokenResponse>;
  refresh(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<Omit<TokenResponse, "refreshToken" | "email">>;
  revoke(token: string): Promise<void>;
  /** Events that make the agent busy between two instants (not ours, not free, not declined). */
  busy(accessToken: string, calendarId: string, from: Date, to: Date): Promise<BusyEvent[]>;
  insertEvent(accessToken: string, calendarId: string, event: CalendarEvent): Promise<WrittenEvent>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: CalendarEvent,
  ): Promise<WrittenEvent>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

export class CalendarApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
const timeout = () => AbortSignal.timeout(15_000);

async function failure(res: Response): Promise<CalendarApiError> {
  const body = (await res.json().catch(() => null)) as {
    error?: string | { message?: string };
    error_description?: string;
  } | null;
  const text =
    body?.error_description ??
    (typeof body?.error === "string" ? body.error : body?.error?.message) ??
    res.statusText;
  return new CalendarApiError(
    `Google answered ${res.status}: ${String(text).slice(0, 200)}`,
    res.status,
  );
}

/** The email in an OpenID ID token (no signature check needed: it came straight from Google). */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(idToken.split(".")[1]!)),
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function tokenCall(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: timeout(),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };
}

const eventBody = (e: CalendarEvent) => ({
  summary: e.summary,
  description: e.description,
  location: e.location,
  start: { dateTime: e.start.toISOString() },
  end: { dateTime: e.end.toISOString() },
  extendedProperties: { private: { propelViewingId: e.viewingId } },
  // One request id per viewing: Google makes one Meet link and returns the same one again.
  ...(e.meet
    ? {
        conferenceData: {
          createRequest: {
            requestId: `propel-${e.viewingId}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }
    : {}),
});

/** The written event's id and Meet link (the link may only appear once Google made it). */
async function written(res: Response): Promise<WrittenEvent> {
  const body = (await res.json()) as {
    id: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  };
  const video = body.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return { id: body.id, meetUrl: body.hangoutLink ?? video ?? null };
}

/** `conferenceDataVersion=1` lets the request create a Meet link. */
const withConference = (url: string, e: CalendarEvent) =>
  e.meet ? `${url}?conferenceDataVersion=1` : url;

export const googleCalendarApi: CalendarApi = {
  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    const t = await tokenCall({
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
    });
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresIn: t.expires_in,
      scope: t.scope ?? null,
      email: emailFromIdToken(t.id_token),
    };
  },
  async refresh({ refreshToken, clientId, clientSecret }) {
    const t = await tokenCall({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    });
    return { accessToken: t.access_token, expiresIn: t.expires_in, scope: t.scope ?? null };
  },
  async revoke(token) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      signal: timeout(),
    }).catch(() => undefined);
  },
  async busy(accessToken, calendarId, from, to) {
    const out: BusyEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        maxResults: "250",
        fields:
          "nextPageToken,items(status,transparency,start,end,attendees(self,responseStatus),extendedProperties)",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const res = await fetch(
        `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
        { headers: { authorization: `Bearer ${accessToken}` }, signal: timeout() },
      );
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as {
        nextPageToken?: string;
        items?: Array<{
          status?: string;
          transparency?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          attendees?: Array<{ self?: boolean; responseStatus?: string }>;
          extendedProperties?: { private?: Record<string, string> };
        }>;
      };
      for (const item of body.items ?? []) {
        if (item.status === "cancelled" || item.transparency === "transparent") continue;
        // Our own viewings are already busy times. Events made before the rename (2026-10-27)
        // carry the old key name.
        const mine = item.extendedProperties?.private;
        if (mine?.propelViewingId || mine?.keylineViewingId) continue;
        if (item.attendees?.some((a) => a.self && a.responseStatus === "declined")) continue;
        if (item.start?.dateTime && item.end?.dateTime)
          out.push({ start: new Date(item.start.dateTime), end: new Date(item.end.dateTime) });
        else if (item.start?.date && item.end?.date)
          out.push({ allDay: true, startDate: item.start.date, endDate: item.end.date });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },
  async insertEvent(accessToken, calendarId, event) {
    const res = await fetch(
      withConference(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`, event),
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(eventBody(event)),
        signal: timeout(),
      },
    );
    if (!res.ok) throw await failure(res);
    return written(res);
  },
  async updateEvent(accessToken, calendarId, eventId, event) {
    const res = await fetch(
      withConference(
        `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        event,
      ),
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(eventBody(event)),
        signal: timeout(),
      },
    );
    if (!res.ok) throw await failure(res);
    return written(res);
  },
  async deleteEvent(accessToken, calendarId, eventId) {
    const res = await fetch(
      `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
        signal: timeout(),
      },
    );
    // Already gone counts as done.
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await failure(res);
  },
};

let current: CalendarApi = googleCalendarApi;

/** Tests swap in a fake; `null` puts the real one back. */
export function setCalendarApi(api: CalendarApi | null): void {
  current = api ?? googleCalendarApi;
}

export const calendarApi = (): CalendarApi => current;
