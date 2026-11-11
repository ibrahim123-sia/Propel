import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db/client";
import { alertsSent, customerPreferences, savedSearches } from "@/db/schema/customer";
import { queueWhatsappNotice } from "@/features/integrations/whatsapp/jobs";
import { loadListingCards } from "@/features/listings/cards";
import type { TemplateKey } from "@/features/messages/defaults";
import { queueEmail } from "@/features/notifications/email";
import { searchHref } from "@/features/search/params";
import { siteUrl } from "@/features/site/url";
import { savedSearchFilters } from "./filters";
import type { AlertSearch } from "./match";
import { alertCards, renderAlertEmail } from "./render";
import {
  preferenceUnsubscribeToken,
  searchUnsubscribeToken,
  unsubscribeTokenHash,
  type PreferenceKind,
} from "./tokens";

export type AlertKind = "new_match" | "price_drop" | "status_change" | "similar_home";
type Channels = { email: boolean; whatsapp: boolean };
type Preferences = Record<"newMatch" | "priceDrop" | "statusChange", Channels> & {
  whatsappOptIn: boolean;
};
type Recipient = { userId: string; name: string; email: string; phone: string | null };

const MAX_CARDS = 6;

/** Another job claimed some of the same alerts first: the transaction rolls back and retries. */
export class AlertRaceError extends Error {}

/** A customer's alert choices (12 §2), email on and WhatsApp off until they choose. */
export async function alertPreferences(db: DbOrTx, userId: string): Promise<Preferences> {
  const [row] = await db
    .select()
    .from(customerPreferences)
    .where(eq(customerPreferences.userId, userId));
  const on = { email: true, whatsapp: false };
  return {
    newMatch: row?.newMatch ?? on,
    priceDrop: row?.priceDrop ?? on,
    statusChange: row?.statusChange ?? on,
    whatsappOptIn: Boolean(row?.whatsappOptInAt),
  };
}

type Target = { savedSearchId: string | null; savedHomeId: string | null };

/** Listings among `ids` not alerted yet for this search (or saved home), kind and change. */
async function notYetSent(
  db: DbOrTx,
  target: Target,
  ids: string[],
  kind: AlertKind,
  detail: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const sent = await db
    .select({ propertyId: alertsSent.propertyId })
    .from(alertsSent)
    .where(
      and(
        target.savedSearchId
          ? eq(alertsSent.savedSearchId, target.savedSearchId)
          : eq(alertsSent.savedHomeId, target.savedHomeId!),
        inArray(alertsSent.propertyId, ids),
        eq(alertsSent.kind, kind),
        eq(alertsSent.detail, detail),
      ),
    );
  const done = new Set(sent.map((r) => r.propertyId));
  return ids.filter((id) => !done.has(id));
}

/**
 * Records the alerts going out (alerts_sent). Every one must be new: a listing is never sent
 * twice for the same search or saved home, kind and change (12 §3).
 */
async function claim(
  tx: DbOrTx,
  target: Target,
  ids: string[],
  kind: AlertKind,
  detail: string,
  now: Date,
) {
  const rows = await tx
    .insert(alertsSent)
    .values(ids.map((propertyId) => ({ ...target, propertyId, kind, detail, sentAt: now })))
    .onConflictDoNothing()
    .returning({ propertyId: alertsSent.propertyId });
  if (rows.length !== ids.length) throw new AlertRaceError("another alert job sent some of these");
}

type Prepared = {
  email: { to: string; subject: string; html: string; text: string } | null;
  whatsapp: { to: string; vars: Record<string, string | number | null> } | null;
};

