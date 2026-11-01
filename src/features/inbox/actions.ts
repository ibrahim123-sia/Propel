"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { approvalQueue, conversations, messages, quickReplies } from "@/db/schema/crm";
import { signedBrochurePath } from "@/features/brochure/links";
import {
  fillTemplate,
  isTemplateKey,
  templateDefaults,
  type TemplateDefault,
} from "@/features/messages/defaults";
import { loadTemplate } from "@/features/messages/render";
import { currencyFormats, priceLabel } from "@/features/properties/format";
import { loadSettings } from "@/features/settings/queries";
import { siteUrl } from "@/features/site/url";
import { ActionError, adminAction } from "@/lib/actions";
import { writeAudit } from "@/lib/audit";
import { findListingsForCards, listingFiles } from "./queries";
import { templateParameters } from "./rules";
import {
  answerFlagSchema,
  approvalDecisionSchema,
  conversationStatusSchema,
  listingMessageSchema,
  listingSearchSchema,
  quickReplySchema,
  reorderSchema,
  replySchema,
  templateReplySchema,
} from "./schema";
import { sendOutgoing } from "./store";

/** A typed reply on the conversation's channel (09 §6). */
export const replyToConversation = adminAction(replySchema, { write: true }, async (input, ctx) => {
  const db = await getDb();
  const res = await db.transaction(async (tx) => {
    const sent = await sendOutgoing(tx, {
      conversationId: input.conversationId,
      text: input.text,
      sender: "admin",
      adminId: ctx.user.id,
      now: new Date(),
    });
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "conversation.reply",
      entityType: "conversation",
      entityId: input.conversationId,
      after: { messageId: sent.messageId },
    });
    return sent;
  });
  return res;
});

/** Outside the 24-hour window: an approved template with its variables (13 §1). */
export const sendTemplateReply = adminAction(
  templateReplySchema,
  { write: true },
  async (input, ctx) => {
    const db = await getDb();
    const { whatsapp } = await loadSettings("integrations", db);
    const mapping = whatsapp.templates[input.key];
    if (!mapping?.name)
      throw new ActionError(
        "This template is not linked to an approved WhatsApp template yet (Settings -> Integrations).",
        "VALIDATION",
      );
    const parameters = templateParameters(mapping.variables, input.variables);
    // The agency's wording when it has one (Settings -> Message templates).
    const wording = isTemplateKey(input.key) ? await loadTemplate(db, "whatsapp", input.key) : null;
    const builtIn = (templateDefaults as Record<string, TemplateDefault>)[input.key]?.whatsapp;
    const body = wording?.body ?? builtIn?.body;
    const preview = body
      ? fillTemplate(body, input.variables)
      : `${mapping.name}: ${parameters.join(" · ")}`;
    return db.transaction(async (tx) => {
      const sent = await sendOutgoing(tx, {
        conversationId: input.conversationId,
        text: preview,
        sender: "admin",
        adminId: ctx.user.id,
        template: {
          key: input.key,
          name: mapping.name,
          language: mapping.language || "en",
          parameters,
        },
        now: new Date(),
      });
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "conversation.template",
        entityType: "conversation",
        entityId: input.conversationId,
        after: { messageId: sent.messageId, template: input.key },
      });
      return sent;
    });
  },
);

/** Live listings for the "listing card" picker. */
export const searchListingsForCards = adminAction(listingSearchSchema, {}, async ({ q }) => {
  const db = await getDb();
  const market = await loadSettings("market", db);
  const formats = currencyFormats(market);
  const rows = await findListingsForCards(db, q);
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    price: priceLabel(r, formats),
  }));
});

