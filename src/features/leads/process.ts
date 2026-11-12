import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { contacts, leadEvents, leads, viewings } from "@/db/schema/crm";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { properties } from "@/db/schema/properties";
import { emailLog } from "@/db/schema/system";
import { insideWindow, leadReplyAddress, templateParameters, waId } from "@/features/inbox/rules";
import { ensureConversation, sendOutgoing } from "@/features/inbox/store";
import { queueWhatsappNotice } from "@/features/integrations/whatsapp/jobs";
import { fillTemplate, type TemplateKey } from "@/features/messages/defaults";
import { loadTemplate, renderTemplateEmail } from "@/features/messages/render";
import { queueEmail } from "@/features/notifications/email";
import { loadSettings } from "@/features/settings/queries";
import { siteUrl } from "@/features/site/url";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { leads as t } from "@/lib/i18n/dictionaries/leads";
import { scoreLeadWithAi } from "@/features/ai/scoring";
import { markFirstResponse } from "./first-response";
import { reasonsText, scoreLead } from "./score";

export const leadAdminUrl = (leadId: string) => siteUrl(`/admin/leads/${leadId}`);

type LeadContext = Awaited<ReturnType<typeof loadLeadContext>>;

/** The lead, its contact, agent and what this event was about, for messages. */
async function loadLeadContext(db: DbOrTx, leadId: string, eventId: string | null) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, lead.contactId));
  if (!contact) return null;
  const [event] = eventId
    ? await db
        .select({ body: leadEvents.body, meta: leadEvents.meta })
        .from(leadEvents)
        .where(eq(leadEvents.id, eventId))
    : [];
  const [agent] = lead.agentId
    ? await db
        .select({
          name: agents.name,
          email: agents.email,
          whatsapp: agents.whatsapp,
          isActive: agents.isActive,
        })
        .from(agents)
        .where(eq(agents.id, lead.agentId))
    : [];
  const propertyId = (event?.meta.propertyId as string | null) ?? lead.propertyIds[0] ?? null;
  const [listing] = propertyId
    ? await db
        .select({
          reference: properties.reference,
          title: properties.title,
          slug: properties.slug,
        })
        .from(properties)
        .where(eq(properties.id, propertyId))
    : [];
  const projectId = (event?.meta.projectId as string | null) ?? lead.projectIds[0] ?? null;
  const [project] =
    !listing && projectId
      ? await db
          .select({ name: projects.name, slug: projects.slug })
          .from(projects)
          .where(eq(projects.id, projectId))
      : [];
  return { lead, contact, event: event ?? null, agent: agent ?? null, listing, project };
}

/** Form details worth a line in the email ("Preferred time: Saturday 10am"). */
function detailsText(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const labels = t.details as Record<string, string>;
  return Object.entries(details as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false)
    .map(([k, v]) => (v === true ? (labels[k] ?? k) : `${labels[k] ?? k}: ${String(v)}`))
    .join("\n");
}

function interestOf(ctx: NonNullable<LeadContext>): string {
  if (ctx.listing) return `${ctx.listing.reference} · ${ctx.listing.title}`;
  if (ctx.project) return ctx.project.name;
  return t.noInterest;
}

const listingUrl = (ctx: NonNullable<LeadContext>) =>
  ctx.listing
    ? siteUrl(`/property/${ctx.listing.slug}`)
    : ctx.project
      ? siteUrl(`/projects/${ctx.project.slug}`)
      : siteUrl("/");