/** The email and WhatsApp notice for one alert, rendered before any transaction starts. */
async function prepare(
  db: DbOrTx,
  input: {
    to: Recipient;
    channels: Channels;
    whatsappOptIn: boolean;
    key: TemplateKey;
    vars: Record<string, string | number | null>;
    propertyIds: string[];
    notes?: Map<string, string>;
    link: string;
    manageUrl: string;
    unsubscribeUrl: string;
    unsubscribeLabel: string;
  },
): Promise<Prepared> {
  let email: Prepared["email"] = null;
  if (input.channels.email && input.to.email) {
    const listings = await loadListingCards(db, input.propertyIds.slice(0, MAX_CARDS));
    const rendered = await renderAlertEmail(db, input.key, input.vars, {
      cards: await alertCards(db, listings, input.notes),
      more: Math.max(0, input.propertyIds.length - MAX_CARDS),
      link: input.link,
      manageUrl: input.manageUrl,
      unsubscribeUrl: input.unsubscribeUrl,
      unsubscribeLabel: input.unsubscribeLabel,
    });
    if (rendered) email = { to: input.to.email, ...rendered };
  }
  // WhatsApp only with the customer's opt-in, and only as an approved template (12 §3).
  const whatsapp =
    input.channels.whatsapp && input.whatsappOptIn && input.to.phone
      ? { to: input.to.phone, vars: { ...input.vars, url: input.link } }
      : null;
  return { email, whatsapp };
}