/** A listing card (photo, title, price, link) or its brochure link, on any channel (09 §6). */
export const sendListingMessage = adminAction(
  listingMessageSchema,
  { write: true },
  async (input, ctx) => {
    const db = await getDb();
    const [listing] = await findListingsForCards(db, "", input.propertyId);
    if (!listing) throw new ActionError("This listing is no longer live.", "NOT_FOUND");
    const formats = currencyFormats(await loadSettings("market", db));
    const files = await listingFiles(db, listing.id);
    const url = siteUrl(`/property/${listing.slug}`);
    let text: string;
    let image: { link: string; caption: string } | null = null;
    if (input.kind === "brochure") {
      // The uploaded PDF or the generated one (11 §4), through a link that passes the email gate.
      const link = siteUrl(await signedBrochurePath("property", listing.id));
      text = `Brochure for ${listing.reference}, ${listing.title}: ${link}`;
    } else {
      text = `${listing.title}\n${priceLabel(listing, formats)}\n${url}`;
      const [conv] = await db
        .select({ channel: conversations.channel })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId));
      if (conv?.channel === "whatsapp" && files.photoUrl)
        image = { link: siteUrl(files.photoUrl), caption: text };
    }
    return db.transaction(async (tx) => {
      const sent = await sendOutgoing(tx, {
        conversationId: input.conversationId,
        text,
        image,
        sender: "admin",
        adminId: ctx.user.id,
        now: new Date(),
      });
      await writeAudit(tx, {
        actor: ctx.actor,
        action: input.kind === "brochure" ? "conversation.brochure" : "conversation.listing_card",
        entityType: "conversation",
        entityId: input.conversationId,
        after: { messageId: sent.messageId, propertyId: listing.id },
      });
      return sent;
    });
  },
);

/** Take over (the assistant stops), hand back, close, reopen, mark read (09 §6). */
export const updateConversation = adminAction(
  conversationStatusSchema,
  { write: true },
  async ({ id, action }, ctx) => {
    const db = await getDb();
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.agencyId, currentAgencyId())));
    if (!conv) throw new ActionError("This conversation no longer exists.", "NOT_FOUND");
    const set =
      action === "take_over"
        ? { status: "human" as const, assignedAdminId: ctx.user.id }
        : action === "hand_back"
          ? { status: "ai" as const, assignedAdminId: null }
          : action === "close"
            ? { status: "closed" as const, unreadCount: 0 }
            : action === "reopen"
              ? { status: "human" as const, assignedAdminId: ctx.user.id }
              : { unreadCount: 0 };
    await db.transaction(async (tx) => {
      await tx.update(conversations).set(set).where(eq(conversations.id, id));
      if (action !== "mark_read")
        await writeAudit(tx, {
          actor: ctx.actor,
          action: `conversation.${action}`,
          entityType: "conversation",
          entityId: id,
          before: { status: conv.status, assignedAdminId: conv.assignedAdminId },
          after: set,
        });
    });
    return { id };
  },
);

/**
 * 10 §2 "admins can review and flag bad answers (used to improve prompts)": only assistant
 * messages can be flagged; the AI report counts them. Audited.
 */
export const flagAssistantAnswer = adminAction(
  answerFlagSchema,
  { write: true },
  async ({ messageId, flagged, note }, ctx) => {
    const db = await getDb();
    const [m] = await db
      .select({ id: messages.id, sender: messages.sender, flaggedAt: messages.flaggedAt })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.agencyId, currentAgencyId())));
    if (!m || m.sender !== "ai")
      throw new ActionError("Only the assistant's answers can be flagged.", "NOT_FOUND");
    const set = flagged
      ? { flaggedAt: m.flaggedAt ?? new Date(), flaggedBy: ctx.user.id, flagNote: note || null }
      : { flaggedAt: null, flaggedBy: null, flagNote: null };
    await db.transaction(async (tx) => {
      await tx.update(messages).set(set).where(eq(messages.id, messageId));
      await writeAudit(tx, {
        actor: ctx.actor,
        action: flagged ? "ai.answer_flag" : "ai.answer_unflag",
        entityType: "message",
        entityId: messageId,
        after: flagged ? { note: note || null } : null,
      });
    });
    return { id: messageId, flagged };
  },
);

