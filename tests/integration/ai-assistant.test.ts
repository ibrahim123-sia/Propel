import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { conversations, leadEvents, leads, messages, viewings } from "@/db/schema/crm";
import { properties } from "@/db/schema/properties";
import { emailLog, jobRuns } from "@/db/schema/system";
import { replyInConversation } from "@/features/ai/assistant/customer";
import { queueIdleSummaries, summariseConversation } from "@/features/ai/assistant/summary";
import { setProviderOverride } from "@/features/ai/config";
import { MockProvider, resetMock, scriptMockReplies } from "@/features/ai/providers/mock";
import { aiUsage } from "@/db/schema/ai";
import { resetEnvCache } from "@/lib/env";
import { askForPerson, sendChatMessage, startChat } from "@/features/chat/actions";
import { addIncoming } from "@/features/inbox/store";
import { setWhatsappClient } from "@/features/integrations/whatsapp/client";
import { handleWhatsappWebhook } from "@/features/integrations/whatsapp/inbound";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { availableSlots } from "@/features/viewings/availability";
import { runDueJobs } from "@/jobs/runner";
import { evalWorldTables, seedEvalWorld, type EvalWorld } from "../ai/fixtures";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

const VID = "0192f000-0000-7000-8000-00000000a1a1";
const jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (n in jar ? { name: n, value: jar[n] } : undefined),
  }),
  headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.20" }),
}));

const actor = { type: "admin" as const, id: testAdmin.id };
let world: EvalWorld;

async function poll() {
  const { GET } = await import("@/app/api/chat/route");
  const res = await GET(
    new Request("http://localhost/api/chat", { headers: { cookie: `vid=${VID}` } }),
  );
  return (await res.json()) as {
    conversation: { id: string; status: string } | null;
    messages: Array<{
      mine: boolean;
      sender: string;
      body: string;
      cards: Array<{ id: string; title: string; price: string; href: string }>;
    }>;
  };
}

async function slugOf(id: string) {
  const db = await getDb();
  const [row] = await db
    .select({ slug: properties.slug })
    .from(properties)
    .where(eq(properties.id, id));
  return row!.slug;
}

async function aiReplies(conversationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.sender, "ai")))
    .orderBy(asc(messages.createdAt));
}

const contact = { name: "Mina Park", email: "mina@example.com", phone: "" };

