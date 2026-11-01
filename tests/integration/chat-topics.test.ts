import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { chatTopicReports } from "@/db/schema/ai";
import { conversations, messages } from "@/db/schema/crm";
import { chatTopicsTool } from "@/features/ai/assistant/admin-read-tools";
import { resetMock, scriptMockReplies } from "@/features/ai/providers/mock";
import { clusterChatTopics, MIN_QUESTIONS, parseTopicsReply } from "@/features/ai/topics";
import { loadReportContext } from "@/features/reports/context";
import { parsePeriodParams } from "@/features/reports/period";
import { loadDashboardSuggestions } from "@/features/reports/suggestions";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

const actor = { type: "admin" as const, id: testAdmin.id };
const now = new Date("2026-10-26T05:00:00Z");

async function ask(questions: string[], at = new Date(now.getTime() - 86_400_000)) {
  const db = await getDb();
  const [conv] = await db.insert(conversations).values({ channel: "web_chat" }).returning();
  for (const [i, body] of questions.entries())
    await db.insert(messages).values({
      conversationId: conv!.id,
      direction: "in",
      sender: "customer",
      body,
      createdAt: new Date(at.getTime() + i * 1000),
    });
}

describe("weekly chat topic clustering (10 §5)", () => {
  beforeEach(async () => {
    resetMock();
    await truncate("conversations", "messages", "chat_topic_reports", "ai_usage", "properties");
    await patchSettings(
      await getDb(),
      "integrations",
      { ai: { ...defaultsFor("integrations").ai, enabled: true, provider: "mock" } },
      actor,
    );
  });

  it("groups the week's questions, stores them and suggests a blog post", async () => {
    await ask([
      "What are the service charges in JVC?",
      "Are service charges paid yearly? Call me on +971 50 123 4567",
      "How do service charges work for villas?",
      "Can I get a mortgage as a non-resident?",
      "What mortgage rates do banks offer?",
      "hi",
    ]);
    // Older than a week: not part of it.
    await ask(["Is the Marina tower still available?"], new Date(now.getTime() - 9 * 86_400_000));

    const db = await getDb();
    const outcome = await clusterChatTopics(db, { now });
    expect(outcome).toMatchObject({ status: "grouped", weekStart: "2026-10-19", questions: 5 });
    if (outcome.status !== "grouped") return;
    expect(outcome.topics[0]).toMatchObject({ label: "Questions about service", count: 3 });
    expect(outcome.topics.map((t) => t.label)).toContain("Questions about mortgage");
    // Contact details never reach the model or the report.
    expect(JSON.stringify(outcome.topics)).not.toContain("123 4567");

    const [row] = await db.select().from(chatTopicReports);
    expect(row).toMatchObject({ weekStart: "2026-10-19", questionCount: 5 });

    // Run again the same week: the one row is replaced.
    await clusterChatTopics(db, { now });
    expect(await db.select().from(chatTopicReports)).toHaveLength(1);

    const ctx = await loadReportContext(db, parsePeriodParams({}));
    const cards = await loadDashboardSuggestions(db, ctx);
    expect(cards.find((c) => c.id === "blog-topic")).toMatchObject({
      title: "Blog idea: A guide to service",
      href: "/admin/website/blog",
    });

    const tool = (await chatTopicsTool.run({ days: 7 }, { db } as never)) as {
      weeklyTopics: { topics: Array<{ label: string }> } | null;
    };
    expect(tool.weeklyTopics?.topics[0]?.label).toBe("Questions about service");
  });

  it("skips a quiet week and a reply that is not usable", async () => {
    const db = await getDb();
    await ask(["What are the service charges?", "And the mortgage?"]);
    expect(await clusterChatTopics(db, { now })).toEqual({
      status: "skipped",
      reason: "too_few_questions",
    });

    await ask(Array.from({ length: MIN_QUESTIONS }, (_, i) => `Question number ${i} about rent`));
    scriptMockReplies({ text: "Sorry, I cannot help with that." });
    expect(await clusterChatTopics(db, { now })).toEqual({
      status: "skipped",
      reason: "bad_reply",
    });
    expect(await db.select().from(chatTopicReports)).toHaveLength(0);
  });

  it("keeps counts within the questions sent, most asked first", () => {
    const reply = JSON.stringify({
      topics: [
        { label: "Pets", count: 2, examples: ["Pets allowed?"], blogIdea: null },
        { label: "Fees", count: 40, examples: ["What fees?"], blogIdea: "Buying fees explained" },
      ],
    });
    expect(parseTopicsReply(reply, 10)).toEqual([
      { label: "Fees", count: 10, examples: ["What fees?"], blogIdea: "Buying fees explained" },
      { label: "Pets", count: 2, examples: ["Pets allowed?"], blogIdea: null },
    ]);
    expect(parseTopicsReply("not json", 10)).toBeNull();
  });
});
