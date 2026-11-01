import "server-only";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { conversations, messages, visitorEvents, visitors } from "@/db/schema/crm";
import { queueCustomerReply } from "@/features/ai/assistant/customer";
import { checkAiAvailable } from "@/features/ai/limits";
import { enqueue } from "@/jobs/enqueue";
import { WHATSAPP_TRANSCRIBE_JOB } from "./transcribe-job";
import { findRefCode } from "@/features/attribution/whatsapp-ref";
import { addIncoming, ensureConversation, findOpenConversation } from "@/features/inbox/store";
import { e164FromWaId, waId } from "@/features/inbox/rules";
import { captureLead } from "@/features/leads/capture";

/** The parts of a Cloud API webhook we use; anything else is ignored (Meta adds fields). */
const mediaSchema = z
  .object({
    id: z.string().optional(),
    mime_type: z.string().optional(),
    caption: z.string().optional(),
  })
  .loose();
const messageSchema = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    video: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    document: mediaSchema.extend({ filename: z.string().optional() }).optional(),
    sticker: mediaSchema.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    button: z.object({ text: z.string() }).optional(),
    interactive: z
      .object({
        button_reply: z.object({ title: z.string() }).optional(),
        list_reply: z.object({ title: z.string() }).optional(),
      })
      .optional(),
  })
  .loose();
const statusSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    errors: z
      .array(
        z
          .object({
            code: z.number().optional(),
            title: z.string().optional(),
            message: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
export const whatsappWebhookSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              contacts: z
                .array(
                  z.object({
                    wa_id: z.string(),
                    profile: z.object({ name: z.string().optional() }).optional(),
                  }),
                )
                .optional(),
              messages: z.array(messageSchema).optional(),
              statuses: z.array(statusSchema).optional(),
              errors: z
                .array(
                  z.object({ code: z.number().optional(), title: z.string().optional() }).loose(),
                )
                .optional(),
            })
            .loose(),
        }),
      ),
    }),
  ),
});
export type WhatsappWebhook = z.infer<typeof whatsappWebhookSchema>;
type WaMessage = z.infer<typeof messageSchema>;

const mediaKinds = {
  image: "photo",
  video: "video",
  audio: "voice note",
  document: "document",
  sticker: "sticker",
} as const;

/** What the inbox shows for a message, and its attachment (WhatsApp keeps the media). */
export function messageText(msg: WaMessage): {
  body: string;
  attachments: Array<{ url: string; name: string; mime: string }>;
} {
  if (msg.text) return { body: msg.text.body, attachments: [] };
  for (const kind of Object.keys(mediaKinds) as Array<keyof typeof mediaKinds>) {
    const media = msg[kind];
    if (media)
      return {
        body: media.caption ?? `[${mediaKinds[kind]}]`,
        attachments: media.id
          ? [
              {
                url: `whatsapp-media:${media.id}`,
                name: (kind === "document" && msg.document?.filename) || mediaKinds[kind],
                mime: media.mime_type ?? "application/octet-stream",
              },
            ]
          : [],
      };
  }
  if (msg.location) {
    const where = [msg.location.name, msg.location.address].filter(Boolean).join(", ");
    return {
      body: `[location] ${where ? `${where} ` : ""}(${msg.location.latitude}, ${msg.location.longitude})`,
      attachments: [],
    };
  }
  const reply =
    msg.button?.text ?? msg.interactive?.button_reply?.title ?? msg.interactive?.list_reply?.title;
  if (reply) return { body: reply, attachments: [] };
  return { body: `[${msg.type} message]`, attachments: [] };
}

/** The site click this chat started from (13 §1 ref codes), within the last 30 days. */
async function clickFor(db: Db, code: string, before: Date) {
  const [click] = await db
    .select({
      visitorKey: visitors.visitorKey,
      visitorId: visitors.id,
      entityType: visitorEvents.entityType,
      entityId: visitorEvents.entityId,
    })
    .from(visitorEvents)
    .innerJoin(visitors, eq(visitors.id, visitorEvents.visitorId))
    .where(
      and(
        eq(visitorEvents.agencyId, currentAgencyId()),
        eq(visitorEvents.type, "whatsapp_click"),
        sql`${visitorEvents.meta}->>'ref' = ${code}`,
        gte(visitorEvents.createdAt, new Date(before.getTime() - 30 * 86_400_000)),
      ),
    )
    .orderBy(desc(visitorEvents.createdAt))
    .limit(1);
  return click ?? null;
}

const statusRank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 } as const;
type MessageStatus = keyof typeof statusRank;

