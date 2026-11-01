import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  approvalQueue,
  contacts,
  conversations,
  leadEvents,
  leads,
  messages,
  quickReplies,
} from "@/db/schema/crm";
import { auditLog, emailLog } from "@/db/schema/system";
import {
  decideApproval,
  deleteQuickReply,
  flagAssistantAnswer,
  reorderQuickReplies,
  replyToConversation,
  saveQuickReply,
  updateConversation,
} from "@/features/inbox/actions";
import { listConversations, loadConversation } from "@/features/inbox/queries";
import { ensureConversation, leadConversation } from "@/features/inbox/store";
import { captureLead } from "@/features/leads/capture";
import { patchSettings } from "@/features/settings/mutations";
import { adminState, testAdmin } from "../helpers/admin-context";
import { ensureTestAdminUser, truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };

async function setup() {
  const db = await getDb();
  await ensureTestAdminUser();
  await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
  const lead = await captureLead(db, {
    source: "chat",
    contact: { name: "Mina Park", email: "mina@example.com" },
    message: "Do you have three beds in the marina?",
  });
  const conv = await ensureConversation(db, {
    channel: "web_chat",
    contactId: lead.contactId,
    leadId: lead.leadId,
    now: new Date(),
  });
  return { db, lead, conv };
}

describe("inbox (09 §6)", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    await truncate(
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "conversations",
      "messages",
      "approval_queue",
      "quick_replies",
      "settings",
      "job_runs",
      "email_log",
      "message_templates",
      "audit_log",
    );
  });

  it("a team reply: shown in the chat, the lead's first response, on its timeline; the admin takes over", async () => {
    const { db, lead, conv } = await setup();
    const res = await replyToConversation({ conversationId: conv.id, text: "Yes, two right now." });
    expect(res).toMatchObject({ ok: true, data: { status: "sent" } });
    const [msg] = await db.select().from(messages);
    expect(msg).toMatchObject({
      direction: "out",
      sender: "admin",
      senderAdminId: testAdmin.id,
      status: "sent",
    });
    const [l] = await db.select().from(leads).where(eq(leads.id, lead.leadId));
    expect(l!.firstResponseAt).not.toBeNull();
    const types = (await db.select({ type: leadEvents.type }).from(leadEvents)).map((e) => e.type);
    expect(types).toContain("chat");
    const [c] = await db.select().from(conversations);
    expect(c).toMatchObject({ status: "human", assignedAdminId: testAdmin.id });
    expect((await replyToConversation({ conversationId: conv.id, text: "  " })).ok).toBe(false);

    const detail = await loadConversation(db, conv.id);
    expect(detail!.messages.map((m) => [m.sender, m.body])).toEqual([
      ["admin", "Yes, two right now."],
    ]);
    expect(detail!.lead).toMatchObject({ id: lead.leadId });
  });

  it("take over, hand back, close and reopen are audited; the list filters by status", async () => {
    const { db, conv } = await setup();
    expect(await updateConversation({ id: conv.id, action: "take_over" })).toMatchObject({
      ok: true,
    });
    expect((await db.select().from(conversations))[0]).toMatchObject({
      status: "human",
      assignedAdminId: testAdmin.id,
    });
    await updateConversation({ id: conv.id, action: "hand_back" });
    expect((await db.select().from(conversations))[0]).toMatchObject({
      status: "ai",
      assignedAdminId: null,
    });
    await updateConversation({ id: conv.id, action: "close" });
    const filter = { status: "open" as const, channel: "all" as const, q: "", unread: false };
    expect(await listConversations(db, filter)).toHaveLength(0);
    expect(await listConversations(db, { ...filter, status: "closed" })).toHaveLength(1);
    await updateConversation({ id: conv.id, action: "reopen" });
    expect(await listConversations(db, { ...filter, q: "mina" })).toHaveLength(1);
    expect(await listConversations(db, { ...filter, q: "nobody" })).toHaveLength(0);
    const actions = (
      await db.select({ action: auditLog.action }).from(auditLog).orderBy(asc(auditLog.createdAt))
    )
      .map((a) => a.action)
      .filter((a) => a.startsWith("conversation."));
    expect(actions).toEqual([
      "conversation.take_over",
      "conversation.hand_back",
      "conversation.close",
      "conversation.reopen",
    ]);

    // The read-only demo viewer can look but not change anything.
    adminState.user = { ...testAdmin, readOnly: true };
    expect(await updateConversation({ id: conv.id, action: "close" })).toMatchObject({
      ok: false,
      code: "READ_ONLY",
    });
  });

  it("approvals: approve sends the draft as the assistant, edit as the team, reject sends nothing", async () => {
    const { db, conv } = await setup();
    const [a, b, c] = await db
      .insert(approvalQueue)
      .values([
        {
          conversationId: conv.id,
          draftReply: "The price can go down to 2.1M.",
          reason: "price negotiation",
        },
        { conversationId: conv.id, draftReply: "Tax is 4%.", reason: "tax advice" },
        { conversationId: conv.id, draftReply: "Sure.", reason: "complaints" },
      ])
      .returning();
    expect(await decideApproval({ id: a!.id, decision: "approve" })).toMatchObject({
      ok: true,
      data: { status: "approved" },
    });
    expect(await decideApproval({ id: b!.id, decision: "edit" })).toMatchObject({
      ok: false,
      code: "VALIDATION",
    });
    expect(
      await decideApproval({
        id: b!.id,
        decision: "edit",
        text: "An adviser will call you about tax.",
      }),
    ).toMatchObject({ ok: true, data: { status: "edited" } });
    expect(await decideApproval({ id: c!.id, decision: "reject" })).toMatchObject({
      ok: true,
      data: { status: "rejected" },
    });
    expect(await decideApproval({ id: c!.id, decision: "approve" })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    const sent = await db
      .select({ sender: messages.sender, body: messages.body })
      .from(messages)
      .orderBy(asc(messages.createdAt));
    expect(sent).toEqual([
      { sender: "ai", body: "The price can go down to 2.1M." },
      { sender: "admin", body: "An adviser will call you about tax." },
    ]);
    const rows = await db.select().from(approvalQueue);
    expect(rows.every((r) => r.decidedBy === testAdmin.id && r.decidedAt)).toBe(true);
  });

  it("flags an assistant answer with a note, shows it in the conversation, and takes it back", async () => {
    const { db, conv } = await setup();
    const [answer, mine] = await db
      .insert(messages)
      .values([
        { conversationId: conv.id, direction: "out", sender: "ai", body: "Prices start at 1M." },
        { conversationId: conv.id, direction: "out", sender: "admin", body: "Hello" },
      ])
      .returning();
    expect(
      await flagAssistantAnswer({ messageId: answer!.id, flagged: true, note: "Made up a price" }),
    ).toMatchObject({ ok: true });
    const view = await loadConversation(db, conv.id);
    expect(view!.messages.find((m) => m.id === answer!.id)!.flag).toMatchObject({
      note: "Made up a price",
    });
    // Only the assistant's answers can be flagged.
    expect(await flagAssistantAnswer({ messageId: mine!.id, flagged: true })).toMatchObject({
      ok: false,
    });
    expect(await flagAssistantAnswer({ messageId: answer!.id, flagged: false })).toMatchObject({
      ok: true,
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, answer!.id));
    expect(row).toMatchObject({ flaggedAt: null, flagNote: null });
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, answer!.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["ai.answer_flag", "ai.answer_unflag"]);
  });

  it("quick replies: add, edit, order and delete", async () => {
    const { db } = await setup();
    const one = await saveQuickReply({
      id: null,
      title: "Viewing times",
      body: "We show homes daily 9 to 6.",
    });
    const two = await saveQuickReply({
      id: null,
      title: "Documents",
      body: "Bring your passport.",
    });
    expect(one.ok && two.ok).toBe(true);
    const ids = (await db.select().from(quickReplies).orderBy(asc(quickReplies.sortOrder))).map(
      (q) => q.title,
    );
    expect(ids).toEqual(["Viewing times", "Documents"]);
    const [first, second] = await db
      .select()
      .from(quickReplies)
      .orderBy(asc(quickReplies.sortOrder));
    await reorderQuickReplies({ ids: [second!.id, first!.id] });
    await saveQuickReply({ id: first!.id, title: "Viewing hours", body: "Daily 9 to 6." });
    expect(
      (await db.select().from(quickReplies).orderBy(asc(quickReplies.sortOrder))).map(
        (q) => q.title,
      ),
    ).toEqual(["Documents", "Viewing hours"]);
    await deleteQuickReply({ id: second!.id });
    expect(await db.select().from(quickReplies)).toHaveLength(1);
    expect(await saveQuickReply({ id: null, title: "", body: "x" })).toMatchObject({
      ok: false,
      fieldErrors: { title: expect.any(Array) },
    });
  });

  it("?lead= opens their email conversation when there is no number; replies come back to lead+<id>", async () => {
    const { db } = await setup();
    await patchSettings(
      db,
      "integrations",
      {
        resend: {
          enabled: false,
          fromAddress: "",
          fromName: "",
          replyTo: "",
          inboundDomain: "in.havendune.example",
        },
      },
      actor,
    );
    const emailLead = await captureLead(db, {
      source: "form",
      contact: { name: "Omar", email: "omar@example.com" },
    });
    const conv = await leadConversation(db, emailLead.leadId, new Date());
    expect(conv).toMatchObject({ channel: "email", leadId: emailLead.leadId, status: "human" });
    expect((await leadConversation(db, emailLead.leadId, new Date()))!.id).toBe(conv!.id);
    await replyToConversation({ conversationId: conv!.id, text: "Hello Omar, thanks for asking." });
    const [mail] = await db.select().from(emailLog).where(eq(emailLog.template, "inbox.reply"));
    expect(mail).toMatchObject({ to: "omar@example.com" });
    expect(mail!.subject).toMatch(/^Re: Your enquiry with /);
    const [msg] = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
    expect(msg!.externalId).toBe(`email:${mail!.id}`);
    // The job payload carries the lead reply-to address.
    const job = (
      await db.execute<{ payload: { replyTo: string } }>(
        sql`select payload from job_runs where name = 'email.send' and payload->>'emailId' = ${mail!.id}`,
      )
    ).rows[0];
    expect(job?.payload.replyTo).toBe(`lead+${emailLead.leadId}@in.havendune.example`);
    // A contact with neither email nor phone cannot get a conversation.
    const nobody = await captureLead(db, { source: "manual", contact: { name: "Walk-in" } });
    expect(await leadConversation(db, nobody.leadId, new Date())).toBeNull();
    expect(await db.select().from(contacts)).toHaveLength(3);
  });
});
