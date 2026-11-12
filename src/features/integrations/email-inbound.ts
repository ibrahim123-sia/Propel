import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { contacts, leads, messages } from "@/db/schema/crm";
import { emailLog } from "@/db/schema/system";
import { leadIdFromAddress, parseAddress } from "@/features/inbox/rules";
import { addIncoming, ensureConversation } from "@/features/inbox/store";
import { capturePortalLead } from "@/features/portals/capture";
import { EmailParsingConnector } from "@/features/portals/connector";
import { htmlToText, stripQuotedReply } from "@/features/portals/email-parser";
import { loadSettings } from "@/features/settings/queries";
import { smtpFromEnv } from "@/lib/email/config";

export type InboundEmail = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** The email's Message-ID (or the provider's id): each email is stored once. */
  messageId: string | null;
  receivedAt: Date;
};

export type InboundResult =
  | { kind: "lead_reply"; leadId: string; conversationId: string }
  | { kind: "portal"; portal: string; leadId: string | null }
  | { kind: "conversation"; conversationId: string }
  | { kind: "ignored"; reason: string };

/**
 * An email that reached the inbound domain (13 §1 "Inbound email"):
 * - to lead+<id>@<domain>: the lead's email conversation and timeline (email_received);
 * - to a portal inbox (Settings -> Leads): a portal lead, parsed;
 * - anything else: an email conversation with that person in the inbox.
 */
export async function handleInboundEmail(db: Db, email: InboundEmail): Promise<InboundResult> {
  const sender = parseAddress(email.from);
  if (!sender) return { kind: "ignored", reason: "no sender" };
  const externalId = email.messageId ? `inbound:${email.messageId}`.slice(0, 300) : null;
  if (externalId) {
    const [seen] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.agencyId, currentAgencyId()), eq(messages.externalId, externalId)))
      .limit(1);
    if (seen) return { kind: "ignored", reason: "duplicate" };
  }
  const { resend } = await loadSettings("integrations", db);
  const leadSettings = await loadSettings("leads", db);
  const recipients = [...email.to, ...(email.cc ?? [])]
    .map((a) => parseAddress(a)?.email)
    .filter((a): a is string => Boolean(a));
  const full = email.text?.trim() || (email.html ? htmlToText(email.html) : "");
  const subject = email.subject.trim().slice(0, 300) || "(no subject)";

  // Our own outgoing mail coming back (loops, bounces to the inbound address): ignore.
  const ownAddress = smtpFromEnv()?.user.toLowerCase();
  if (ownAddress && sender.email === ownAddress)
    return { kind: "ignored", reason: "our own address" };

  for (const address of recipients) {
    const leadId = leadIdFromAddress(address, resend.inboundDomain);
    if (!leadId) continue;
    const [lead] = await db
      .select({ id: leads.id, contactId: leads.contactId })
      .from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.agencyId, currentAgencyId())));
    if (!lead) break;
    const conv = await ensureConversation(db, {
      channel: "email",
      contactId: lead.contactId,
      leadId: lead.id,
      subject,
      now: email.receivedAt,
    });
    await addIncoming(db, {
      conversationId: conv.id,
      body: stripQuotedReply(full) || subject,
      externalId,
      at: email.receivedAt,
    });
    return { kind: "lead_reply", leadId: lead.id, conversationId: conv.id };
  }

  const portal = leadSettings.portalInboxes.find((p) =>
    recipients.includes(p.address.toLowerCase()),
  );
  if (portal) {
    const general = await loadSettings("general", db);
    const connector = new EmailParsingConnector(
      portal.portal,
      portal.portal,
      general.referencePrefix,
    );
    const lead = connector.normaliseLead({ subject, text: full });
    if (!lead) return { kind: "ignored", reason: "portal email without a way to reach the lead" };
    const res = await capturePortalLead(db, {
      portal: portal.portal,
      lead,
      via: "email",
      now: email.receivedAt,
    });
    return { kind: "portal", portal: portal.portal, leadId: res?.leadId ?? null };
  }

  // Someone wrote to the agency: their email conversation (and their open lead, if any).
  let [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.agencyId, currentAgencyId()),
        eq(contacts.email, sender.email),
        isNull(contacts.mergedIntoId),
      ),
    )
    .orderBy(asc(contacts.createdAt))
    .limit(1);
  if (!contact)
    [contact] = await db
      .insert(contacts)
      .values({ name: sender.name ?? sender.email, email: sender.email })
      .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(eq(leads.contactId, contact!.id), eq(leads.status, "open"), isNull(leads.mergedIntoId)),
    )
    .limit(1);
  const conv = await ensureConversation(db, {
    channel: "email",
    contactId: contact!.id,
    leadId: open?.id ?? null,
    subject,
    now: email.receivedAt,
  });
  await addIncoming(db, {
    conversationId: conv.id,
    body: stripQuotedReply(full) || subject,
    externalId,
    at: email.receivedAt,
  });
  return { kind: "conversation", conversationId: conv.id };
}

/** Delivery events from Resend for emails we sent: bounces and failures are marked. */
export async function applyEmailEvent(db: Db, type: string, providerId: string, reason?: string) {
  if (type !== "email.bounced" && type !== "email.failed" && type !== "email.complained") return;
  await db
    .update(emailLog)
    .set({ status: "failed", error: (reason ?? type.replace("email.", "")).slice(0, 300) })
    .where(eq(emailLog.providerId, providerId));
}
