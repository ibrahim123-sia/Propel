import "server-only";
import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { conversations, messages } from "@/db/schema/crm";
import { rateLimits } from "@/db/schema/system";
import { properties } from "@/db/schema/properties";
import { projects } from "@/db/schema/projects";
import { sendOutgoing } from "@/features/inbox/store";
import { loadListingCards } from "@/features/listings/cards";
import { siteUrl } from "@/features/site/url";
import { ActionError } from "@/lib/actions";
import { marketFormats } from "./lookup";
import { loadSettings } from "@/features/settings/queries";
import type { SettingsOf } from "@/features/settings/schema";
import { zonedDate } from "@/features/viewings/slots";
import { enqueue } from "@/jobs/enqueue";
import { defineJob } from "@/jobs/types";
import { ai as t } from "@/lib/i18n/dictionaries/ai";
import { format } from "@/lib/i18n";
import type { AiFeature } from "@/db/schema/ai";
import { prompt } from "../prompts";
import { runAgent, type RunAgentResult, type RunEvent, type ToolCallLog } from "../runner";
import type { AiActor } from "../tools/registry";
import type { AiMessage, AiProvider } from "../types";
import { customerTools } from "./customer-tools";
import { handOver } from "./handover";
import { registerCustomerMockRules } from "./customer-mock";

/**
 * The customer assistant (10 §2): one brain for the website chat and WhatsApp. A visitor's
 * message queues `ai.customer_reply`; the job reads the conversation, runs the agent with the
 * customer tools, and posts the answer (with listing cards) in the conversation, where the
 * chat window picks it up at its next poll. When the assistant cannot answer (AI off, over
 * budget, an error), the conversation goes to the team as it did before Phase 9.
 */

/* The prompt ----------------------------------------------------------------------------- */

const toneText: Record<SettingsOf<"ai">["tone"], string> = {
  friendly: "warm, friendly and helpful, like a good agent on the phone",
  formal: "polite and professional",
  short: "brief and to the point",
};

export async function customerSystemPrompt(db: DbOrTx): Promise<string> {
  const [ai, general] = [await loadSettings("ai", db), await loadSettings("general", db)];
  const need = ai.requiredBeforeBooking;
  return prompt("customer-system", {
    agencyName: general.agencyName,
    assistantName: ai.assistantName,
    tone: toneText[ai.tone],
    humanTopics: ai.humanTopics,
    requiredBeforeBooking: [
      need.name ? "their name" : null,
      need.phone ? "a phone number" : null,
      need.email ? "an email address" : null,
      "the listing and a free time",
    ].filter((x): x is string => Boolean(x)),
    agencyRules: ai.assistantRules.length
      ? ai.assistantRules.map((r) => `- ${r}`).join("\n")
      : "(none)",
  });
}

/* Per-turn context ----------------------------------------------------------------------- */

const weekdayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function localClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day =
    weekdayKeys[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"))]!;
  return { day, hhmm: `${get("hour")}:${get("minute")}` };
}

/** "Open now, until 18:00" or "Closed now. …" from the agency's viewing hours (Settings). */
export async function officeStatus(db: DbOrTx, now: Date): Promise<string> {
  const [general, viewings, contact, ai] = [
    await loadSettings("general", db),
    await loadSettings("viewings", db),
    await loadSettings("contact", db),
    await loadSettings("ai", db),
  ];
  const { day, hhmm } = localClock(now, general.timeZone);
  const today = zonedDate(now, general.timeZone);
  const holiday = viewings.holidays.includes(today);
  const open = holiday
    ? undefined
    : viewings.workingHours[day].find(([from, to]) => from <= hhmm && hhmm < to);
  const hours = contact.openingHours ? ` Opening hours: ${contact.openingHours}.` : "";
  return open
    ? `Open now, until ${open[1]} (${general.timeZone}).${hours}`
    : `Closed now. ${ai.outsideHoursMessage}${hours}`;
}

export type PageContext = { path?: string | null };