/** Approve, edit or reject a draft the assistant was not allowed to send (09 §6). */
export const decideApproval = adminAction(
  approvalDecisionSchema,
  { write: true },
  async (input, ctx) => {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(approvalQueue)
        .where(
          and(
            eq(approvalQueue.id, input.id),
            eq(approvalQueue.agencyId, currentAgencyId()),
            eq(approvalQueue.status, "pending"),
          ),
        );
      if (!item) throw new ActionError("This draft was already decided.", "NOT_FOUND");
      const now = new Date();
      let messageId: string | null = null;
      if (input.decision !== "reject") {
        const sent = await sendOutgoing(tx, {
          conversationId: item.conversationId,
          text: input.decision === "edit" ? input.text! : item.draftReply,
          // An edited reply is the admin's words; an approved one stays the assistant's.
          sender: input.decision === "edit" ? "admin" : "ai",
          adminId: ctx.user.id,
          now,
        });
        messageId = sent.messageId;
      }
      const status =
        input.decision === "approve"
          ? "approved"
          : input.decision === "edit"
            ? "edited"
            : "rejected";
      await tx
        .update(approvalQueue)
        .set({ status, decidedBy: ctx.user.id, decidedAt: now })
        .where(eq(approvalQueue.id, item.id));
      await writeAudit(tx, {
        actor: ctx.actor,
        action: `approval.${status}`,
        entityType: "approval",
        entityId: item.id,
        before: { draftReply: item.draftReply },
        after: { status, text: input.decision === "edit" ? input.text : undefined, messageId },
      });
      return { status, messageId };
    });
  },
);

export const saveQuickReply = adminAction(quickReplySchema, { write: true }, async (input, ctx) => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    if (input.id) {
      const [before] = await tx
        .select()
        .from(quickReplies)
        .where(and(eq(quickReplies.id, input.id), eq(quickReplies.agencyId, currentAgencyId())));
      if (!before) throw new ActionError("This quick reply no longer exists.", "NOT_FOUND");
      await tx
        .update(quickReplies)
        .set({ title: input.title, body: input.body, updatedBy: ctx.user.id })
        .where(eq(quickReplies.id, input.id));
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "quick_reply.update",
        entityType: "quick_reply",
        entityId: input.id,
        before: { title: before.title, body: before.body },
        after: { title: input.title, body: input.body },
      });
      return { id: input.id };
    }
    const [{ next }] = (
      await tx.execute<{ next: number }>(
        sql`select coalesce(max(sort_order), -1)::int + 1 as next from quick_replies where agency_id = ${currentAgencyId()}`,
      )
    ).rows as [{ next: number }];
    const [created] = await tx
      .insert(quickReplies)
      .values({ title: input.title, body: input.body, sortOrder: next, createdBy: ctx.user.id })
      .returning({ id: quickReplies.id });
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "quick_reply.create",
      entityType: "quick_reply",
      entityId: created!.id,
      after: { title: input.title, body: input.body },
    });
    return { id: created!.id };
  });
});

export const deleteQuickReply = adminAction(
  conversationStatusSchema.pick({ id: true }),
  { write: true },
  async ({ id }, ctx) => {
    const db = await getDb();
    await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(quickReplies)
        .where(and(eq(quickReplies.id, id), eq(quickReplies.agencyId, currentAgencyId())))
        .returning();
      if (!gone) throw new ActionError("This quick reply no longer exists.", "NOT_FOUND");
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "quick_reply.delete",
        entityType: "quick_reply",
        entityId: id,
        before: { title: gone.title, body: gone.body },
      });
    });
    return { id };
  },
);

export const reorderQuickReplies = adminAction(
  reorderSchema,
  { write: true },
  async ({ ids }, ctx) => {
    const db = await getDb();
    await db.transaction(async (tx) => {
      const found = await tx
        .select({ id: quickReplies.id })
        .from(quickReplies)
        .where(and(eq(quickReplies.agencyId, currentAgencyId()), inArray(quickReplies.id, ids)));
      if (found.length !== ids.length)
        throw new ActionError("Some quick replies changed. Reload and try again.", "CONFLICT");
      for (const [i, id] of ids.entries())
        await tx.update(quickReplies).set({ sortOrder: i }).where(eq(quickReplies.id, id));
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "quick_reply.reorder",
        entityType: "quick_reply",
        after: { ids },
      });
    });
    return { ids };
  },
);
