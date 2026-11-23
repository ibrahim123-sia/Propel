"use server";

import { getDb, type Db } from "@/db/client";
import { queueCustomerReply } from "@/features/ai/assistant/customer";
import { handOver } from "@/features/ai/assistant/handover";
import { checkAiAvailable, checkAiRate } from "@/features/ai/limits";
import { currentVisitorKey } from "@/features/attribution/current";
import { addIncoming, ensureConversation } from "@/features/inbox/store";
import { captureLead } from "@/features/leads/capture";
import { loadSettings } from "@/features/settings/queries";
import { errorsByPath, toActionError, type ActionResult } from "@/lib/actions";
import { hit, rateLimitRules } from "@/lib/rate-limit";
import { currentRequestMeta } from "@/lib/request";
import { ai as aiText } from "@/lib/i18n/dictionaries/ai";
import { format } from "@/lib/i18n";
import { sendOutgoing } from "@/features/inbox/store";
import { eq } from "drizzle-orm";
import { conversations } from "@/db/schema/crm";
import { chat as chatText } from "@/lib/i18n/dictionaries/chat";
import {
  chatContactSchema,
  chatMessageSchema,
  chatStartSchema,
  type ChatContactInput,
  type ChatStartInput,
} from "./schema";
import {
  CHAT_CONTACT_REQUIRED_AFTER,
  chatContactState,
  chatVisitor,
  lastVisitorMessage,
  visitorChat,
} from "./store";

type Fail = Extract<ActionResult<never>, { ok: false }>;
const off: Fail = { ok: false, error: "Chat is not available right now.", code: "OFF" };
const noVisitor: Fail = {
  ok: false,
  error: "Please reload the page and try again.",
  code: "NO_VISITOR",
};

async function limited(visitorKey: string): Promise<Fail | null> {
  const db = await getDb();
  const ip = (await currentRequestMeta()).ip ?? "unknown";
  const minute = await hit(`chat:${ip}`, rateLimitRules.chatMinute, db);
  const day = await hit(`chat-day:${visitorKey}`, rateLimitRules.chatDay, db);
  return minute.allowed && day.allowed
    ? null
    : {
        ok: false,
        error: "Too many messages in a short time. Please wait a minute.",
        code: "RATE_LIMITED",
      };
}

/** The assistant's per-visitor and per-IP limits (10 §2 Safety), on top of the chat's own. */
async function aiLimited(db: Db, visitorId: string): Promise<Fail | null> {
  const ip = (await currentRequestMeta()).ip ?? null;
  const rate = await checkAiRate({ visitorId, ip }, { db });
  return rate.allowed ? null : { ok: false, error: rate.message, code: "RATE_LIMITED" };
}

/**
 * Starts the website chat (09 §1 #3): with name and email or phone it becomes (or joins) a
 * lead with source chat. When the assistant is on (Settings -> AI) it answers (status "ai");
 * otherwise, or when it cannot, the conversation waits in the inbox for a person. Bots that
 * fill the honeypot get a success answer and nothing happens.
 */
export async function startChat(
  input: ChatStartInput,
): Promise<ActionResult<{ conversationId: string }>> {
  try {
    const parsed = chatStartSchema.safeParse(input);
    if (!parsed.success) {
      const { fieldErrors, formErrors } = errorsByPath(parsed.error);
      return {
        ok: false,
        error: formErrors[0] ?? "Please check the highlighted fields.",
        code: "VALIDATION",
        fieldErrors,
      };
    }
    const data = parsed.data;
    if (data.website) return { ok: true, data: { conversationId: "" } };
    const db = await getDb();
    const { webChat } = await loadSettings("ai", db);
    if (!webChat.enabled) return off;
    const key = await currentVisitorKey();
    if (!key) return noVisitor;
    const blocked = await limited(key);
    if (blocked) return blocked;
    const hasContact = Boolean(data.email || data.phone);
    if (webChat.askContactFirst && (data.name.length < 2 || !hasContact))
      return {
        ok: false,
        error: "Please check the highlighted fields.",
        code: "VALIDATION",
        fieldErrors: {
          ...(data.name.length < 2 ? { name: ["Enter your name"] } : {}),
          ...(!hasContact
            ? { email: ["Enter an email address or a phone number so we can reply"] }
            : {}),
        },
      };

    const visitorId = await chatVisitor(db, key);
    const assistant = (await checkAiAvailable("customer_chat", { db })).ok;
    if (assistant) {
      const blockedAi = await aiLimited(db, visitorId);
      if (blockedAi) return blockedAi;
    }
    const now = new Date();
    const lead = hasContact
      ? await captureLead(db, {
          source: "chat",
          contact: {
            name: data.name || data.email || data.phone,
            email: data.email || null,
            phone: data.phone || null,
          },
          message: data.message,
          visitorKey: key,
          eventType: "chat",
          now,
        })
      : null;
    const conv = await ensureConversation(db, {
      channel: "web_chat",
      contactId: lead?.contactId ?? null,
      leadId: lead?.leadId ?? null,
      visitorId,
      externalId: visitorId,
      status: assistant ? "ai" : "needs_human",
      now,
    });
    const messageId = await addIncoming(db, {
      conversationId: conv.id,
      body: data.message,
      at: now,
      leadEvent: !lead,
    });
    if (conv.status === "ai")
      await queueCustomerReply(db, {
        conversationId: conv.id,
        messageId,
        page: { path: data.page },
      });
    return { ok: true, data: { conversationId: conv.id } };
  } catch (err) {
    return toActionError(err);
  }
}