/** What the visitor is looking at, from the page address the chat was opened on. */
export async function pageContextText(db: DbOrTx, page: PageContext | null): Promise<string> {
  const path = page?.path?.split("#")[0] ?? "";
  if (!path) return "(not known)";
  const [pathname, query] = path.split("?");
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts[0] === "property" && parts[1]) {
    const [row] = await db
      .select({ reference: properties.reference, title: properties.title })
      .from(properties)
      .where(and(eq(properties.agencyId, currentAgencyId()), eq(properties.slug, parts[1])))
      .limit(1);
    if (row) return `the listing ${row.reference} · ${row.title} (use get_listing for its facts)`;
  }
  if (parts[0] === "projects" && parts[1]) {
    const [row] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.agencyId, currentAgencyId()), eq(projects.slug, parts[1])))
      .limit(1);
    if (row) return `the project ${row.name} (use get_project for its facts)`;
  }
  if (parts[0] === "areas" && parts[1])
    return `the area guide for "${parts[1].replace(/-/g, " ")}"`;
  if (["buy", "rent", "off-plan"].includes(parts[0] ?? ""))
    return `search results: /${parts.join("/")}${query ? `?${query}` : ""}`;
  return `the page /${parts.join("/")}`;
}

export async function contextBlock(db: DbOrTx, page: PageContext | null, now: Date) {
  const general = await loadSettings("general", db);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: general.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  return prompt("customer-context", {
    today: `${today} (${zonedDate(now, general.timeZone)})`,
    officeStatus: await officeStatus(db, now),
    pageContext: await pageContextText(db, page),
  });
}

/* History -------------------------------------------------------------------------------- */

export type ChatLine = { sender: "customer" | "ai" | "admin" | "system"; body: string };

/**
 * The conversation as model turns: the visitor's messages are user turns, the assistant's and
 * the team's are assistant turns (the team's marked as such), notices are left out. Turns of
 * the same side are joined, and the history starts with the visitor.
 */
export function historyMessages(lines: ChatLine[]): AiMessage[] {
  const out: AiMessage[] = [];
  for (const line of lines) {
    if (line.sender === "system" || !line.body.trim()) continue;
    const role = line.sender === "customer" ? "user" : "assistant";
    const text =
      line.sender === "admin" ? `(A person from the team wrote:) ${line.body}` : line.body;
    const last = out.at(-1);
    if (last?.role === role) last.content.push({ type: "text", text });
    else out.push({ role, content: [{ type: "text", text }] });
  }
  while (out[0] && out[0].role !== "user") out.shift();
  return out;
}

/* One turn ------------------------------------------------------------------------------- */

