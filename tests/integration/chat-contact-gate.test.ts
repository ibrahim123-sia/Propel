import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { conversations, leads, messages } from "@/db/schema/crm";
import { jobRuns } from "@/db/schema/system";
import { saveChatContact, sendChatMessage, startChat } from "@/features/chat/actions";
import { CHAT_CONTACT_REQUIRED_AFTER } from "@/features/chat/limits";
import { addIncoming } from "@/features/inbox/store";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { chat as t } from "@/lib/i18n/dictionaries/chat";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

const VID = "0192f000-0000-7000-8000-00000000c0c0";
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (n in jar ? { name: n, value: jar[n] } : undefined),
  }),
  headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.31" }),
}));

const actor = { type: "admin" as const, id: testAdmin.id };

async function poll() {
  const { GET } = await import("@/app/api/chat/route");
  const res = await GET(
    new Request("http://localhost/api/chat", { headers: { cookie: `vid=${VID}` } }),
  );
  return (await res.json()) as {
    conversation: { id: string; hasContact: boolean; visitorMessages: number } | null;
  };
}

const replyJobs = async () => {
  const db = await getDb();
  return (await db.select().from(jobRuns).where(eq(jobRuns.name, "ai.customer_reply"))).length;
};

describe("website chat: details after a few messages, required from the 15th", () => {
  beforeEach(async () => {
    await truncate(
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "visitors",
      "conversations",
      "messages",
      "rate_limits",
      "job_runs",
      "settings",
    );
    jar.vid = VID;
    const db = await getDb();
    await patchSettings(
      db,
      "integrations",
      { ai: { ...defaultsFor("integrations").ai, enabled: true, provider: "mock" } },
      actor,
    );
    await patchSettings(db, "ai", { webChat: { enabled: true, askContactFirst: false } }, actor);
  });

  it("answers freely, then waits for details at the 15th message, then answers again", async () => {
    const started = await startChat({ message: "Hi, just looking" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const conversationId = started.data.conversationId;
    expect((await poll()).conversation).toMatchObject({ hasContact: false, visitorMessages: 1 });
    expect(await replyJobs()).toBe(1);

    const db = await getDb();
    for (let i = 2; i < CHAT_CONTACT_REQUIRED_AFTER; i++)
      await addIncoming(db, { conversationId, body: `Question ${i}`, at: new Date() });

    // The 15th message: no reply from the assistant, a polite request for details instead.
    expect(await sendChatMessage({ text: "And the service charges?" })).toMatchObject({ ok: true });
    expect(await replyJobs()).toBe(1);
    const asked = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.sender, "system")));
    expect(asked.map((m) => m.body)).toEqual([t.contactRequired]);
    expect((await poll()).conversation).toMatchObject({
      hasContact: false,
      visitorMessages: CHAT_CONTACT_REQUIRED_AFTER,
    });

    // Details from the small form: a lead on this conversation, and the waiting question answered.
    expect(await saveChatContact({ name: "Omar", email: "", phone: "" })).toMatchObject({
      ok: false,
      fieldErrors: { phone: [t.contactNeedOne] },
    });
    expect(
      await saveChatContact({ name: "Omar Haddad", email: "omar@example.com", phone: "" }),
    ).toMatchObject({ ok: true });
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conv!.contactId).not.toBeNull();
    const [lead] = await db.select().from(leads).where(eq(leads.id, conv!.leadId!));
    expect(lead).toMatchObject({ source: "chat" });
    expect((await poll()).conversation).toMatchObject({ hasContact: true });
    expect(await replyJobs()).toBe(2);

    // With details, the 16th message is answered as usual.
    await sendChatMessage({ text: "Thanks. Two beds?" });
    expect(await replyJobs()).toBe(3);
  });
});
