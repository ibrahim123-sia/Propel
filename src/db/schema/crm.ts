import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agencyColumn, baseColumns, idColumn, numericNumber } from "./_common";
import { users } from "./auth";
import { leadStages, locations, propertyTypes } from "./master-data";
import { agents } from "./people";
import { projects } from "./projects";
import { properties } from "./properties";

/** Visitors, attribution, leads, viewings and conversations (05 §9-12, 09). */

/** A first or last touch (05 §9): campaign data and where the visitor came from. */
export type Touch = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  msclkid?: string;
  ttclid?: string;
  li_fat_id?: string;
  referrer?: string;
  landing_path: string;
  channel:
    | "paid_search"
    | "paid_social"
    | "organic_search"
    | "organic_social"
    | "email"
    | "referral"
    | "direct"
    | "portal"
    | "offline_qr";
  at: string;
};

export const visitors = pgTable(
  "visitors",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    /** The first-party `vid` cookie value. */
    visitorKey: text().notNull(),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    leadId: uuid().references((): AnyPgColumn => leads.id, { onDelete: "set null" }),
    firstTouch: jsonb().$type<Touch>(),
    lastTouch: jsonb().$type<Touch>(),
    consent: jsonb()
      .$type<{ analytics: boolean; marketing: boolean; at: string | null }>()
      .notNull()
      .default({ analytics: false, marketing: false, at: null }),
    device: text(),
    country: text(),
  },
  (t) => [
    uniqueIndex("visitors_key_unique").on(t.agencyId, t.visitorKey),
    index("visitors_lead_idx").on(t.leadId),
    index("visitors_user_idx").on(t.userId),
  ],
);

export const visitorEventTypes = [
  "page_view",
  "listing_view",
  "search",
  "save",
  "share",
  "brochure",
  "tool_use",
  "chat_start",
  "form_start",
  "form_submit",
  "whatsapp_click",
  "call_click",
] as const;
export type VisitorEventType = (typeof visitorEventTypes)[number];

/** The visitor's journey (kept 180 days, then rolled up into daily_metrics). */
export const visitorEvents = pgTable(
  "visitor_events",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    visitorId: uuid()
      .notNull()
      .references(() => visitors.id, { onDelete: "cascade" }),
    type: text({ enum: visitorEventTypes }).notNull(),
    path: text(),
    entityType: text(),
    entityId: uuid(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("visitor_events_visitor_idx").on(t.visitorId, t.createdAt.desc()),
    index("visitor_events_type_idx").on(t.agencyId, t.type, t.createdAt),
    index("visitor_events_entity_idx").on(t.entityType, t.entityId),
  ],
);

/** UTM link builder (09 §2): short links /go/<code> with QR codes and click counts. */
export const utmLinks = pgTable(
  "utm_links",
  {
    ...baseColumns(),
    name: text().notNull(),
    baseUrl: text().notNull(),
    utmSource: text().notNull(),
    utmMedium: text().notNull(),
    utmCampaign: text().notNull(),
    utmTerm: text(),
    utmContent: text(),
    shortCode: text().notNull(),
    clicks: integer().notNull().default(0),
    lastClickedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("utm_links_code_unique").on(t.agencyId, t.shortCode)],
);

export const preferredContacts = ["whatsapp", "call", "email"] as const;

/** People: one contact can have several leads (09 §4 Contacts). */
export const contacts = pgTable(
  "contacts",
  {
    ...baseColumns(),
    name: text().notNull(),
    /** Lowercased. */
    email: text(),
    /** E.164. */
    phone: text(),
    whatsapp: text(),
    nationality: text(),
    preferredContact: text({ enum: preferredContacts }),
    preferredLanguage: text(),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    marketingConsent: boolean().notNull().default(false),
    marketingConsentAt: timestamp({ withTimezone: true }),
    tags: text().array().notNull().default([]),
    notes: text(),
    mergedIntoId: uuid().references((): AnyPgColumn => contacts.id, { onDelete: "set null" }),
  },
  (t) => [
    index("contacts_email_idx").on(t.agencyId, t.email),
    index("contacts_phone_idx").on(t.agencyId, t.phone),
    index("contacts_name_trgm").using("gin", sql`lintel_normalize(${t.name}) gin_trgm_ops`),
  ],
);