/** "I've asked our team to reply", "I'll pass this on to our agents": a promised hand-over. */
export function claimsHandover(text: string): boolean {
  const done = /\bi(?:'ve|’ve| have)\s+(?:just\s+)?(?:asked|told|passed|forwarded|notified|let)\b/i;
  const will = /\bi(?:'ll|’ll| will)\s+(?:just\s+)?(?:ask|tell|pass|forward|notify|let)\b/i;
  const team = /\b(?:team|agents?|colleagues?|someone)\b/i;
  // Questions ("Shall I ask the team?") are offers, not promises.
  return text
    .split(/(?<=[.!?\n])\s+/)
    .filter((s) => !s.trim().endsWith("?"))
    .some((s) => (done.test(s) || will.test(s)) && team.test(s));
}

export type CustomerTurn = RunAgentResult & {
  handedOver: boolean;
  /** The answer told the visitor the team would reply, but `request_human` was not called. */
  handoverOnlyClaimed: boolean;
  /** Listing ids to show as cards under the answer. */
  cards: string[];
};

type ListingRef = { id: string; reference: string; title: string };

/** Listings a tool returned in this turn, in order. */
function returnedListings(calls: ToolCallLog[]): { all: ListingRef[]; searched: ListingRef[] } {
  const all: ListingRef[] = [];
  const searched: ListingRef[] = [];
  const add = (list: ListingRef[], l: unknown) => {
    const x = l as Partial<ListingRef> | null;
    if (x?.id && x.reference && x.title && !list.some((y) => y.id === x.id))
      list.push({ id: x.id, reference: x.reference, title: x.title });
  };
  for (const c of calls) {
    if (!c.ok || !c.output) continue;
    const out = c.output as { listings?: unknown[]; confidence?: string; found?: boolean };
    if (c.name === "search_listings") {
      for (const l of out.listings ?? []) add(all, l);
      if (out.confidence === "high" || out.confidence === "medium")
        for (const l of out.listings ?? []) add(searched, l);
    } else if (c.name === "get_listing" && out.found) add(all, out);
  }
  return { all, searched };
}

/**
 * Cards under the answer: the listings it names (by reference or title); when it names none
 * but a confident search ran, the search results. Never more than 6.
 */
export function cardsFor(text: string, calls: ToolCallLog[]): string[] {
  const { all, searched } = returnedListings(calls);
  const said = text.toLowerCase();
  const named = all.filter(
    (l) => said.includes(l.reference.toLowerCase()) || said.includes(l.title.toLowerCase()),
  );
  return (named.length ? named : searched).slice(0, 6).map((l) => l.id);
}

export async function runCustomerTurn(options: {
  db: DbOrTx;
  feature?: Extract<AiFeature, "customer_chat" | "whatsapp">;
  history: AiMessage[];
  page?: PageContext | null;
  actor?: AiActor;
  conversationId?: string | null;
  now?: Date;
  provider?: AiProvider;
  onEvent?: (event: RunEvent) => void;
}): Promise<CustomerTurn> {
  const now = options.now ?? new Date();
  registerCustomerMockRules();
  const history = options.history.map((m) => ({ ...m, content: [...m.content] }));
  const last = history.at(-1);
  if (!last || last.role !== "user") throw new Error("The last turn must be the visitor's.");
  // Today's date, office hours and the page go at the start of the visitor's turn, so the
  // system prompt stays the same all conversation (cached).
  last.content.unshift({
    type: "text",
    text: await contextBlock(options.db, options.page ?? null, now),
  });

  const run = await runAgent({
    feature: options.feature ?? "customer_chat",
    tier: "chat",
    system: await customerSystemPrompt(options.db),
    messages: history,
    tools: customerTools,
    context: {
      actor: options.actor ?? { type: "visitor", visitorId: null },
      conversationRef: options.conversationId ?? null,
    },
    maxSteps: 8,
    maxTokens: 2048,
    db: options.db,
    provider: options.provider,
    onEvent: options.onEvent,
    now,
  });
  const called = run.toolCalls.some((c) => c.name === "request_human" && c.ok);
  // A model may say "I've asked our team" without calling the tool; the visitor then waits
  // for a person, so the hand-over happens anyway (replyInConversation).
  const claimed = !called && run.status === "done" && claimsHandover(run.text);
  return {
    ...run,
    handedOver: called || claimed,
    handoverOnlyClaimed: claimed,
    cards: run.status === "done" ? cardsFor(run.text, run.toolCalls) : [],
  };
}

/* In a conversation ---------------------------------------------------------------------- */

/** Short grey lines in the inbox ("Searched listings", "Checked free times"), 09 §6. */
const toolSummaries: Record<string, string> = {
  search_listings: "Searched listings",
  get_listing: "Looked up a listing",
  get_project: "Looked up a project",
  nearby: "Checked nearby places",
  area_info: "Looked up an area",
  answer_faq: "Searched the FAQs",
  mortgage_estimate: "Worked out a mortgage estimate",
  rental_return: "Worked out a rental return",
  compare: "Compared listings",
  available_slots: "Checked free viewing times",
  book_viewing: "Booked a viewing",
  save_contact: "Saved contact details",
  request_human: "Handed over to the team",
  send_brochure: "Emailed a brochure",
};

function summarise(call: ToolCallLog): { tool: string; summary: string } {
  const base = toolSummaries[call.name] ?? call.name;
  const input = call.input as { reference?: string; references?: string[] } | null;
  const ref = input?.reference ?? input?.references?.join(", ");
  return {
    tool: call.name,
    summary: `${base}${ref ? ` (${ref})` : ""}${call.ok ? "" : " - failed"}`,
  };
}

const HISTORY_LIMIT = 40;
const LEASE_SECONDS = 120;

/** One reply at a time per conversation: a short lease row (expires on its own after a crash). */
async function takeLease(db: DbOrTx, conversationId: string, now: Date): Promise<boolean> {
  const key = `ai-reply:${conversationId}`;
  // A lease left by a crashed run frees itself.
  await db.delete(rateLimits).where(and(eq(rateLimits.key, key), lt(rateLimits.expiresAt, now)));
  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1, expiresAt: new Date(now.getTime() + LEASE_SECONDS * 1000) })
    .onConflictDoNothing()
    .returning({ key: rateLimits.key });
  return rows.length > 0;
}