describe("customer assistant in the website chat (10 §2)", () => {
  beforeEach(async () => {
    resetMock();
    await truncate(
      ...evalWorldTables,
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "visitors",
      "conversations",
      "messages",
      "viewings",
      "agents",
      "rate_limits",
      "job_runs",
      "email_log",
      "ai_usage",
      "audit_log",
    );
    jar.vid = VID;
    const db = await getDb();
    world = await seedEvalWorld(db);
    await patchSettings(
      db,
      "integrations",
      { ai: { ...defaultsFor("integrations").ai, enabled: true, provider: "mock" } },
      actor,
    );
    await patchSettings(db, "ai", { webChat: { enabled: true, askContactFirst: true } }, actor);
    await patchSettings(
      db,
      "contact",
      { leadNotifyEmails: ["leads@agency.example"], email: "hello@agency.example" },
      actor,
    );
    await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
  });

  it("answers with live listing cards, hands over on a price negotiation, then stays quiet", async () => {
    const db = await getDb();
    const started = await startChat({
      ...contact,
      message: "Do you have a two-bedroom apartment with a sea view in Dubai Marina?",
      page: "/",
    });
    expect(started.ok).toBe(true);
    const [conv] = await db.select().from(conversations);
    expect(conv).toMatchObject({ channel: "web_chat", status: "ai" });

    expect((await runDueJobs()).ran).toBeGreaterThan(0);
    let view = await poll();
    const answer = view.messages.find((m) => m.sender === "ai")!;
    expect(answer.body).toContain(world.listings.marinaSeaView.title);
    expect(answer.cards.map((c) => c.id)).toContain(world.listings.marinaSeaView.id);
    expect(answer.cards[0]).toMatchObject({ price: expect.stringContaining("AED") });
    const [stored] = await aiReplies(conv!.id);
    expect(stored!.toolCalls).toContainEqual({
      tool: "search_listings",
      summary: "Searched listings",
    });
    expect(stored!.inReplyTo).not.toBeNull();

    // Price negotiation is a human topic: hand over, tell the team once.
    const villa = `/property/${await slugOf(world.listings.hillsVilla.id)}`;
    expect(
      (
        await sendChatMessage({
          text: "Can you get the owner to drop the price by 10%?",
          page: villa,
        })
      ).ok,
    ).toBe(true);
    await runDueJobs();
    view = await poll();
    expect(view.conversation!.status).toBe("needs_human");
    expect(view.messages.at(-1)!.body).toMatch(/I've asked .* to reply to you/);
    const notices = await db
      .select({ to: emailLog.to })
      .from(emailLog)
      .where(eq(emailLog.template, "chat.handover"));
    expect(notices.map((n) => n.to)).toEqual(["leads@agency.example"]);

    // A person has it now: no more assistant replies are queued.
    await sendChatMessage({ text: "Hello?" });
    const queued = await db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.name, "ai.customer_reply"), eq(jobRuns.status, "queued")));
    expect(queued).toHaveLength(0);
    expect(await aiReplies(conv!.id)).toHaveLength(2);
  });

  it("answers two quick messages once, and the visitor can ask for a person", async () => {
    const db = await getDb();
    await startChat({ ...contact, message: "Hi, I'm looking around" });
    const [conv] = await db.select().from(conversations);
    // A second message arrives before the first reply: one answer covers both.
    await addIncoming(db, { conversationId: conv!.id, body: "Any villas?", at: new Date() });
    const first = await replyInConversation(db, { conversationId: conv!.id });
    expect(first.status).toBe("replied");
    expect(await replyInConversation(db, { conversationId: conv!.id })).toEqual({
      status: "skipped",
      reason: "answered",
    });
    expect(await aiReplies(conv!.id)).toHaveLength(1);

    expect((await askForPerson()).ok).toBe(true);
    const view = await poll();
    expect(view.conversation!.status).toBe("needs_human");
    expect(view.messages.at(-1)).toMatchObject({ sender: "system" });
    expect(view.messages.at(-1)!.body).toContain("to reply to you here");
  });

  it("books a real free slot only after the details are there, and links the lead", async () => {
    const db = await getDb();
    const villa = world.listings.hillsVilla;
    await startChat({
      ...contact,
      message: "I'd like to see this villa",
      page: `/property/${await slugOf(villa.id)}`,
    });
    await runDueJobs();
    let view = await poll();
    expect(view.messages.at(-1)!.body).toMatch(/free times/);

    const { slots } = await availableSlots(db, null);
    const start = slots[0]!.start.toISOString();
    const booking = {
      reference: villa.reference,
      start,
      name: "Mina Park",
      visitorConfirmed: true,
    };
    // Without a phone number (Settings -> AI asks for one) nothing is booked.
    scriptMockReplies(
      { toolCalls: [{ name: "book_viewing", input: booking }] },
      { text: "What number can the agent call you on?" },
    );
    await sendChatMessage({ text: "The first one, please" });
    await runDueJobs();
    expect(await db.select().from(viewings)).toHaveLength(0);

    scriptMockReplies(
      { toolCalls: [{ name: "book_viewing", input: { ...booking, phone: "+971 50 123 4567" } }] },
      { text: "You're booked." },
    );
    await sendChatMessage({ text: "+971 50 123 4567, yes that's right" });
    await runDueJobs();
    const [viewing] = await db.select().from(viewings);
    expect(viewing).toMatchObject({ source: "chat", status: "confirmed", propertyId: villa.id });
    expect(viewing!.startsAt.toISOString()).toBe(start);
    const [conv] = await db.select().from(conversations);
    expect(conv!.leadId).toBe(viewing!.leadId);
    view = await poll();
    expect(view.messages.at(-1)!.body).toBe("You're booked.");
  });

  it("a promised hand-over happens even when the model forgot to call request_human", async () => {
    const db = await getDb();
    await startChat({ ...contact, message: "Can you get the owner to drop the price by 10%?" });
    const [conv] = await db.select().from(conversations);
    scriptMockReplies({ text: "Sure, I’ll pass this on to our team." });
    expect(await replyInConversation(db, { conversationId: conv!.id })).toMatchObject({
      status: "replied",
      handedOver: true,
    });
    const [after] = await db.select().from(conversations).where(eq(conversations.id, conv!.id));
    expect(after!.status).toBe("needs_human");
  });

  it("goes to the team when the assistant cannot answer, telling the visitor once", async () => {
    const db = await getDb();
    // Anthropic without a key: the assistant is unavailable.
    await patchSettings(
      db,
      "integrations",
      { ai: { ...defaultsFor("integrations").ai, enabled: true, provider: "anthropic" } },
      actor,
    );
    await startChat({ ...contact, message: "Hello" });
    const [conv] = await db.select().from(conversations);
    expect(conv!.status).toBe("ai");
    expect(await replyInConversation(db, { conversationId: conv!.id })).toMatchObject({
      status: "fallback",
    });
    const view = await poll();
    expect(view.conversation!.status).toBe("needs_human");
    expect(view.messages.filter((m) => m.sender === "system")).toHaveLength(1);
    expect(await aiReplies(conv!.id)).toHaveLength(0);
  });

  it("summarises a quiet chat onto the lead with the requirements it learned", async () => {
    const db = await getDb();
    await startChat({
      ...contact,
      message: "Do you have anything with a sea view in Dubai Marina?",
    });
    await runDueJobs();
    const [conv] = await db.select().from(conversations);
    expect(conv!.leadId).not.toBeNull();

    // Not quiet long enough yet; then 16 minutes later it is queued once.
    expect(await queueIdleSummaries(db, new Date(Date.now() + 5 * 60_000))).toBe(0);
    const later = new Date(Date.now() + 16 * 60_000);
    expect(await queueIdleSummaries(db, later)).toBe(1);
    expect(await queueIdleSummaries(db, later)).toBe(0);

    scriptMockReplies({
      text: JSON.stringify({
        summary:
          "Mina wants a two-bed with a sea view in Dubai Marina, up to AED 2M, with a mortgage.",
        requirements: {
          purpose: "sale",
          budgetMax: 2000000,
          areas: ["Dubai Marina"],
          bedsMin: 2,
          timeline: "1_3_months",
          finance: "mortgage",
        },
      }),
    });
    const outcome = await summariseConversation(db, conv!.id, { now: later });
    expect(outcome).toMatchObject({ status: "summarised", leadId: conv!.leadId });
    const [lead] = await db.select().from(leads).where(eq(leads.id, conv!.leadId!));
    expect(lead!.requirements).toMatchObject({
      purpose: "sale",
      budgetMax: 200_000_000,
      budgetFrom: "lead",
      locationIds: [world.locations.marina],
      bedsMin: 2,
      timeline: "1_3_months",
      finance: "mortgage",
    });
    const events = await db
      .select({ body: leadEvents.body })
      .from(leadEvents)
      .where(and(eq(leadEvents.leadId, lead!.id), eq(leadEvents.type, "ai_summary")));
    expect(events[0]!.body).toContain("sea view");
    expect(await summariseConversation(db, conv!.id, { now: later })).toEqual({
      status: "skipped",
      reason: "up_to_date",
    });
  });
});

