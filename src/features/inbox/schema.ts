import { z } from "zod";

/** Inbox action inputs (09 §6). Client-safe. */
export const replySchema = z.object({
  conversationId: z.uuid(),
  text: z.string().trim().min(1, "Write a message first").max(4000, "Use at most 4,000 characters"),
});

export const templateReplySchema = z.object({
  conversationId: z.uuid(),
  key: z.string().min(1).max(100),
  variables: z.record(z.string().max(40), z.string().max(500)),
});

export const listingMessageSchema = z.object({
  conversationId: z.uuid(),
  propertyId: z.uuid(),
  kind: z.enum(["card", "brochure"]),
});

export const conversationIdSchema = z.object({ id: z.uuid() });

export const conversationStatusSchema = z.object({
  id: z.uuid(),
  action: z.enum(["take_over", "hand_back", "close", "reopen", "mark_read"]),
});

/** 10 §2: flag an assistant answer as bad (with what was wrong), or take the flag back. */
export const answerFlagSchema = z
  .object({
    messageId: z.uuid(),
    flagged: z.boolean(),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

export const approvalDecisionSchema = z
  .object({
    id: z.uuid(),
    decision: z.enum(["approve", "edit", "reject"]),
    text: z.string().trim().max(4000).optional(),
  })
  .refine((v) => v.decision !== "edit" || Boolean(v.text), {
    path: ["text"],
    message: "Write the reply to send",
  });

export const quickReplySchema = z.object({
  id: z.uuid().nullable(),
  title: z.string().trim().min(1, "Give it a short name").max(80),
  body: z.string().trim().min(1, "Write the reply").max(2000),
});

export const reorderSchema = z.object({ ids: z.array(z.uuid()).max(200) });

export const listingSearchSchema = z.object({ q: z.string().max(100) });
