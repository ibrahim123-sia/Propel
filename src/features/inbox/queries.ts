import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { users } from "@/db/schema/auth";
import {
  approvalQueue,
  contacts,
  conversations,
  leads,
  messages,
  quickReplies,
} from "@/db/schema/crm";
import { leadStages } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { agents } from "@/db/schema/people";
import { properties, propertyMedia } from "@/db/schema/properties";
import { emailLog } from "@/db/schema/system";
import { mediaUrl } from "@/features/media/queries";
import { liveStatuses } from "@/features/properties/status";
import type { Channel, ConversationStatus } from "./store";

export type InboxFilter = {
  status: "open" | "all" | ConversationStatus;
  channel: Channel | "all";
  q: string;
  unread: boolean;
};

export type ConversationListItem = {
  id: string;
  channel: Channel;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  subject: string | null;
  leadId: string | null;
  contactName: string | null;
  contactDetail: string | null;
  lastBody: string | null;
  lastSender: "customer" | "ai" | "admin" | "system" | null;
};

/** The inbox list (09 §6): newest first, filtered by status, channel, unread and a search. */
export async function listConversations(
  db: DbOrTx,
  filter: InboxFilter,
): Promise<ConversationListItem[]> {
  const where = [sql`c.agency_id = ${currentAgencyId()}`];
  if (filter.status === "open") where.push(sql`c.status <> 'closed'`);
  else if (filter.status !== "all") where.push(sql`c.status = ${filter.status}`);
  if (filter.channel !== "all") where.push(sql`c.channel = ${filter.channel}`);
  if (filter.unread) where.push(sql`c.unread_count > 0`);
  const q = filter.q.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    where.push(
      sql`(ct.name ilike ${like} or ct.email ilike ${like} or ct.phone ilike ${like} or c.subject ilike ${like}
        or exists (select 1 from messages m2 where m2.conversation_id = c.id and m2.body ilike ${like}))`,
    );
  }
  const res = await db.execute<{
    id: string;
    channel: Channel;
    status: ConversationStatus;
    unread_count: number;
    last_message_at: string | null;
    subject: string | null;
    lead_id: string | null;
    name: string | null;
    detail: string | null;
    body: string | null;
    sender: ConversationListItem["lastSender"];
  }>(sql`
    select c.id, c.channel, c.status, c.unread_count, c.last_message_at, c.subject, c.lead_id,
      ct.name, coalesce(ct.phone, ct.whatsapp, ct.email) as detail, lm.body, lm.sender
    from conversations c
    left join contacts ct on ct.id = c.contact_id
    left join lateral (
      select body, sender from messages m where m.conversation_id = c.id
      order by m.created_at desc limit 1
    ) lm on true
    where ${sql.join(where, sql` and `)}
    order by coalesce(c.last_message_at, c.created_at) desc
    limit 100`);
  return res.rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    status: r.status,
    unreadCount: Number(r.unread_count),
    lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
    subject: r.subject,
    leadId: r.lead_id,
    contactName: r.name,
    contactDetail: r.detail,
    lastBody: r.body,
    lastSender: r.sender,
  }));
}

export type InboxMessage = {
  id: string;
  direction: "in" | "out";
  sender: "customer" | "ai" | "admin" | "system";
  senderName: string | null;
  body: string;
  attachments: Array<{ url?: string; name: string; mime: string }>;
  toolCalls: Array<{ tool: string; summary: string }>;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  error: string | null;
  /** An assistant answer an admin flagged as bad (10 §2), with what was wrong. */
  flag: { at: string; note: string | null } | null;
  createdAt: string;
};

