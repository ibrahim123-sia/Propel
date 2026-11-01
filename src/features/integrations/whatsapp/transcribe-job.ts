import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { conversations, messages } from "@/db/schema/crm";
import { queueCustomerReply } from "@/features/ai/assistant/customer";
import { checkAiAvailable } from "@/features/ai/limits";
import { transcribeAudio } from "@/features/ai/transcribe";
import { defineJob } from "@/jobs/types";
import { whatsappClient } from "./client";

/**
 * A voice note in a conversation the assistant handles (10 §2): download it from WhatsApp,
 * write it down, keep the words on the message ("[voice note] …", the inbox shows them) and
 * let the assistant answer. When it cannot be done (AI off or over budget, no transcription
 * provider, the audio unclear or gone) the conversation goes to the team, as before.
 */
export const WHATSAPP_TRANSCRIBE_JOB = "whatsapp.transcribe";
export const VOICE_NOTE_PREFIX = "[voice note]";

export async function transcribeVoiceNote(db: Db, messageId: string, now: Date = new Date()) {
  const [m] = await db
    .select({
      id: messages.id,
      body: messages.body,
      attachments: messages.attachments,
      conversationId: messages.conversationId,
      status: conversations.status,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.id, messageId), eq(messages.agencyId, currentAgencyId())));
  if (!m) return { skipped: "missing" };
  const toTeam = async (reason: string) => {
    await db
      .update(conversations)
      .set({ status: "needs_human" })
      .where(and(eq(conversations.id, m.conversationId), eq(conversations.status, "ai")));
    return { handedOver: reason };
  };
  if (m.status !== "ai") return { skipped: "the team has the conversation" };
  const mediaId = m.attachments
    .map((a) => a.url ?? "")
    .find((u) => u.startsWith("whatsapp-media:"))
    ?.slice("whatsapp-media:".length);
  if (!mediaId) return toTeam("no media");
  if (!(await checkAiAvailable("whatsapp", { db, now })).ok) return toTeam("ai unavailable");
  const client = await whatsappClient(db);
  const audio = client?.downloadMedia ? await client.downloadMedia(mediaId) : null;
  if (!audio) return toTeam("audio gone");
  const transcript = await transcribeAudio(db, audio, { now });
  if (!transcript) return toTeam("not transcribed");
  await db
    .update(messages)
    .set({ body: `${VOICE_NOTE_PREFIX} ${transcript.text}`.slice(0, 4000) })
    .where(eq(messages.id, m.id));
  await queueCustomerReply(db, { conversationId: m.conversationId, messageId: m.id });
  return { transcribed: transcript.text.length, model: transcript.model };
}

export const whatsappTranscribeJob = defineJob({
  name: WHATSAPP_TRANSCRIBE_JOB,
  payload: z.object({ messageId: z.uuid() }).strict(),
  maxAttempts: 3,
  run: ({ messageId }, { db }) => transcribeVoiceNote(db, messageId),
});