describe("customer assistant on WhatsApp (10 §2)", () => {
  const sent: Array<{ kind: string; to: string; payload: unknown }> = [];
  const wa = "971501112233";
  const inbound = (id: string, message: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "123" },
              contacts: [{ wa_id: wa, profile: { name: "Sam Visitor" } }],
              messages: [
                { from: wa, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
              ],
            },
          },
        ],
      },
    ],
  });

  beforeEach(async () => {
    resetMock();
    sent.length = 0;
    await truncate(
      ...evalWorldTables,
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "visitors",
      "conversations",
      "messages",
      "rate_limits",
      "job_runs",
      "email_log",
      "ai_usage",
      "audit_log",
    );
    const db = await getDb();
    world = await seedEvalWorld(db);
    await patchSettings(
      db,
      "integrations",
      { ai: { ...defaultsFor("integrations").ai, enabled: true, provider: "mock" } },
      actor,
    );
    await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
    let n = 0;
    const ok = (kind: string, to: string, payload: unknown) => {
      sent.push({ kind, to, payload });
      return Promise.resolve({ id: `wamid.out${++n}` });
    };
    setWhatsappClient({
      sendText: (to, body) => ok("text", to, body),
      sendTemplate: (to, t) => ok("template", to, t),
      sendImage: (to, image) => ok("image", to, image),
    });
  });
  afterEach(() => setWhatsappClient(undefined));

  it("answers on WhatsApp with the listing as its own message, and leaves voice notes to the team", async () => {
    const db = await getDb();
    await handleWhatsappWebhook(
      db,
      inbound("wamid.in1", {
        type: "text",
        text: { body: "Do you have a two-bedroom apartment with a sea view in Dubai Marina?" },
      }) as never,
    );
    const [conv] = await db.select().from(conversations);
    expect(conv).toMatchObject({ channel: "whatsapp", status: "ai" });
    await runDueJobs(); // the reply
    await runDueJobs(); // its delivery
    const replies = await aiReplies(conv!.id);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    expect(replies[0]!.body).toContain(world.listings.marinaSeaView.title);
    expect(replies.some((r) => r.body.includes("/property/"))).toBe(true);
    expect(sent.every((s) => s.to === wa)).toBe(true);
    expect(sent.map((s) => s.kind)).toContain("text");

    // A voice note with no way to write it down (the test provider has none): a person answers.
    await handleWhatsappWebhook(
      db,
      inbound("wamid.in2", {
        type: "audio",
        audio: { id: "media-1", mime_type: "audio/ogg" },
      }) as never,
    );
    await runDueJobs();
    const [after] = await db.select().from(conversations);
    expect(after!.status).toBe("needs_human");
    const queued = await db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.name, "ai.customer_reply"), eq(jobRuns.status, "queued")));
    expect(queued).toHaveLength(0);
  });

  it("writes a voice note down with Groq's Whisper and the assistant answers it", async () => {
    const db = await getDb();
    // Groq chosen (its key from the environment); replies still come from the test provider.
    await patchSettings(
      db,
      "integrations",
      {
        ai: {
          ...defaultsFor("integrations").ai,
          enabled: true,
          provider: "groq",
          chatModel: "openai/gpt-oss-120b",
          fastModel: "openai/gpt-oss-20b",
        },
      },
      actor,
    );
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    resetEnvCache();
    setProviderOverride(new MockProvider());
    setWhatsappClient({
      sendText: () => Promise.resolve({ id: "wamid.outx" }),
      sendTemplate: () => Promise.resolve({ id: "wamid.outy" }),
      sendImage: () => Promise.resolve({ id: "wamid.outz" }),
      downloadMedia: (id) =>
        Promise.resolve(
          id === "media-2" ? { bytes: new Uint8Array([1, 2, 3]), mime: "audio/ogg" } : null,
        ),
    });
    const whisper = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer gsk_test");
      const form = init!.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      return Response.json({ text: "Do you have villas in Dubai Hills?", duration: 4.2 });
    });
    vi.stubGlobal("fetch", whisper);
    try {
      await handleWhatsappWebhook(
        db,
        inbound("wamid.voice1", {
          type: "audio",
          audio: { id: "media-2", mime_type: "audio/ogg" },
        }) as never,
      );
      await runDueJobs(); // the transcription
      const [voice] = await db
        .select()
        .from(messages)
        .where(eq(messages.externalId, "wamid.voice1"));
      expect(voice!.body).toBe("[voice note] Do you have villas in Dubai Hills?");
      expect(whisper).toHaveBeenCalledTimes(1);
      const [conv] = await db.select().from(conversations);
      expect(conv!.status).toBe("ai");
      const reply = await db.select().from(jobRuns).where(eq(jobRuns.name, "ai.customer_reply"));
      expect(reply).toHaveLength(1);
      const [usage] = await db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.model, "whisper-large-v3-turbo"));
      expect(usage).toMatchObject({ feature: "whatsapp", inputTokens: 5 });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      resetEnvCache();
      setProviderOverride(null);
    }
  });
});