async function dropLease(db: DbOrTx, conversationId: string) {
  await db.delete(rateLimits).where(eq(rateLimits.key, `ai-reply:${conversationId}`));
}

export type ReplyOutcome =
  | { status: "replied"; messageId: string; handedOver: boolean }
  | { status: "fallback"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "deferred" };

/**
 * Answers the visitor's latest message in a conversation the assistant handles (status "ai").
 * Skips when a person has it, when that message was already answered, or when the visitor
 * wrote nothing new; defers when another reply for the same conversation is running.
 */
export async function replyInConversation(
  db: Db,
  input: { conversationId: string; page?: PageContext | null; now?: Date; provider?: AiProvider },
): Promise<ReplyOutcome> {
  const now = input.now ?? new Date();
  const [conv] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, input.conversationId),
        eq(conversations.agencyId, currentAgencyId()),
      ),
    );
  if (!conv) return { status: "skipped", reason: "missing" };
  if (conv.status !== "ai") return { status: "skipped", reason: conv.status };

  if (!(await takeLease(db, conv.id, now))) return { status: "deferred" };
  try {
    const rows = await db
      .select({
        id: messages.id,
        sender: messages.sender,
        body: messages.body,
        direction: messages.direction,
        inReplyTo: messages.inReplyTo,
      })
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(HISTORY_LIMIT);
    rows.reverse();
    const lastIn = rows.filter((m) => m.direction === "in").at(-1);
    if (!lastIn) return { status: "skipped", reason: "no_message" };
    const lastInIndex = rows.lastIndexOf(lastIn);
    const answered =
      rows.slice(lastInIndex + 1).some((m) => m.sender === "admin") ||
      rows.some((m) => m.sender === "ai" && m.inReplyTo === lastIn.id);
    if (answered) return { status: "skipped", reason: "answered" };

    const history = historyMessages(rows);
    const feature = conv.channel === "whatsapp" ? "whatsapp" : "customer_chat";
    const turn = await runCustomerTurn({
      db,
      feature,
      history,
      page: input.page ?? null,
      actor: { type: "visitor", visitorId: conv.visitorId },
      conversationId: conv.id,
      now,
      provider: input.provider,
    });

    // A person may have taken over while the model was thinking: their word wins.
    const [current] = await db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conv.id));
    if (current?.status === "human" || current?.status === "closed")
      return { status: "skipped", reason: "taken_over" };

    const toolCalls = turn.toolCalls.map(summarise);
    if (turn.status === "unavailable" || turn.status === "error") {
      await fallBackToTeam(db, conv.id, turn.unavailable?.reason ?? turn.error ?? "error", now);
      return { status: "fallback", reason: turn.unavailable?.reason ?? "error" };
    }
    let text = turn.text;
    let handedOver = turn.handedOver;
    if (turn.handoverOnlyClaimed)
      await handOver(db, {
        conversationId: conv.id,
        reason: "The assistant told the visitor the team would reply.",
        now,
      });
    if (turn.status === "refusal" || turn.status === "max_steps" || !text) {
      // No usable answer: say so plainly and let a person take it from here.
      const reason =
        turn.status === "refusal"
          ? "The assistant could not answer this."
          : "The assistant got stuck.";
      const h = await handOver(db, { conversationId: conv.id, reason, now });
      text =
        turn.status === "max_steps"
          ? t.stepsExhausted
          : format(t.handover, { agent: h.agentName ?? "our team" });
      handedOver = true;
    }
    const sentAt = new Date(Math.max(now.getTime(), Date.now()));
    let sent: { messageId: string };
    try {
      sent = await sendOutgoing(db, {
        conversationId: conv.id,
        text,
        sender: "ai",
        toolCalls,
        cards: conv.channel === "web_chat" ? turn.cards : [],
        inReplyTo: lastIn.id,
        now: sentAt,
      });
    } catch (err) {
      // WhatsApp's 24-hour window closed while the job waited: only a person (with a
      // template) can write now.
      if (err instanceof ActionError && err.code === "WA_WINDOW") {
        await db
          .update(conversations)
          .set({ status: "needs_human" })
          .where(eq(conversations.id, conv.id));
        return { status: "skipped", reason: "wa_window" };
      }
      throw err;
    }
    // On WhatsApp a listing card is a photo with its caption and link (10 §2).
    if (conv.channel === "whatsapp" && turn.cards.length)
      await sendWhatsappCards(db, conv.id, turn.cards.slice(0, 3), sentAt);
    return { status: "replied", messageId: sent.messageId, handedOver };
  } finally {
    await dropLease(db, conv.id);
  }
}