async function queue(
  tx: DbOrTx,
  prepared: Prepared,
  meta: {
    key: TemplateKey;
    unsubscribeUrl: string;
    related: { type: string; id: string };
    dedupeKey: string;
  },
) {
  if (prepared.email)
    await queueEmail(
      {
        ...prepared.email,
        template: meta.key,
        related: meta.related,
        // One-click unsubscribe from the mail app (RFC 8058).
        headers: {
          "List-Unsubscribe": `<${meta.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
      tx,
    );
  if (prepared.whatsapp)
    await queueWhatsappNotice(tx, {
      to: prepared.whatsapp.to,
      key: meta.key,
      vars: prepared.whatsapp.vars,
      dedupeKey: meta.dedupeKey,
    });
}

const homesText = (n: number) => `${n} new ${n === 1 ? "home" : "homes"}`;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * New matches for a saved search, at once or in a digest (12 §3): up to six cards, "View
 * all matches", manage alerts and one-click unsubscribe for this search. Returns how many
 * listings were new for it.
 */
export async function sendSearchAlert(
  db: Db,
  search: AlertSearch,
  propertyIds: string[],
  mode: "instant" | "daily" | "weekly",
  now = new Date(),
): Promise<number> {
  const target = { savedSearchId: search.id, savedHomeId: null };
  const prefs = await alertPreferences(db, search.userId);
  const token = await searchUnsubscribeToken(search.id);
  const touch = {
    lastSentAt: now,
    ...(search.unsubscribeTokenHash
      ? {}
      : { unsubscribeTokenHash: await unsubscribeTokenHash(token) }),
  };
  const on = prefs.newMatch.email || (prefs.newMatch.whatsapp && prefs.whatsappOptIn);
  const fresh = on ? await notYetSent(db, target, [...new Set(propertyIds)], "new_match", "") : [];
  if (fresh.length === 0) {
    // The window still moves on, so turning alerts back on starts from now.
    await db.update(savedSearches).set(touch).where(eq(savedSearches.id, search.id));
    return 0;
  }
  const url = siteUrl(searchHref(savedSearchFilters(search.filters, search.polygon)));
  const key: TemplateKey = mode === "instant" ? "alerts.new_match" : "alerts.digest";
  const unsubscribeUrl = siteUrl(`/api/alerts/unsubscribe?token=${token}`);
  const prepared = await prepare(db, {
    to: search,
    channels: prefs.newMatch,
    whatsappOptIn: prefs.whatsappOptIn,
    key,
    vars: {
      name: firstName(search.userName),
      search: search.name,
      count: fresh.length,
      homes: homesText(fresh.length),
      period: mode === "weekly" ? "this week" : "today",
      url,
    },
    propertyIds: fresh,
    link: url,
    manageUrl: siteUrl("/account/searches"),
    unsubscribeUrl,
    unsubscribeLabel: "Stop alerts for this search",
  });
  await db.transaction(async (tx) => {
    await claim(tx, target, fresh, "new_match", "", now);
    await tx.update(savedSearches).set(touch).where(eq(savedSearches.id, search.id));
    await queue(tx, prepared, {
      key,
      unsubscribeUrl,
      related: { type: "saved_search", id: search.id },
      dedupeKey: `alerts:${search.id}:${fresh.join(",")}`.slice(0, 500),
    });
  });
  return fresh.length;
}

const homeAlerts = {
  price_drop: { pref: "priceDrop", key: "alerts.price_drop", stop: "Stop price drop emails" },
  status_change: { pref: "statusChange", key: "alerts.status_change", stop: "Stop status emails" },
  similar_home: { pref: "newMatch", key: "alerts.similar_home", stop: "Stop new home emails" },
} as const satisfies Record<string, { pref: PreferenceKind; key: TemplateKey; stop: string }>;

/**
 * One saved home (or one matching instant search) about one listing: a price drop, a status
 * change, or a new listing like the saved one. `detail` (the new price or status) makes a later change send again while
 * the same change never sends twice.
 */
export async function sendHomeAlert(
  db: Db,
  input: {
    to: Recipient;
    savedHomeId?: string | null;
    savedSearchId?: string | null;
    propertyId: string;
    kind: keyof typeof homeAlerts;
    detail: string;
    note: string;
    vars: Record<string, string | number | null>;
    /** The listing's page path. */
    path: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const target = {
    savedSearchId: input.savedSearchId ?? null,
    savedHomeId: input.savedHomeId ?? null,
  };
  const prefs = await alertPreferences(db, input.to.userId);
  const { pref, key, stop } = homeAlerts[input.kind];
  const channels = prefs[pref];
  if (!channels.email && !(channels.whatsapp && prefs.whatsappOptIn)) return false;
  if ((await notYetSent(db, target, [input.propertyId], input.kind, input.detail)).length === 0)
    return false;

  const searchToken = target.savedSearchId
    ? await searchUnsubscribeToken(target.savedSearchId)
    : null;
  const unsubscribeUrl = searchToken
    ? siteUrl(`/api/alerts/unsubscribe?token=${searchToken}`)
    : siteUrl(
        `/api/alerts/unsubscribe?pref=${await preferenceUnsubscribeToken(input.to.userId, pref)}`,
      );
  const url = siteUrl(input.path);
  const prepared = await prepare(db, {
    to: input.to,
    channels,
    whatsappOptIn: prefs.whatsappOptIn,
    key,
    vars: { ...input.vars, name: firstName(input.to.name), url },
    propertyIds: [input.propertyId],
    notes: new Map([[input.propertyId, input.note]]),
    link: url,
    manageUrl: siteUrl(target.savedSearchId ? "/account/searches" : "/account/notifications"),
    unsubscribeUrl,
    unsubscribeLabel: target.savedSearchId ? "Stop alerts for this search" : stop,
  });
  try {
    await db.transaction(async (tx) => {
      await claim(tx, target, [input.propertyId], input.kind, input.detail, now);
      if (target.savedSearchId && searchToken)
        await tx
          .update(savedSearches)
          .set({ unsubscribeTokenHash: await unsubscribeTokenHash(searchToken) })
          .where(
            and(
              eq(savedSearches.id, target.savedSearchId),
              isNull(savedSearches.unsubscribeTokenHash),
            ),
          );
      await queue(tx, prepared, {
        key,
        unsubscribeUrl,
        related: {
          type: target.savedHomeId ? "saved_home" : "saved_search",
          id: (target.savedHomeId ?? target.savedSearchId)!,
        },
        dedupeKey: `alerts:${input.kind}:${target.savedHomeId ?? target.savedSearchId}:${input.propertyId}:${input.detail}`,
      });
    });
  } catch (err) {
    // A single alert claimed by another job is simply already sent.
    if (err instanceof AlertRaceError) return false;
    throw err;
  }
  return true;
}