/** One conversation with its people, lead and messages (oldest first). */
export async function loadConversation(db: DbOrTx, id: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.agencyId, currentAgencyId())));
  if (!conv) return null;
  const [contact] = conv.contactId
    ? await db.select().from(contacts).where(eq(contacts.id, conv.contactId))
    : [];
  const [lead] = conv.leadId
    ? await db
        .select({
          id: leads.id,
          type: leads.type,
          status: leads.status,
          stage: leadStages.name,
          agent: agents.name,
        })
        .from(leads)
        .leftJoin(leadStages, eq(leadStages.id, leads.stageId))
        .leftJoin(agents, eq(agents.id, leads.agentId))
        .where(eq(leads.id, conv.leadId))
    : [];
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conv.id))
    .orderBy(asc(messages.createdAt))
    .limit(500);
  const adminIds = [...new Set(rows.map((m) => m.senderAdminId).filter((x): x is string => !!x))];
  const names = adminIds.length
    ? new Map(
        (
          await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, adminIds))
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();
  // Email replies: their delivery state lives in the email log.
  const emailIds = rows
    .map((m) => m.externalId)
    .filter((x): x is string => !!x && x.startsWith("email:"))
    .map((x) => x.slice(6));
  const emails = emailIds.length
    ? new Map(
        (
          await db
            .select({ id: emailLog.id, status: emailLog.status, error: emailLog.error })
            .from(emailLog)
            .where(inArray(emailLog.id, emailIds))
        ).map((e) => [e.id, e]),
      )
    : new Map();
  const list: InboxMessage[] = rows.map((m) => {
    let status = m.status;
    let error = m.error;
    if (m.externalId?.startsWith("email:")) {
      const e = emails.get(m.externalId.slice(6)) as
        { status: "queued" | "sent" | "mocked" | "failed"; error: string | null } | undefined;
      if (e) {
        status = e.status === "mocked" ? "sent" : e.status;
        error =
          e.status === "mocked"
            ? "Kept in the email log: no email provider is set up."
            : (e.error ?? null);
      }
    }
    return {
      id: m.id,
      direction: m.direction,
      sender: m.sender,
      senderName: m.senderAdminId ? (names.get(m.senderAdminId) ?? null) : null,
      body: m.body,
      attachments: m.attachments,
      toolCalls: m.toolCalls,
      status,
      error,
      flag: m.flaggedAt ? { at: m.flaggedAt.toISOString(), note: m.flagNote } : null,
      createdAt: m.createdAt.toISOString(),
    };
  });
  const approvals = await db
    .select()
    .from(approvalQueue)
    .where(and(eq(approvalQueue.conversationId, conv.id), eq(approvalQueue.status, "pending")))
    .orderBy(asc(approvalQueue.createdAt));
  return {
    conversation: {
      id: conv.id,
      channel: conv.channel,
      status: conv.status,
      subject: conv.subject,
      externalId: conv.externalId,
      unreadCount: conv.unreadCount,
      waWindowExpiresAt: conv.waWindowExpiresAt?.toISOString() ?? null,
      aiSummary: conv.aiSummary,
      leadId: conv.leadId,
    },
    contact: contact
      ? {
          id: contact.id,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          whatsapp: contact.whatsapp,
        }
      : null,
    lead: lead ?? null,
    messages: list,
    approvals: approvals.map((a) => ({
      id: a.id,
      draftReply: a.draftReply,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
export type ConversationDetail = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;

/** Replies the AI was not allowed to send (09 §6 approval queue), oldest first. */
export async function listApprovals(db: DbOrTx) {
  const rows = await db
    .select({
      id: approvalQueue.id,
      conversationId: approvalQueue.conversationId,
      draftReply: approvalQueue.draftReply,
      reason: approvalQueue.reason,
      createdAt: approvalQueue.createdAt,
      channel: conversations.channel,
      contactName: contacts.name,
    })
    .from(approvalQueue)
    .innerJoin(conversations, eq(conversations.id, approvalQueue.conversationId))
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(eq(approvalQueue.agencyId, currentAgencyId()), eq(approvalQueue.status, "pending")))
    .orderBy(asc(approvalQueue.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
export type ApprovalItem = Awaited<ReturnType<typeof listApprovals>>[number];

export async function listQuickReplies(db: DbOrTx) {
  return db
    .select({ id: quickReplies.id, title: quickReplies.title, body: quickReplies.body })
    .from(quickReplies)
    .where(eq(quickReplies.agencyId, currentAgencyId()))
    .orderBy(asc(quickReplies.sortOrder), asc(quickReplies.title));
}
export type QuickReply = Awaited<ReturnType<typeof listQuickReplies>>[number];

/** Badges for the inbox tabs. */
export async function inboxCounts(db: DbOrTx) {
  const res = await db.execute<{ needs_human: number; unread: number; approvals: number }>(sql`
    select
      (select count(*)::int from conversations where agency_id = ${currentAgencyId()} and status = 'needs_human') as needs_human,
      (select count(*)::int from conversations where agency_id = ${currentAgencyId()} and status <> 'closed' and unread_count > 0) as unread,
      (select count(*)::int from approval_queue where agency_id = ${currentAgencyId()} and status = 'pending') as approvals`);
  const r = res.rows[0]!;
  return {
    needsHuman: Number(r.needs_human),
    unread: Number(r.unread),
    approvals: Number(r.approvals),
  };
}

/** Live listings by reference or title, for "send listing card" (09 §6). */
export async function findListingsForCards(db: DbOrTx, q: string, id?: string) {
  const term = q.trim();
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await db
    .select({
      id: properties.id,
      reference: properties.reference,
      title: properties.title,
      slug: properties.slug,
      price: properties.price,
      currency: properties.currency,
      purpose: properties.purpose,
      priceOnRequest: properties.priceOnRequest,
      pricePeriod: properties.pricePeriod,
    })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, currentAgencyId()),
        sql`${properties.deletedAt} is null`,
        inArray(properties.status, [...liveStatuses]),
        id ? eq(properties.id, id) : sql`true`,
        term
          ? sql`(${properties.reference} ilike ${like} or ${properties.title} ilike ${like})`
          : sql`true`,
      ),
    )
    .orderBy(sql`${properties.publishedAt} desc nulls last`)
    .limit(8);
  return rows;
}
export type ListingForCard = Awaited<ReturnType<typeof findListingsForCards>>[number];

/** A listing's first photo and its brochure (PDF), as public URLs. */
export async function listingFiles(db: DbOrTx, propertyId: string) {
  const files = await db
    .select({ kind: propertyMedia.kind, key: media.r2Key, mime: media.mime })
    .from(propertyMedia)
    .innerJoin(media, eq(media.id, propertyMedia.mediaId))
    .where(eq(propertyMedia.propertyId, propertyId))
    .orderBy(asc(propertyMedia.sortOrder));
  const photo = files.find((f) => f.kind === "photo");
  const brochure = files.find((f) => f.kind === "brochure" && f.mime === "application/pdf");
  return {
    photoUrl: photo ? mediaUrl(photo.key) : null,
    brochureUrl: brochure ? mediaUrl(brochure.key) : null,
  };
}