/** Listing cards as WhatsApp photos: title, live price and link in the caption. */
async function sendWhatsappCards(db: Db, conversationId: string, ids: string[], at: Date) {
  const market = await loadSettings("market", db);
  const f = marketFormats(market);
  const cards = await loadListingCards(db, ids);
  for (const [i, card] of cards.entries()) {
    const caption = `${card.title}\n${f.price(card)}\n${siteUrl(`/property/${card.slug}`)}`;
    await sendOutgoing(db, {
      conversationId,
      text: caption,
      sender: "ai",
      image: card.photos[0] ? { link: siteUrl(card.photos[0].url), caption } : null,
      // After the answer, in order.
      now: new Date(at.getTime() + i + 1),
    });
  }
}

/** The assistant is off or failed: the team answers, and the visitor is told once. */
async function fallBackToTeam(db: Db, conversationId: string, reason: string, now: Date) {
  await db
    .update(conversations)
    .set({ status: "needs_human" })
    .where(eq(conversations.id, conversationId));
  const [lastNotice] = await db
    .select({ body: messages.body })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.sender, ["system"])))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (lastNotice?.body !== t.customerFallback)
    await sendOutgoing(db, {
      conversationId,
      text: t.customerFallback,
      sender: "system",
      toolCalls: [{ tool: "fallback", summary: `The assistant did not answer (${reason})` }],
      now,
    });
}

/* The job -------------------------------------------------------------------------------- */

export const customerReplyJob = defineJob({
  name: "ai.customer_reply",
  payload: z.object({
    conversationId: z.uuid(),
    messageId: z.uuid(),
    page: z
      .object({ path: z.string().max(500).nullable() })
      .nullable()
      .default(null),
  }),
  maxAttempts: 3,
  async run({ conversationId, messageId, page }, { db }) {
    const outcome = await replyInConversation(db, { conversationId, page });
    if (outcome.status === "deferred")
      // Another reply is being written; this message is answered by it or right after it.
      await enqueue(
        "ai.customer_reply",
        { conversationId, messageId, page },
        {
          db,
          dedupeKey: `ai.customer_reply:${messageId}:later`,
          runAfter: new Date(Date.now() + 3000),
        },
      );
    return outcome;
  },
});

/** Queues the assistant's answer to a visitor's message. */
export function queueCustomerReply(
  db: DbOrTx,
  input: { conversationId: string; messageId: string; page?: PageContext | null },
) {
  return enqueue(
    "ai.customer_reply",
    {
      conversationId: input.conversationId,
      messageId: input.messageId,
      page: input.page?.path ? { path: input.page.path.slice(0, 500) } : null,
    },
    { db, dedupeKey: `ai.customer_reply:${input.messageId}` },
  );
}

/** Messages shown in the chat window since a message, oldest first (tests). */
export async function conversationLines(db: DbOrTx, conversationId: string) {
  return db
    .select({ sender: messages.sender, body: messages.body, cards: messages.cards })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}