export const leadStatuses = ["open", "won", "lost"] as const;
export const leadSources = [
  "form",
  "chat",
  "whatsapp",
  "tour",
  "callback",
  "call_click",
  "mortgage",
  "roi",
  "brochure",
  "valuation",
  "listing_request",
  "signup",
  "saved_search",
  "newsletter",
  "portal",
  "social_form",
  "manual",
  "import",
  "qr",
] as const;
export type LeadSource = (typeof leadSources)[number];

/** What a lead is looking for (05 §10), filled from forms, listings, chats and searches. */
export type Requirements = {
  purpose?: "sale" | "rent";
  /** Minor units of `currency`. */
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string;
  /** "lead": they said it; "listing": a band around the home they asked about. */
  budgetFrom?: "lead" | "listing";
  locationIds?: string[];
  propertyTypeIds?: string[];
  bedsMin?: number | null;
  /** now | 1_3_months | 3_6_months | 6_12_months | later | browsing */
  timeline?: string;
  finance?: "cash" | "mortgage" | "unknown";
  moveInDate?: string | null;
  notes?: string;
};

export const leads = pgTable(
  "leads",
  {
    ...baseColumns(),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    /** One of Settings -> Leads lead types (editable; buyer, tenant, seller, landlord, investor). */
    type: text().notNull().default("buyer"),
    stageId: uuid().references(() => leadStages.id, { onDelete: "restrict" }),
    status: text({ enum: leadStatuses }).notNull().default("open"),
    lostReason: text(),
    source: text({ enum: leadSources }).notNull(),
    /** e.g. the portal or form name, "walk-in". */
    sourceDetail: text(),
    firstTouch: jsonb().$type<Touch>(),
    lastTouch: jsonb().$type<Touch>(),
    visitorId: uuid().references((): AnyPgColumn => visitors.id, { onDelete: "set null" }),
    propertyIds: uuid().array().notNull().default([]),
    projectIds: uuid().array().notNull().default([]),
    requirements: jsonb().$type<Requirements>().notNull().default({}),
    aiScore: integer(),
    aiSummary: text(),
    aiScoreReason: text(),
    aiScoredAt: timestamp({ withTimezone: true }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    firstResponseAt: timestamp({ withTimezone: true }),
    responseSeconds: integer().generatedAlwaysAs(
      sql`case when first_response_at is not null then extract(epoch from first_response_at - created_at)::int end`,
    ),
    /** When the response timer runs out (09 §3.8); cleared by the first real reply. */
    responseDueAt: timestamp({ withTimezone: true }),
    responseAlertSentAt: timestamp({ withTimezone: true }),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    nextTaskAt: timestamp({ withTimezone: true }),
    dealValue: bigint({ mode: "number" }),
    dealCurrency: text(),
    wonAt: timestamp({ withTimezone: true }),
    lostAt: timestamp({ withTimezone: true }),
    tags: text().array().notNull().default([]),
    mergedIntoId: uuid().references((): AnyPgColumn => leads.id, { onDelete: "set null" }),
  },
  (t) => [
    index("leads_status_stage_idx").on(t.agencyId, t.status, t.stageId),
    index("leads_contact_idx").on(t.contactId),
    index("leads_agent_idx").on(t.agentId),
    index("leads_source_idx").on(t.agencyId, t.source, t.createdAt),
    // Reports and the dashboard (09 §7): leads by creation date and deals by the day they were won.
    index("leads_created_idx").on(t.agencyId, t.createdAt),
    index("leads_won_idx")
      .on(t.agencyId, t.wonAt)
      .where(sql`${t.wonAt} is not null`),
    index("leads_response_due_idx").on(t.responseDueAt),
    index("leads_next_task_idx").on(t.nextTaskAt),
  ],
);

export const leadEventTypes = [
  "created",
  "stage_changed",
  "note",
  "call",
  "email_sent",
  "email_received",
  "whatsapp_in",
  "whatsapp_out",
  "chat",
  "viewing_booked",
  "viewing_done",
  "task_done",
  "assigned",
  "merged",
  "ai_summary",
  "property_sent",
  "brochure_sent",
  "form",
  "possible_call",
] as const;

/** The lead's timeline (09 §4 Lead page). */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    type: text({ enum: leadEventTypes }).notNull(),
    body: text(),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    actorType: text({ enum: ["admin", "ai", "system", "customer"] })
      .notNull()
      .default("system"),
    actorId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_events_lead_idx").on(t.leadId, t.createdAt.desc())],
);