async function applyStatus(db: Db, st: z.infer<typeof statusSchema>) {
  const status = st.status as MessageStatus;
  if (!(status in statusRank) || status === "queued") return;
  const [msg] = await db
    .select({ id: messages.id, status: messages.status })
    .from(messages)
    .where(and(eq(messages.agencyId, currentAgencyId()), eq(messages.externalId, st.id)))
    .limit(1);
  if (!msg) return;
  // Webhooks can arrive out of order: never go back from "read" to "delivered".
  if (status !== "failed" && statusRank[status] <= statusRank[msg.status]) return;
  const error = st.errors?.[0];
  await db
    .update(messages)
    .set({
      status,
      error:
        status === "failed"
          ? [error?.title, error?.message].filter(Boolean).join(": ").slice(0, 500) ||
            "Not delivered"
          : null,
    })
    .where(eq(messages.id, msg.id));
}

async function handleMessage(db: Db, msg: WaMessage, profileName: string | null, now: Date) {
  const [seen] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.agencyId, currentAgencyId()), eq(messages.externalId, msg.id)))
    .limit(1);
  if (seen) return; // Meta retries webhooks: each message once.

  const id = waId(msg.from);
  const phone = e164FromWaId(id);
  const sentAt = Number(msg.timestamp) > 0 ? new Date(Number(msg.timestamp) * 1000) : now;
  const at = sentAt.getTime() > now.getTime() ? now : sentAt;
  const { body, attachments } = messageText(msg);

  let conv = await findOpenConversation(db, { channel: "whatsapp", externalId: id });
  let leadEventWritten = false;
  if (!conv?.leadId) {
    // The first message of a conversation goes through the lead pipeline (09 §1 #5), with the
    // site visit it came from when the message carries a ref code (#4).
    const ref = findRefCode(body);
    const click = ref ? await clickFor(db, ref.code, at) : null;
    const lead = await captureLead(db, {
      source: "whatsapp",
      sourceDetail: click ? "click" : null,
      contact: {
        name: profileName?.trim() || phone,
        phone,
        whatsapp: phone,
        preferredContact: "whatsapp",
      },
      propertyId: click?.entityType === "property" ? click.entityId : null,
      projectId: click?.entityType === "project" ? click.entityId : null,
      message: body,
      visitorKey: click?.visitorKey ?? null,
      eventType: "whatsapp_in",
      lenientPhone: true,
      now: at,
    });
    leadEventWritten = true;
    // A new conversation is the assistant's when it is on for WhatsApp (10 §2), else the team's.
    const assistant = (await checkAiAvailable("whatsapp", { db, now })).ok;
    conv = await ensureConversation(db, {
      channel: "whatsapp",
      contactId: lead.contactId,
      leadId: lead.leadId,
      visitorId: click?.visitorId ?? null,
      externalId: id,
      status: assistant ? "ai" : "needs_human",
      now: at,
    });
    if (conv.leadId !== lead.leadId)
      await db
        .update(conversations)
        .set({ leadId: lead.leadId, contactId: lead.contactId })
        .where(eq(conversations.id, conv.id));
  }
  const messageId = await addIncoming(db, {
    conversationId: conv.id,
    body,
    attachments,
    externalId: msg.id,
    at,
    leadEvent: !leadEventWritten,
  });
  // The assistant answers words. A voice note is written down first (a job, so the webhook
  // stays fast); a photo or file without words ("[photo]") goes to the team.
  if (conv.status === "ai") {
    const words = Boolean(msg.text?.body.trim()) || !/^\[[^\]]+\]$/.test(body.trim());
    if (words) await queueCustomerReply(db, { conversationId: conv.id, messageId });
    else if (msg.audio?.id)
      await enqueue(
        WHATSAPP_TRANSCRIBE_JOB,
        { messageId },
        { db, dedupeKey: `wa-voice:${messageId}` },
      );
    else
      await db
        .update(conversations)
        .set({ status: "needs_human" })
        .where(eq(conversations.id, conv.id));
  }
}

/**
 * One webhook call (13 §1): new messages (contact, conversation, lead), delivery statuses and
 * errors. Errors Meta reports are logged; they never fail the call (Meta would retry it).
 */
export async function handleWhatsappWebhook(
  db: Db,
  payload: WhatsappWebhook,
  now: Date = new Date(),
): Promise<{ messages: number; statuses: number }> {
  let received = 0;
  let statuses = 0;
  for (const entry of payload.entry)
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      for (const error of value.errors ?? [])
        console.error("[whatsapp] webhook error", error.code, error.title);
      const names = new Map(
        (value.contacts ?? []).map((c) => [waId(c.wa_id), c.profile?.name ?? null]),
      );
      for (const msg of value.messages ?? []) {
        await handleMessage(db, msg, names.get(waId(msg.from)) ?? null, now);
        received++;
      }
      for (const st of value.statuses ?? []) {
        await applyStatus(db, st);
        statuses++;
      }
    }
  return { messages: received, statuses };
}
