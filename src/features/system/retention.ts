import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { contacts, conversations, leads, visitorEvents } from "@/db/schema/crm";
import { anonymiseContacts } from "@/features/account/privacy";
import { loadSettings } from "@/features/settings/queries";
import { writeAudit } from "@/lib/audit";

/**
 * The nightly data retention clean-up (04 §11, 13 §2 "Daily 02:00", 14 §3), with the periods
 * from Settings -> Legal and privacy:
 * - website chats nobody left details in (no contact, no lead) go after `guestChatMonths`
 *   without a message;
 * - people whose every lead was lost more than `anonymiseLostLeadsMonths` ago are anonymised,
 *   unless they have a customer account (that is theirs to delete) or something newer;
 * - visitor journey events go after 180 days (05 §9; the counts the reports need are kept on
 *   the listings and leads).
 * Each run works in batches, so a first run on a large database finishes over a few nights.
 */
export const VISITOR_EVENT_DAYS = 180;
const BATCH = 500;
export const ANONYMISED_NAME = "Anonymised contact";

const monthsAgo = (now: Date, months: number) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
};

export async function runRetention(db: Db, now: Date = new Date()) {
  const agency = currentAgencyId();
  const { retention } = await loadSettings("legal", db);
  const chatCutoff = monthsAgo(now, retention.guestChatMonths).toISOString();
  const leadCutoff = monthsAgo(now, retention.anonymiseLostLeadsMonths).toISOString();
  const eventCutoff = new Date(now.getTime() - VISITOR_EVENT_DAYS * 86_400_000).toISOString();

  const guestChats = await db.execute<{ id: string }>(sql`
    delete from ${conversations} where id in (
      select id from ${conversations}
      where agency_id = ${agency} and channel = 'web_chat'
        and contact_id is null and lead_id is null
        and coalesce(last_message_at, created_at) < ${chatCutoff}::timestamptz
      limit ${BATCH})
    returning id`);

  const due = await db.execute<{ id: string }>(sql`
    select c.id from ${contacts} c
    where c.agency_id = ${agency} and c.user_id is null and c.merged_into_id is null
      and (c.email is not null or c.phone is not null or c.whatsapp is not null
           or c.name <> ${ANONYMISED_NAME})
      and exists (select 1 from ${leads} l where l.contact_id = c.id)
      and not exists (
        select 1 from ${leads} l where l.contact_id = c.id
          and (l.status <> 'lost' or coalesce(l.lost_at, l.updated_at) >= ${leadCutoff}::timestamptz))
      and c.updated_at < ${leadCutoff}::timestamptz
    limit ${BATCH}`);
  const contactIds = due.rows.map((r) => r.id);
  if (contactIds.length)
    await db.transaction(async (tx) => {
      await anonymiseContacts(tx, contactIds, ANONYMISED_NAME);
      await writeAudit(tx, {
        actor: { type: "system", id: null },
        action: "retention.anonymise",
        entityType: "contact",
        entityId: null,
        after: { contacts: contactIds.length, months: retention.anonymiseLostLeadsMonths },
      });
    });

  const events = await db.execute<{ id: string }>(sql`
    delete from ${visitorEvents} where id in (
      select id from ${visitorEvents}
      where agency_id = ${agency} and created_at < ${eventCutoff}::timestamptz
      limit ${BATCH * 20})
    returning id`);

  return {
    guestChats: guestChats.rows.length,
    anonymisedContacts: contactIds.length,
    visitorEvents: events.rows.length,
  };
}