export const leadTasks = pgTable(
  "lead_tasks",
  {
    ...baseColumns(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    title: text().notNull(),
    dueAt: timestamp({ withTimezone: true }),
    doneAt: timestamp({ withTimezone: true }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    createdByKind: text({ enum: ["admin", "ai", "rule"] })
      .notNull()
      .default("admin"),
  },
  (t) => [
    index("lead_tasks_lead_idx").on(t.leadId),
    index("lead_tasks_due_idx").on(t.agencyId, t.dueAt),
  ],
);

/** Valuation requests and "list your property" requests (05 §10, 11). */
const ownerRequestColumns = () => ({
  ...baseColumns(),
  contactId: uuid()
    .notNull()
    .references(() => contacts.id, { onDelete: "restrict" }),
  leadId: uuid().references(() => leads.id, { onDelete: "set null" }),
  purpose: text({ enum: ["sell", "rent"] }).notNull(),
  propertyTypeId: uuid().references(() => propertyTypes.id, { onDelete: "set null" }),
  locationId: uuid().references(() => locations.id, { onDelete: "set null" }),
  building: text(),
  beds: integer(),
  baths: integer(),
  /** m² */
  size: numericNumber(),
  /** One of the condition keys of the form (features/valuation/schema.ts). */
  condition: text(),
  /** Upgrade keys ticked on the form ("kitchen", "bathrooms", …). */
  upgrades: text().array().notNull().default([]),
  notes: text(),
  /** Minor units of `currency` (the base currency when the request came in). */
  aiRangeMin: bigint({ mode: "number" }),
  aiRangeMax: bigint({ mode: "number" }),
  currency: text(),
  aiComparableIds: uuid().array().notNull().default([]),
  photoIds: uuid().array().notNull().default([]),
});

export const valuationRequests = pgTable("valuation_requests", ownerRequestColumns(), (t) => [
  index("valuation_requests_lead_idx").on(t.leadId),
]);

export const listingRequests = pgTable(
  "listing_requests",
  {
    ...ownerRequestColumns(),
    askingPrice: bigint({ mode: "number" }),
    availableFrom: date(),
    /** The draft listing made from this request ("Create draft listing", 11 §6). */
    propertyId: uuid().references(() => properties.id, { onDelete: "set null" }),
  },
  (t) => [index("listing_requests_lead_idx").on(t.leadId)],
);

export const viewingStatuses = [
  "requested",
  "confirmed",
  "done",
  "no_show",
  "cancelled",
  "rescheduled",
] as const;

/** Tours (05 §11, 09 §5). */
export const viewings = pgTable(
  "viewings",
  {
    ...baseColumns(),
    leadId: uuid().references(() => leads.id, { onDelete: "set null" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    propertyId: uuid().references(() => properties.id, { onDelete: "set null" }),
    projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
    agentId: uuid().references(() => agents.id, { onDelete: "set null" }),
    type: text({ enum: ["in_person", "video"] })
      .notNull()
      .default("in_person"),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    status: text({ enum: viewingStatuses }).notNull().default("requested"),
    meetingUrl: text(),
    googleEventId: text(),
    notes: text(),
    /** The visitor's own time zone, shown with the agency's (09 §5). */
    visitorTimeZone: text(),
    feedbackRating: integer(),
    feedbackText: text(),
    feedbackRequestedAt: timestamp({ withTimezone: true }),
    reminderDaySentAt: timestamp({ withTimezone: true }),
    reminderHoursSentAt: timestamp({ withTimezone: true }),
    /** Hash of the reschedule / cancel link token (no login needed). */
    manageTokenHash: text(),
    source: text({ enum: ["site", "chat", "whatsapp", "admin"] })
      .notNull()
      .default("site"),
  },
  (t) => [
    index("viewings_agent_time_idx").on(t.agentId, t.startsAt),
    index("viewings_status_time_idx").on(t.agencyId, t.status, t.startsAt),
    index("viewings_property_idx").on(t.propertyId),
    index("viewings_lead_idx").on(t.leadId),
  ],
);

/** Days an agent is away or works other hours. */
export const agentAvailabilityOverrides = pgTable(
  "agent_availability_overrides",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    date: date().notNull(),
    blocked: boolean().notNull().default(true),
    /** When not blocked: that day's hours, e.g. [{ from: "10:00", to: "14:00" }]. */
    hours: jsonb().$type<Array<{ from: string; to: string }>>(),
    note: text(),
  },
  (t) => [uniqueIndex("agent_availability_unique").on(t.agentId, t.date)],
);

export const conversationChannels = ["web_chat", "whatsapp", "email"] as const;
export const conversationStatuses = ["ai", "needs_human", "human", "closed"] as const;

/** Inbox (05 §12, 09 §6). */
export const conversations = pgTable(
  "conversations",
  {
    ...baseColumns(),
    channel: text({ enum: conversationChannels }).notNull(),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    visitorId: uuid().references(() => visitors.id, { onDelete: "set null" }),
    leadId: uuid().references(() => leads.id, { onDelete: "set null" }),
    status: text({ enum: conversationStatuses }).notNull().default("ai"),
    assignedAdminId: uuid().references(() => users.id, { onDelete: "set null" }),
    /** WhatsApp number (wa_id) or the email thread id. */
    externalId: text(),
    subject: text(),
    lastMessageAt: timestamp({ withTimezone: true }),
    unreadCount: integer().notNull().default(0),
    aiSummary: text(),
    /** When the summary was written; a newer message means the conversation goes on. */
    aiSummaryAt: timestamp({ withTimezone: true }),
    /** WhatsApp 24-hour customer service window. */
    waWindowExpiresAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("conversations_status_idx").on(t.agencyId, t.status, t.lastMessageAt),
    index("conversations_external_idx").on(t.agencyId, t.channel, t.externalId),
    index("conversations_lead_idx").on(t.leadId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: text({ enum: ["in", "out"] }).notNull(),
    sender: text({ enum: ["customer", "ai", "admin", "system"] }).notNull(),
    senderAdminId: uuid(),
    body: text().notNull().default(""),
    attachments: jsonb()
      .$type<Array<{ mediaId?: string; url?: string; name: string; mime: string }>>()
      .notNull()
      .default([]),
    /** For AI messages: the tools it used, shown as small grey lines (09 §6). */
    toolCalls: jsonb().$type<Array<{ tool: string; summary: string }>>().notNull().default([]),
    /** Listings shown as cards under the message (web chat), loaded live when shown. */
    cards: jsonb().$type<string[]>().notNull().default([]),
    /** For assistant replies: the latest visitor message it answered (so none is skipped). */
    inReplyTo: uuid(),
    status: text({ enum: ["queued", "sent", "delivered", "read", "failed"] })
      .notNull()
      .default("sent"),
    externalId: text(),
    error: text(),
    /** An admin marked this assistant answer as bad (10 §2 "review and flag bad answers"). */
    flaggedAt: timestamp({ withTimezone: true }),
    flaggedBy: uuid(),
    flagNote: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_external_idx").on(t.externalId),
  ],
);

/** Replies the AI may not send on its own (human-only topics), waiting for an admin. */
export const approvalQueue = pgTable(
  "approval_queue",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    draftReply: text().notNull(),
    reason: text().notNull(),
    status: text({ enum: ["pending", "approved", "edited", "rejected"] })
      .notNull()
      .default("pending"),
    decidedBy: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("approval_queue_status_idx").on(t.agencyId, t.status, t.createdAt)],
);

/** Email and WhatsApp templates for notifications, auto-replies and reminders. */
export const messageTemplates = pgTable(
  "message_templates",
  {
    ...baseColumns(),
    channel: text({ enum: ["email", "whatsapp"] }).notNull(),
    /** e.g. lead.auto_reply, viewing.reminder_day, lead.assigned. */
    key: text().notNull(),
    name: text().notNull(),
    subject: text(),
    body: text().notNull(),
    /** For WhatsApp: the approved template's name and language at Meta. */
    waTemplateName: text(),
    waLanguage: text(),
    isActive: boolean().notNull().default(true),
  },
  (t) => [uniqueIndex("message_templates_key_unique").on(t.agencyId, t.channel, t.key)],
);

/** Newsletter (05 §13): a subscriber, not a lead unless Settings -> Leads says so (09 §1 #16). */
export const newsletterSubscribers = pgTable(
  "newsletter_subscribers",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    /** Lowercased. */
    email: text().notNull(),
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    /** e.g. footer, blog, page:<slug>. */
    source: text(),
    /** Hash of the double opt-in token sent by email. */
    confirmTokenHash: text(),
    confirmedAt: timestamp({ withTimezone: true }),
    unsubscribedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("newsletter_subscribers_email_unique").on(t.agencyId, t.email)],
);

/** Saved snippets for the inbox composer. */
export const quickReplies = pgTable("quick_replies", {
  ...baseColumns(),
  title: text().notNull(),
  body: text().notNull(),
  sortOrder: integer().notNull().default(0),
});

/** "Send properties": a personal shortlist link for a lead, with opens tracked (09 §4). */
export const shortlists = pgTable(
  "shortlists",
  {
    ...baseColumns(),
    leadId: uuid()
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    token: text().notNull(),
    title: text(),
    message: text(),
    propertyIds: uuid().array().notNull().default([]),
    sentAt: timestamp({ withTimezone: true }),
    openCount: integer().notNull().default(0),
    firstOpenedAt: timestamp({ withTimezone: true }),
    lastOpenedAt: timestamp({ withTimezone: true }),
    viewedPropertyIds: uuid().array().notNull().default([]),
  },
  (t) => [
    uniqueIndex("shortlists_token_unique").on(t.token),
    index("shortlists_lead_idx").on(t.leadId),
  ],
);

/**
 * An agent's connected calendar (13 §1 Google Calendar: OAuth per agent profile, connected
 * by an admin). Tokens are AES-256-GCM encrypted like integration keys.
 */
export const calendarConnections = pgTable(
  "calendar_connections",
  {
    ...baseColumns(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    provider: text({ enum: ["google"] })
      .notNull()
      .default("google"),
    /** The calendar viewings are written to and busy times read from ("primary" by default). */
    calendarId: text().notNull().default("primary"),
    accountEmail: text(),
    encryptedRefreshToken: text().notNull(),
    encryptedAccessToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }),
    scope: text(),
    /** Push notifications (watch channel), when Google accepts them. */
    watchChannelId: text(),
    watchResourceId: text(),
    watchExpiresAt: timestamp({ withTimezone: true }),
    lastSyncAt: timestamp({ withTimezone: true }),
    lastError: text(),
    lastErrorAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("calendar_connections_agent_unique").on(t.agentId, t.provider)],
);

/** Busy times read from a connected calendar (refreshed every 15 minutes or on push). */
export const calendarBusy = pgTable(
  "calendar_busy",
  {
    id: idColumn(),
    agencyId: agencyColumn(),
    agentId: uuid()
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("calendar_busy_agent_time_idx").on(t.agentId, t.startsAt)],
);