/** A further message in the visitor's open chat. */
export async function sendChatMessage(input: {
  text: string;
  website?: string;
  page?: string;
}): Promise<ActionResult<{ ok: true }>> {
  try {
    const parsed = chatMessageSchema.safeParse(input);
    if (!parsed.success) {
      const { fieldErrors, formErrors } = errorsByPath(parsed.error);
      return {
        ok: false,
        error: formErrors[0] ?? "Please check your message.",
        code: "VALIDATION",
        fieldErrors,
      };
    }
    if (parsed.data.website) return { ok: true, data: { ok: true } };
    const db = await getDb();
    if (!(await loadSettings("ai", db)).webChat.enabled) return off;
    const key = await currentVisitorKey();
    if (!key) return noVisitor;
    const blocked = await limited(key);
    if (blocked) return blocked;
    const visitorId = await chatVisitor(db, key);
    const conv = await visitorChat(db, visitorId);
    if (!conv)
      return { ok: false, error: "This chat has ended. Start a new one.", code: "NO_CHAT" };
    if (conv.status === "ai") {
      const blockedAi = await aiLimited(db, visitorId);
      if (blockedAi) return blockedAi;
    }
    const messageId = await addIncoming(db, {
      conversationId: conv.id,
      body: parsed.data.text,
      at: new Date(),
    });
    if (conv.status !== "ai") return { ok: true, data: { ok: true } };
    // From the 15th message without details the assistant waits for them (the team still
    // sees every message in the inbox).
    const state = await chatContactState(db, conv);
    if (!state.hasContact && state.visitorMessages >= CHAT_CONTACT_REQUIRED_AFTER) {
      await sendOutgoing(db, {
        conversationId: conv.id,
        text: chatText.contactRequired,
        sender: "system",
        now: new Date(),
      });
      return { ok: true, data: { ok: true } };
    }
    await queueCustomerReply(db, {
      conversationId: conv.id,
      messageId,
      page: { path: parsed.data.page },
    });
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * The visitor's details from the small form in the chat: they become (or join) a lead with
 * source chat, linked to this conversation. When the assistant was waiting for them (15th
 * message), it answers the visitor's last message now.
 */
export async function saveChatContact(
  input: ChatContactInput,
): Promise<ActionResult<{ ok: true }>> {
  try {
    const parsed = chatContactSchema.safeParse(input);
    if (!parsed.success) {
      const { fieldErrors, formErrors } = errorsByPath(parsed.error);
      return {
        ok: false,
        error: formErrors[0] ?? "Please check the highlighted fields.",
        code: "VALIDATION",
        fieldErrors,
      };
    }
    const data = parsed.data;
    if (data.website) return { ok: true, data: { ok: true } };
    if (!data.email && !data.phone)
      return {
        ok: false,
        error: chatText.contactNeedOne,
        code: "VALIDATION",
        fieldErrors: { phone: [chatText.contactNeedOne] },
      };
    const db = await getDb();
    if (!(await loadSettings("ai", db)).webChat.enabled) return off;
    const key = await currentVisitorKey();
    if (!key) return noVisitor;
    const blocked = await limited(key);
    if (blocked) return blocked;
    const conv = await visitorChat(db, await chatVisitor(db, key));
    if (!conv)
      return { ok: false, error: "This chat has ended. Start a new one.", code: "NO_CHAT" };
    const before = await chatContactState(db, conv);
    const now = new Date();
    const lead = await captureLead(db, {
      source: "chat",
      contact: { name: data.name, email: data.email || null, phone: data.phone || null },
      message: null,
      visitorKey: key,
      eventType: "chat",
      now,
    });
    await db
      .update(conversations)
      .set({ contactId: lead.contactId, leadId: conv.leadId ?? lead.leadId })
      .where(eq(conversations.id, conv.id));
    await sendOutgoing(db, {
      conversationId: conv.id,
      text: format(chatText.contactThanks, { name: data.name.split(" ")[0]! }),
      sender: "system",
      now,
    });
    const waiting =
      conv.status === "ai" &&
      !before.hasContact &&
      before.visitorMessages >= CHAT_CONTACT_REQUIRED_AFTER;
    if (waiting) {
      const lastIn = await lastVisitorMessage(db, conv.id);
      if (lastIn)
        await queueCustomerReply(db, {
          conversationId: conv.id,
          messageId: lastIn,
          page: { path: data.page },
        });
    }
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toActionError(err);
  }
}

/**
 * "Talk to a person" (10 §2: the visitor can always hand over): the assistant stops, the team
 * is told, and the chat says who will reply.
 */
export async function askForPerson(): Promise<ActionResult<{ ok: true }>> {
  try {
    const db = await getDb();
    if (!(await loadSettings("ai", db)).webChat.enabled) return off;
    const key = await currentVisitorKey();
    if (!key) return noVisitor;
    const blocked = await limited(key);
    if (blocked) return blocked;
    const conv = await visitorChat(db, await chatVisitor(db, key));
    if (!conv)
      return { ok: false, error: "This chat has ended. Start a new one.", code: "NO_CHAT" };
    if (conv.status !== "ai") return { ok: true, data: { ok: true } };
    const result = await handOver(db, {
      conversationId: conv.id,
      reason: 'The visitor pressed "Talk to a person".',
    });
    await sendOutgoing(db, {
      conversationId: conv.id,
      text: format(aiText.personAsked, { agent: result.agentName ?? "our team" }),
      sender: "system",
      now: new Date(),
    });
    return { ok: true, data: { ok: true } };
  } catch (err) {
    return toActionError(err);
  }
}