/** Was this email already queued (a retried job must not send twice)? */
async function alreadyQueued(
  db: DbOrTx,
  template: string,
  related: { type: string; id: string },
  to: string,
) {
  const [row] = await db
    .select({ id: emailLog.id })
    .from(emailLog)
    .where(
      and(
        eq(emailLog.template, template),
        eq(emailLog.relatedType, related.type),
        eq(emailLog.relatedId, related.id),
        eq(emailLog.to, to.toLowerCase()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function sendTemplate(
  db: DbOrTx,
  key: TemplateKey,
  to: string[],
  vars: Record<string, string | number | null>,
  link: string,
  related: { type: string; id: string },
  replyTo?: string | null,
): Promise<string[]> {
  const unique = [...new Set(to.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (unique.length === 0) return [];
  const email = await renderTemplateEmail(db, key, vars, link);
  if (!email) return [];
  const ids: string[] = [];
  for (const address of unique) {
    if (await alreadyQueued(db, key, related, address)) continue;
    ids.push(
      await queueEmail(
        {
          to: address,
          subject: email.subject,
          template: key,
          html: email.html,
          text: email.text,
          replyTo: replyTo ?? undefined,
          related,
        },
        db,
      ),
    );
  }
  return ids;
}

/** Where the agency's own lead emails go (Settings -> Contact), for the "admins" column (13 §3). */
export async function agencyInbox(db: DbOrTx): Promise<string[]> {
  const contact = await loadSettings("contact", db);
  return contact.leadNotifyEmails.length
    ? contact.leadNotifyEmails
    : contact.email
      ? [contact.email]
      : [];
}

/** New lead / new message: the agent and the agency's lead inbox, as Settings -> Notifications says. */
async function notifyTeam(
  db: DbOrTx,
  ctx: NonNullable<LeadContext>,
  eventId: string,
  isNew: boolean,
) {
  const notifications = await loadSettings("notifications", db);
  const to: string[] = [];
  if (notifications.admins.newLead.email) to.push(...(await agencyInbox(db)));
  if (notifications.agents.newLead.email && ctx.agent?.isActive && ctx.agent.email)
    to.push(ctx.agent.email);
  const source = t.sources[ctx.lead.source];
  const key = isNew ? "lead.new" : "lead.new_message";
  const vars = {
    name: ctx.contact.name,
    phone: ctx.contact.phone,
    email: ctx.contact.email,
    source: ctx.lead.sourceDetail ? `${source}, ${ctx.lead.sourceDetail}` : source,
    reference: ctx.listing?.reference ?? ctx.project?.name ?? null,
    interest: interestOf(ctx),
    details: detailsText(ctx.event?.meta.details),
    message: ctx.event?.body ?? null,
    agent: ctx.agent?.name ?? t.unassigned,
    url: leadAdminUrl(ctx.lead.id),
  };
  // WhatsApp notices (13 §3): the agent and, if set, the agency's lead number.
  const numbers: string[] = [];
  if (notifications.admins.newLead.whatsapp) numbers.push(...(await agencyWhatsapp(db)));
  if (notifications.agents.newLead.whatsapp && ctx.agent?.isActive && ctx.agent.whatsapp)
    numbers.push(ctx.agent.whatsapp);
  await whatsappNotices(db, key, numbers, vars, `wa:${eventId}`);
  return sendTemplate(
    db,
    key,
    to,
    vars,
    leadAdminUrl(ctx.lead.id),
    { type: "lead_event", id: eventId },
    ctx.contact.email,
  );
}

/** The agency's lead WhatsApp number (Settings -> Contact), for the "admins" column. */
export async function agencyWhatsapp(db: DbOrTx): Promise<string[]> {
  const contact = await loadSettings("contact", db);
  return contact.leadNotifyWhatsapp ? [contact.leadNotifyWhatsapp] : [];
}

/** Team notices on WhatsApp, only when WhatsApp is turned on; once per number and event. */
export async function whatsappNotices(
  db: DbOrTx,
  key: string,
  numbers: string[],
  vars: Record<string, string | number | null>,
  dedupe: string,
) {
  if (numbers.length === 0) return;
  if (!(await loadSettings("integrations", db)).whatsapp.enabled) return;
  for (const to of new Set(numbers.map(waId).filter(Boolean)))
    await queueWhatsappNotice(db, { to, key, vars, dedupeKey: `${dedupe}:${to}` });
}

/**
 * The WhatsApp half of the auto-reply (09 §3.7): free text when they wrote to us on WhatsApp
 * in the last 24 hours, else the approved template mapped to lead.auto_reply; nothing when
 * neither is possible.
 */
async function whatsappAutoReply(
  db: DbOrTx,
  ctx: NonNullable<LeadContext>,
  vars: Record<string, string | null>,
): Promise<boolean> {
  const number = ctx.contact.whatsapp || ctx.contact.phone;
  const { whatsapp } = await loadSettings("integrations", db);
  if (!number || !whatsapp.enabled) return false;
  const now = new Date();
  const conv = await ensureConversation(db, {
    channel: "whatsapp",
    contactId: ctx.contact.id,
    leadId: ctx.lead.id,
    externalId: waId(number),
    now,
  });
  const open = insideWindow(conv.waWindowExpiresAt, now);
  const mapping = whatsapp.templates["lead.auto_reply"];
  if (!open && !mapping?.name) return false;
  // The agency's wording (Settings -> Message templates); turned off, nothing is sent.
  const wording = await loadTemplate(db, "whatsapp", "lead.auto_reply");
  if (!wording?.isActive) return false;
  const text = fillTemplate(wording.body, vars);
  const sent = await sendOutgoing(db, {
    conversationId: conv.id,
    text,
    sender: "system",
    template: open
      ? null
      : {
          key: "lead.auto_reply",
          name: mapping!.name,
          language: mapping!.language || "en",
          parameters: templateParameters(mapping!.variables, vars),
        },
    now,
  });
  await db.insert(leadEvents).values({
    leadId: ctx.lead.id,
    type: "whatsapp_out",
    body: text,
    meta: { template: "lead.auto_reply", auto: true, messageId: sent.messageId },
    actorType: "system",
    createdAt: now,
  });
  return true;
}

/**
 * Sources where the visitor did not just write to us: no automatic reply. An ROI report or a
 * brochure request already gets its own email (the report, the brochure link), so no second one.
 */
const noAutoReply = new Set([
  "manual",
  "import",
  "newsletter",
  "signup",
  "saved_search",
  "roi",
  "brochure",
]);

/** 09 §3.7: the instant "thanks, [agent] will reach out" email. */
async function autoReply(db: DbOrTx, ctx: NonNullable<LeadContext>): Promise<boolean> {
  const settings = await loadSettings("leads", db);
  if (!settings.autoReply.enabled || noAutoReply.has(ctx.lead.source)) return false;
  const general = await loadSettings("general", db);
  const firstName = ctx.contact.name.split(/\s+/)[0] ?? ctx.contact.name;
  const vars = {
    name: firstName,
    agent: ctx.agent?.isActive ? ctx.agent.name.split(/\s+/)[0]! : general.agencyName,
    agency: general.agencyName,
    reference: ctx.listing?.reference ?? null,
    url: listingUrl(ctx),
  };
  let replied = false;
  if (ctx.contact.email) {
    const { resend } = await loadSettings("integrations", db);
    const ids = await sendTemplate(
      db,
      "lead.auto_reply",
      [ctx.contact.email],
      vars,
      listingUrl(ctx),
      { type: "lead", id: ctx.lead.id },
      // Their answer comes back into the lead's timeline (13 §1 "Inbound email").
      leadReplyAddress(ctx.lead.id, resend.inboundDomain),
    );
    if (ids.length > 0) {
      replied = true;
      await db.insert(leadEvents).values({
        leadId: ctx.lead.id,
        type: "email_sent",
        body: null,
        meta: { template: "lead.auto_reply", auto: true, emailId: ids[0] },
        actorType: "system",
        createdAt: new Date(),
      });
    }
  }
  if (await whatsappAutoReply(db, ctx, vars)) replied = true;
  // Off by default: a template is not a conversation (09 §3.7).
  if (replied && settings.autoReply.countsAsFirstResponse)
    await markFirstResponse(db, ctx.lead.id, new Date());
  return replied;
}

export const leadProcessJob = defineJob({
  name: "lead.process",
  payload: z.object({ leadId: z.uuid(), eventId: z.uuid(), isNew: z.boolean() }),
  maxAttempts: 5,
  async run({ leadId, eventId, isNew }, { db }) {
    const ctx = await loadLeadContext(db, leadId, eventId);
    if (!ctx) return { skipped: "missing" };
    const notified = await notifyTeam(db, ctx, eventId, isNew);
    const replied = isNew ? await autoReply(db, ctx) : false;
    await enqueue("lead.score", { leadId }, { db, dedupeKey: `lead.score:${leadId}` });
    return { notified: notified.length, replied };
  },
});

/** Scores a lead by the rubric and stores the score with its reasons (10 §2). */
export async function refreshLeadScore(db: DbOrTx, leadId: string, now = new Date()) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) return null;
  const [contact] = await db
    .select({ email: contacts.email, phone: contacts.phone, whatsapp: contacts.whatsapp })
    .from(contacts)
    .where(eq(contacts.id, lead.contactId));
  const prices = lead.propertyIds.length
    ? (
        await db
          .select({ price: properties.price })
          .from(properties)
          .where(inArray(properties.id, lead.propertyIds))
      )
        .map((p) => p.price)
        .filter((p): p is number => p != null)
    : [];
  const [signals] = (
    await db.execute<{ messages: number; mortgage: number; viewings: number }>(sql`
      select
        (select count(*)::int from ${leadEvents} where lead_id = ${leadId} and body is not null and body <> '') as messages,
        (select count(*)::int from ${leadEvents} where lead_id = ${leadId} and (meta->>'source' = 'mortgage' or meta->>'preApproved' = 'true')) as mortgage,
        (select count(*)::int from ${viewings} where lead_id = ${leadId}) as viewings`)
  ).rows;
  const rules = {
    requirements: lead.requirements,
    hasEmail: Boolean(contact?.email),
    hasPhone: Boolean(contact?.phone || contact?.whatsapp),
    askedForViewing: lead.source === "tour" || (signals?.viewings ?? 0) > 0,
    listingPrices: prices,
    preApproved: lead.source === "mortgage" || (signals?.mortgage ?? 0) > 0,
    hasMessage: (signals?.messages ?? 0) > 0,
  };
  // The AI scores with the same rubric when it is on (Settings -> AI "Lead scoring"); the
  // rules are the fallback when it is off, over budget or fails.
  const said = await db
    .select({ body: leadEvents.body })
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.actorType, "customer")))
    .orderBy(sql`${leadEvents.createdAt} desc`)
    .limit(20);
  const { score, reasons } = await scoreLeadWithAi(
    {
      rules,
      facts: {
        type: lead.type,
        source: lead.source,
        requirements: lead.requirements,
        listingPrices: prices,
      },
      messages: said
        .map((m) => m.body)
        .filter((b): b is string => Boolean(b))
        .reverse(),
    },
    { db, now },
  ).catch(() => scoreLead(rules));
  await db
    .update(leads)
    .set({ aiScore: score, aiScoreReason: reasonsText(reasons), aiScoredAt: now })
    .where(and(eq(leads.id, leadId), isNull(leads.mergedIntoId)));
  return { score, reasons };
}

export const leadScoreJob = defineJob({
  name: "lead.score",
  payload: z.object({ leadId: z.uuid() }),
  maxAttempts: 3,
  async run({ leadId }, { db }) {
    const result = await refreshLeadScore(db, leadId);
    return result ? { score: result.score } : { skipped: "missing" };
  },
});

/**
 * Every minute (13 §2): open leads nobody has answered within Settings -> Leads
 * "responseAlertMinutes" alert the team once; the list shows them red until answered.
 */
export async function alertUnansweredLeads(db: DbOrTx, now = new Date()): Promise<number> {
  const due = (
    await db.execute<{ id: string }>(sql`
      select id from ${leads}
      where agency_id = ${currentAgencyId()} and status = 'open' and merged_into_id is null
        and first_response_at is null
        and response_alert_sent_at is null and response_due_at <= ${now.toISOString()}::timestamptz
      order by response_due_at
      limit 50`)
  ).rows;
  if (due.length === 0) return 0;
  const [settings, notifications] = [
    await loadSettings("leads", db),
    await loadSettings("notifications", db),
  ];
  let sent = 0;
  for (const { id } of due) {
    // Claim it first, so two overlapping runs never alert twice.
    const claimed = await db
      .update(leads)
      .set({ responseAlertSentAt: now })
      .where(and(eq(leads.id, id), isNull(leads.responseAlertSentAt)))
      .returning({ id: leads.id });
    if (claimed.length === 0) continue;
    const ctx = await loadLeadContext(db, id, null);
    if (!ctx) continue;
    const to: string[] = [];
    if (notifications.admins.leadNotAnswered.email)
      to.push(
        ...(settings.responseAlertEmails.length
          ? settings.responseAlertEmails
          : await agencyInbox(db)),
      );
    if (notifications.agents.leadNotAnswered.email && ctx.agent?.isActive && ctx.agent.email)
      to.push(ctx.agent.email);
    const minutes = Math.max(
      1,
      Math.round((now.getTime() - ctx.lead.createdAt.getTime()) / 60_000),
    );
    const vars = {
      name: ctx.contact.name,
      minutes,
      agent: ctx.agent?.name ?? t.unassigned,
      source: t.sources[ctx.lead.source],
      url: leadAdminUrl(id),
    };
    // 13 §3: the agent hears on WhatsApp; the agency's lead number too if set.
    const numbers: string[] = [];
    if (notifications.admins.leadNotAnswered.whatsapp) numbers.push(...(await agencyWhatsapp(db)));
    if (notifications.agents.leadNotAnswered.whatsapp && ctx.agent?.isActive && ctx.agent.whatsapp)
      numbers.push(ctx.agent.whatsapp);
    await whatsappNotices(db, "lead.not_answered", numbers, vars, `wa-late:${id}`);
    const ids = await sendTemplate(db, "lead.not_answered", to, vars, leadAdminUrl(id), {
      type: "lead",
      id,
    });
    sent += ids.length;
  }
  return sent;
}
