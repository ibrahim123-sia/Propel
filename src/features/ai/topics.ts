import "server-only";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { chatTopicReports, type ChatTopic } from "@/db/schema/ai";
import { conversations, messages } from "@/db/schema/crm";
import { loadSettings } from "@/features/settings/queries";
import { defineJob } from "@/jobs/types";
import { localDateString } from "@/lib/local-date";
import { checkAiAvailable } from "./limits";
import { prompt } from "./prompts";
import { registerMockRule } from "./providers/mock";
import { generateText, parseJsonReply } from "./runner";
import type { AiProvider } from "./types";

/**
 * Chat topic clustering (10 §5, 13 §2 Mondays): the last seven days of visitor questions from
 * the website chat and WhatsApp, grouped into common topics by the model, stored per week for
 * the dashboard's blog topic card and the assistant's `chat_topics` tool.
 */

export const TOPICS_JOB = "ai.chat_topics";
/** Fewer questions than this make no useful groups; the week is skipped. */
export const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 300;
const MAX_TOPICS = 8;

/** A visitor's words without their phone numbers or email addresses, cut short. */
export function scrubQuestion(body: string): string {
  return body
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[number]")
    .replace(/\S+@\S+/g, "[email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** What visitors wrote in the chat and on WhatsApp between two moments, newest first. */
export async function visitorQuestions(
  db: DbOrTx,
  since: Date,
  until: Date,
  limit = MAX_QUESTIONS,
): Promise<string[]> {
  const rows = await db
    .select({ body: messages.body })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.agencyId, currentAgencyId()),
        eq(messages.sender, "customer"),
        inArray(conversations.channel, ["web_chat", "whatsapp"]),
        gte(messages.createdAt, since),
        lt(messages.createdAt, until),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit * 2);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { body } of rows) {
    const text = scrubQuestion(body);
    const key = text.toLowerCase();
    if (text.length <= 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

const replySchema = z.object({
  topics: z
    .array(
      z.object({
        label: z.string().trim().min(2).max(80),
        count: z.number().int().min(1),
        examples: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
        blogIdea: z.string().trim().min(3).max(120).nullable().catch(null).default(null),
      }),
    )
    .max(MAX_TOPICS * 2),
});

/** The model's topics, most asked first, counts no higher than the questions sent. */
export function parseTopicsReply(text: string, questionCount: number): ChatTopic[] | null {
  const parsed = replySchema.safeParse(parseJsonReply(text));
  if (!parsed.success) return null;
  return parsed.data.topics
    .map((t) => ({ ...t, count: Math.min(t.count, questionCount) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOPICS);
}

const STOP = new Set(
  "about after again also available could does have hello please price prices there their these thing this what when where which would your thanks thank".split(
    " ",
  ),
);

/** The test provider's grouping: by each question's first longer word (development). */
function registerTopicsMockRule() {
  registerMockRule({
    name: "chat-topics",
    reply(ctx) {
      if (!ctx.request.system.includes("You group visitors' questions")) return null;
      const questions = (/<questions>\n([\s\S]*?)\n<\/questions>/.exec(ctx.lastUserText)?.[1] ?? "")
        .split("\n")
        .map((q) => q.replace(/^- /, ""))
        .filter(Boolean);
      const groups = new Map<string, string[]>();
      for (const q of questions) {
        const word = q
          .toLowerCase()
          .split(/[^a-z]+/)
          .find((w) => w.length >= 5 && !STOP.has(w));
        if (!word) continue;
        groups.set(word, [...(groups.get(word) ?? []), q]);
      }
      const topics = [...groups]
        .filter(([, qs]) => qs.length >= 2)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 5)
        .map(([word, qs]) => ({
          label: `Questions about ${word}`,
          count: qs.length,
          examples: qs.slice(0, 2),
          blogIdea: `A guide to ${word}`,
        }));
      return { text: JSON.stringify({ topics }) };
    },
  });
}

export type TopicsOutcome =
  | { status: "grouped"; weekStart: string; questions: number; topics: ChatTopic[] }
  | { status: "skipped"; reason: string };

/** Groups the seven days before `now` and stores them under the week's first day. */
export async function clusterChatTopics(
  db: DbOrTx,
  options: { now?: Date; provider?: AiProvider } = {},
): Promise<TopicsOutcome> {
  const now = options.now ?? new Date();
  if (!(await checkAiAvailable("topics", { db, now })).ok)
    return { status: "skipped", reason: "ai_off" };
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const questions = await visitorQuestions(db, since, now);
  if (questions.length < MIN_QUESTIONS) return { status: "skipped", reason: "too_few_questions" };

  const general = await loadSettings("general", db);
  registerTopicsMockRule();
  const run = await generateText({
    feature: "topics",
    system: prompt("chat-topics", { agencyName: general.agencyName, maxTopics: MAX_TOPICS }),
    // Escaped, so nothing in a question can close the tag.
    user: `<questions>\n${questions.map((q) => `- ${q.replace(/</g, "‹")}`).join("\n")}\n</questions>`,
    maxTokens: 1500,
    effort: "low",
    db,
    provider: options.provider,
    now,
  });
  if (run.status !== "done") return { status: "skipped", reason: run.status };
  const topics = parseTopicsReply(run.text, questions.length);
  if (!topics) return { status: "skipped", reason: "bad_reply" };

  const weekStart = localDateString(since, general.timeZone);
  await db
    .insert(chatTopicReports)
    .values({ weekStart, questionCount: questions.length, topics, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [chatTopicReports.agencyId, chatTopicReports.weekStart],
      set: { questionCount: questions.length, topics, updatedAt: now },
    });
  return { status: "grouped", weekStart, questions: questions.length, topics };
}

/** The newest grouping no older than `maxAgeDays`, or null. */
export async function latestChatTopics(db: DbOrTx, now = new Date(), maxAgeDays = 14) {
  const [row] = await db
    .select({
      weekStart: chatTopicReports.weekStart,
      questionCount: chatTopicReports.questionCount,
      topics: chatTopicReports.topics,
      updatedAt: chatTopicReports.updatedAt,
    })
    .from(chatTopicReports)
    .where(
      and(
        eq(chatTopicReports.agencyId, currentAgencyId()),
        gte(chatTopicReports.updatedAt, new Date(now.getTime() - maxAgeDays * 86_400_000)),
      ),
    )
    .orderBy(desc(chatTopicReports.weekStart))
    .limit(1);
  return row ?? null;
}

export const chatTopicsJob = defineJob({
  name: TOPICS_JOB,
  payload: z.object({}),
  maxAttempts: 2,
  run: (_, { db }) => clusterChatTopics(db),
});
