import { z } from "zod";
import type { SettingGroup } from "@/db/schema/system";
import { httpUrl, phoneSchema, workingHoursSchema } from "@/lib/schemas";

/**
 * Every setting the admin controls (04-settings.md), one Zod schema per group.
 * - Every field has a default so a fresh install works before setup.
 * - Defaults are market-neutral: the seed presets (16-seed-and-demo.md) set real values.
 * - The same schemas validate admin input (strict) and stored values (lenient read, see `readGroup`).
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour like #A9502F");
const optionalText = z.string().trim().max(500).default("");
const id = z.uuid().nullable().default(null);
const lngLat = z.object({ lng: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const urlOrEmpty = z.union([httpUrl(), z.literal("")]).default("");

/** An IANA time zone this runtime knows (cron schedules and dates depend on it). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** z.object with the same schema for every key of a fixed key list (keeps key types precise). */
function objectOf<const K extends readonly string[], S extends z.ZodType>(keys: K, schema: S) {
  return z.object(Object.fromEntries(keys.map((k) => [k, schema])) as { [P in K[number]]: S });
}

/* 1. General ------------------------------------------------------------- */
export const generalSchema = z.object({
  agencyName: z.string().trim().min(1).max(120).default("Your Agency"),
  legalName: optionalText,
  shortDescription: z.string().trim().max(300).default(""),
  logoLightId: id,
  logoDarkId: id,
  faviconId: id,
  appIconId: id,
  licenceNumber: optionalText,
  defaultLanguage: z.enum(["en"]).default("en"),
  /** Disabled until a second language exists (01 §1.5). */
  rtl: z.boolean().default(false),
  timeZone: z
    .string()
    .min(1)
    .refine(isTimeZone, "Choose a time zone from the list (e.g. Europe/London)")
    .default("UTC"),
  dateFormat: z
    .enum(["d MMM yyyy", "dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"])
    .default("d MMM yyyy"),
  firstDayOfWeek: z.union([z.literal(0), z.literal(1), z.literal(6)]).default(1),
  maintenanceMode: z.boolean().default(false),
  /** Media library upload limit (07 §8). */
  maxUploadMb: z.number().int().min(1).max(100).default(20),
  /** Listing references look like PREFIX-1001 (05 §5). */
  referencePrefix: z
    .string()
    .trim()
    .regex(/^[A-Z]{1,5}$/, "Use 1 to 5 capital letters")
    .default("LT"),
  maintenanceMessage: z
    .string()
    .max(500)
    .default("We are updating our website. Please check back soon."),
  /**
   * Primary button in the site header (06 §2, e.g. "Book a viewing"). Hidden while
   * either part is empty.
   */
  headerButton: z
    .object({
      label: z.string().trim().max(40),
      href: z
        .string()
        .trim()
        .max(300)
        .refine(
          (v) => v === "" || (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\//.test(v),
          "Use a path like /contact or a full https:// address",
        ),
    })
    .default({ label: "", href: "" }),
});

/* 2. Branding (design tokens, 02-design-system.md §2) --------------------- */
export const desertModernColors = {
  bg: "#F7F3EE",
  surface: "#FFFFFF",
  surfaceSoft: "#FBF9F6",
  surfaceMuted: "#EDE5DA",
  ink: "#14232B",
  inkSoft: "#1C2F38",
  text: "#4A5560",
  textMuted: "#5B6670",
  border: "#E6DED3",
  accent: "#A9502F",
  accentSoft: "#F3E6DF",
  success: "#4F6B57",
  successSoft: "#E3EBE4",
  danger: "#B4402A",
  photoPlaceholder: "#DCD3C6",
} as const;
export type ColorToken = keyof typeof desertModernColors;

export const colorTokens = Object.keys(desertModernColors) as ColorToken[];
export const colorsSchema = z.object(
  Object.fromEntries(colorTokens.map((k) => [k, hex.default(desertModernColors[k])])) as {
    [K in ColorToken]: z.ZodDefault<typeof hex>;
  },
);

export const displayFonts = [
  "Fraunces",
  "Playfair Display",
  "Cormorant Garamond",
  "DM Serif Display",
  "Lora",
  "Libre Baskerville",
] as const;
export const bodyFonts = [
  "Manrope",
  "Inter",
  "DM Sans",
  "Plus Jakarta Sans",
  "Work Sans",
  "Nunito Sans",
] as const;

export const brandingSchema = z.object({
  colors: colorsSchema.default(colorsSchema.parse({})),
  fontDisplay: z.enum(displayFonts).default("Fraunces"),
  fontBody: z.enum(bodyFonts).default("Manrope"),
  cornerStyle: z.enum(["soft", "sharp"]).default("soft"),
});

/* 3. Market --------------------------------------------------------------- */
const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use the three-letter currency code (ISO 4217)");
export const currencySchema = z.object({
  code: currencyCode,
  symbol: z.string().min(1).max(5),
  symbolPosition: z.enum(["before", "after"]),
  decimals: z.number().int().min(0).max(3),
});

export const visitorCurrencySchema = currencySchema.extend({
  /** Units of this currency for 1 unit of the base currency. Display only. */
  rate: z.number().positive(),
  isExample: z.boolean().default(false),
});

/** 5,000 / 10,000 / 20,000 / 35,000 a month in the base currency (two decimals). */
const defaultIncomeBands = [500_000, 1_000_000, 2_000_000, 3_500_000];

export const marketSchema = z.object({
  baseCurrency: currencySchema.default({
    code: "USD",
    symbol: "$",
    symbolPosition: "before",
    decimals: 2,
  }),
  visitorCurrencies: z.array(visitorCurrencySchema).max(12).default([]),
  ratesUpdatedAt: z.iso.datetime().nullable().default(null),
  areaUnit: z.enum(["sqft", "sqm"]).default("sqm"),
  distanceUnit: z.enum(["km", "mi"]).default("km"),
  permit: z
    .object({
      enabled: z.boolean(),
      label: z.string().trim().min(1).max(40),
      requiredOnPublish: z.boolean(),
    })
    .default({ enabled: false, label: "Permit no.", requiredOnPublish: false }),
  rentPeriod: z.enum(["year", "month"]).default("month"),
  /** Allowed number of rent payments (cheques), e.g. [1, 2, 4, 6, 12]. */
  rentPaymentOptions: z.array(z.number().int().min(1).max(12)).max(12).default([]),
  monthlyPaymentAvailable: z.boolean().default(true),
  ownershipTypes: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .default(["Freehold", "Leasehold"]),
  furnishingOptions: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .default(["Unfurnished", "Semi-furnished", "Furnished"]),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  countryName: optionalText,
  phoneCountryCode: z
    .string()
    .regex(/^\+\d{1,4}$/)
    .nullable()
    .default(null),
  phoneFormat: optionalText,
  mapCenter: lngLat.default({ lng: 0, lat: 20 }),
  mapZoom: z.number().min(1).max(20).default(2),
  mortgage: z
    .object({
      downPaymentPct: z.number().min(0).max(100),
      interestRatePct: z.number().min(0).max(30),
      years: z.number().int().min(1).max(40),
      maxLtvPct: z.number().min(1).max(100),
      maxYears: z.number().int().min(1).max(40),
      registrationFeePct: z.number().min(0).max(20),
      agencyFeePct: z.number().min(0).max(20),
      arrangementFeePct: z.number().min(0).max(20),
      /**
       * Monthly income bands on the pre-approval form (11 §1): the limits between bands in
       * minor units of the base currency ([5000, 10000] gives "under 5,000", "5,000 to
       * 10,000" and "10,000 or more").
       */
      incomeBands: z
        .array(z.number().int().positive())
        .max(8)
        .transform((limits) => [...new Set(limits)].sort((a, b) => a - b))
        .default(defaultIncomeBands),
    })
    .default({
      downPaymentPct: 20,
      interestRatePct: 5,
      years: 25,
      maxLtvPct: 80,
      maxYears: 30,
      registrationFeePct: 0,
      agencyFeePct: 0,
      arrangementFeePct: 0,
      incomeBands: defaultIncomeBands,
    }),
  roi: z
    .object({
      /** Minor units of base currency per area unit per year. */
      serviceChargePerArea: z.number().int().min(0),
      managementFeePct: z.number().min(0).max(50),
      occupancyPct: z.number().min(0).max(100),
      purchaseCostsPct: z.number().min(0).max(20),
      maintenancePct: z.number().min(0).max(20),
      vacancyPct: z.number().min(0).max(100),
      rentGrowthPct: z.number().min(-20).max(30),
      priceGrowthPct: z.number().min(-20).max(30),
    })
    .default({
      serviceChargePerArea: 0,
      managementFeePct: 20,
      occupancyPct: 70,
      purchaseCostsPct: 4,
      maintenancePct: 1,
      vacancyPct: 5,
      rentGrowthPct: 2,
      priceGrowthPct: 3,
    }),
});

/* 4. Contact ---------------------------------------------------------------- */
export const socialKeys = ["instagram", "facebook", "linkedin", "youtube", "tiktok", "x"] as const;
export const contactSchema = z.object({
  phone: optionalText,
  whatsapp: z.union([phoneSchema, z.literal("")]).default(""),
  email: z.union([z.email(), z.literal("")]).default(""),
  address: optionalText,
  officePoint: lngLat.nullable().default(null),
  openingHours: z.string().max(500).default(""),
  socials: objectOf(socialKeys, urlOrEmpty).default({
    instagram: "",
    facebook: "",
    linkedin: "",
    youtube: "",
    tiktok: "",
    x: "",
  }),
  leadNotifyEmails: z.array(z.email()).max(10).default([]),
  leadNotifyWhatsapp: z.union([phoneSchema, z.literal("")]).default(""),
});

/* 5. Leads and CRM (stages live in the lead_stages table) --------------------- */
export const leadsSchema = z.object({
  leadTypes: z
    .array(z.string().trim().min(1).max(30))
    .default(["buyer", "tenant", "seller", "landlord", "investor"]),
  lostReasons: z
    .array(z.string().trim().min(1).max(60))
    .default([
      "Not responsive",
      "Bought elsewhere",
      "Budget too low",
      "Changed plans",
      "Duplicate",
      "Spam",
    ]),
  responseAlertMinutes: z.number().int().min(1).max(1440).default(10),
  responseAlertEmails: z.array(z.email()).max(10).default([]),
  assignmentRule: z
    .enum(["listing_agent", "area_match", "round_robin", "manual"])
    .default("listing_agent"),
  duplicateMatching: z.enum(["email", "phone", "both"]).default("both"),
  followUpAfterDays: z.number().int().min(0).max(90).default(3),
  portalInboxes: z
    .array(z.object({ portal: z.string().trim().min(1).max(40), address: z.email() }))
    .max(10)
    .default([]),
  /** 09 §1 #14: a signup becomes a lead only after an action that shows intent. */
  signupCreatesLead: z.enum(["never", "on_intent", "always"]).default("on_intent"),
  newsletterCreatesLead: z.boolean().default(false),
  autoReply: z
    .object({ enabled: z.boolean(), countsAsFirstResponse: z.boolean() })
    .default({ enabled: true, countsAsFirstResponse: false }),
  brochureEmailGate: z.boolean().default(false),
});

/* 6. Viewings ------------------------------------------------------------- */
export const viewingsSchema = z.object({
  defaultLengthMin: z.number().int().min(10).max(240).default(30),
  bufferMin: z.number().int().min(0).max(120).default(15),
  bookingWindowDays: z.number().int().min(1).max(180).default(30),
  minNoticeHours: z.number().int().min(0).max(168).default(4),
  workingHours: workingHoursSchema.default({
    mon: [["09:00", "18:00"]],
    tue: [["09:00", "18:00"]],
    wed: [["09:00", "18:00"]],
    thu: [["09:00", "18:00"]],
    fri: [["09:00", "18:00"]],
    sat: [["10:00", "16:00"]],
    sun: [],
  }),
  holidays: z.array(z.iso.date()).max(60).default([]),
  videoTool: z.enum(["google_meet", "zoom", "whatsapp"]).default("whatsapp"),
  zoomLink: urlOrEmpty,
  reminders: z
    .object({
      customerHoursBefore: z.array(z.number().int().min(1).max(168)).max(3),
      customerEmail: z.boolean(),
      customerWhatsapp: z.boolean(),
      agentHoursBefore: z.number().int().min(0).max(48),
    })
    .default({
      customerHoursBefore: [24, 2],
      customerEmail: true,
      customerWhatsapp: true,
      agentHoursBefore: 2,
    }),
});

/* 7. SEO ------------------------------------------------------------------ */
export const seoSchema = z.object({
  titlePattern: z.string().min(1).max(120).default("%page% | %agency%"),
  defaultMetaDescription: z.string().max(300).default(""),
  defaultOgImageId: id,
  listingTitlePattern: z.string().max(160).default("%beds% bed %type% for %purpose% in %area%"),
  projectTitlePattern: z.string().max(160).default("%project% by %developer% in %area%"),
  areaTitlePattern: z.string().max(160).default("Living in %area%: area guide"),
  postTitlePattern: z.string().max(160).default("%title%"),
  googleVerification: optionalText,
  bingVerification: optionalText,
  allowIndexing: z.boolean().default(true),
  organisation: z
    .object({
      name: z.string().max(120),
      logoId: z.uuid().nullable(),
      phone: z.string().max(40),
      address: z.string().max(300),
      sameAs: z.array(httpUrl()).max(10),
    })
    .default({ name: "", logoId: null, phone: "", address: "", sameAs: [] }),
  /** Sold/rented listings drop out of search and sitemap after this many days (06 §5). */
  soldListingDropDays: z.number().int().min(0).max(3650).default(90),
  /** Location x type landing pages are generated only with at least this many listings (08 §6). */
  landingTypeMinListings: z.number().int().min(1).max(100).default(5),
  /** Landing pages with fewer listings get noindex. */
  thinPageMinListings: z.number().int().min(0).max(100).default(3),
});

/* 8. Integrations (non-secret parts; keys live encrypted in `secrets`) ------- */
export const secretKeys = [
  "google_maps_server_key",
  "whatsapp_access_token",
  "whatsapp_app_secret",
  "whatsapp_verify_token",
  "resend_webhook_secret",
  "google_oauth_client_secret",
  "ai_api_key",
  "ai_fallback_api_key",
  "ai_gateway_token",
  "social_meta_secret",
  "social_tiktok_secret",
  "social_google_secret",
  "portal_webhook_secret",
  "social_meta_app_secret",
  "social_meta_page_token",
] as const;
export type SecretKey = (typeof secretKeys)[number];

const fieldNames = z.string().trim().max(200);
const socialFieldMap = z.object({
  name: fieldNames,
  email: fieldNames,
  phone: fieldNames,
  budget: fieldNames,
  message: fieldNames,
});

export const integrationsSchema = z.object({
  googleMaps: z
    .object({
      enabled: z.boolean(),
      /** Client-side map tile key (MapTiler or similar). Public by nature. */
      tileKey: z.string().max(200),
      tileStyleUrl: z.union([httpUrl(), z.literal("")]),
      importPlaces: z.boolean(),
      /** The distances job may add places Google finds near a listing (07 §4.2). */
      addNearbyPlaces: z.boolean().default(true),
    })
    .default({
      enabled: false,
      tileKey: "",
      tileStyleUrl: "",
      importPlaces: true,
      addNearbyPlaces: true,
    }),
  whatsapp: z
    .object({
      enabled: z.boolean(),
      phoneNumberId: z.string().max(60),
      businessAccountId: z.string().max(60),
      displayNumber: z.string().max(40),
      templates: z.record(
        z.string(),
        z.object({
          name: z.string().max(100),
          language: z.string().max(10),
          variables: z.array(z.string()).max(10),
        }),
      ),
      voiceNotes: z.boolean(),
    })
    .default({
      enabled: false,
      phoneNumberId: "",
      businessAccountId: "",
      displayNumber: "",
      templates: {},
      voiceNotes: false,
    }),
  /** Outgoing email: the mail server is in the environment (SMTP_*), these are the extras. */
  email: z
    .object({
      fromName: z.string().max(80),
      replyTo: z.union([z.email(), z.literal("")]),
    })
    .default({ fromName: "", replyTo: "" }),
  /** Replies by email back into the CRM, through Resend's inbound webhook (optional). */
  resend: z.object({ inboundDomain: z.string().max(120) }).default({ inboundDomain: "" }),
  googleCalendar: z
    .object({ enabled: z.boolean(), clientId: z.string().max(200) })
    .default({ enabled: false, clientId: "" }),
  analytics: z
    .object({
      ga4Id: z.string().regex(/^$|^G-[A-Z0-9]{4,20}$/, "Looks like G-XXXXXXXXXX"),
      gtmId: z.string().regex(/^$|^GTM-[A-Z0-9]{4,12}$/, "Looks like GTM-XXXXXXX"),
      metaPixelId: z.string().regex(/^$|^\d{5,20}$/, "Digits only"),
      tiktokPixelId: z
        .string()
        .regex(/^$|^[A-Z0-9]{10,30}$/, "Letters and digits, e.g. C1A2B3C4D5E6"),
    })
    .default({ ga4Id: "", gtmId: "", metaPixelId: "", tiktokPixelId: "" }),
  portals: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_-]{2,30}$/),
        name: z.string().min(1).max(40),
        enabled: z.boolean(),
        mode: z.enum(["email", "csv", "api"]),
      }),
    )
    .max(10)
    .default([]),
  socialForms: z
    .object({ meta: z.boolean(), tiktok: z.boolean(), google: z.boolean() })
    .default({ meta: false, tiktok: false, google: false }),
  /**
   * Which lead form field holds each detail (09 §1 #18), per source; several names may be
   * given, comma separated, and the first one the form has is used.
   */
  socialFieldMaps: z
    .object({ meta: socialFieldMap, tiktok: socialFieldMap, google: socialFieldMap })
    .default({
      meta: {
        name: "full_name, first_name",
        email: "email",
        phone: "phone_number, phone",
        budget: "budget",
        message: "message, comments",
      },
      tiktok: {
        name: "name, full_name",
        email: "email",
        phone: "phone_number, phone",
        budget: "budget",
        message: "message",
      },
      google: {
        name: "FULL_NAME, FIRST_NAME",
        email: "EMAIL",
        phone: "PHONE_NUMBER",
        budget: "budget",
        message: "message",
      },
    }),
  ai: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(["xai", "groq", "gemini", "anthropic", "mock"]),
      chatModel: z.string().max(80),
      fastModel: z.string().max(80),
      /**
       * A second provider asked when the first fails (down, overloaded, out of credit), with
       * its own key (`ai_fallback_api_key`) and models for the same two tiers.
       */
      fallbackProvider: z.enum(["none", "xai", "groq", "gemini", "anthropic"]).default("none"),
      fallbackChatModel: z.string().trim().max(80).default(""),
      fallbackFastModel: z.string().trim().max(80).default(""),
      gatewayAccountId: z.string().max(80),
      gatewayName: z.string().max(80),
      /**
       * Vectors for the assistants' search (10 §1): Cloudflare Workers AI (the `AI` binding,
       * through the gateway when one is set) or the built-in test embeddings.
       */
      embeddingProvider: z.enum(["mock", "workers_ai"]).default("mock"),
      embeddingModel: z.string().trim().max(80).default("@cf/baai/bge-m3"),
    })
    .default({
      enabled: false,
      provider: "mock",
      chatModel: "claude-sonnet-5-5",
      fastModel: "claude-haiku-5-5",
      fallbackProvider: "none",
      fallbackChatModel: "",
      fallbackFastModel: "",
      gatewayAccountId: "",
      gatewayName: "",
      embeddingProvider: "mock",
      embeddingModel: "@cf/baai/bge-m3",
    }),
});

/* 9. AI -------------------------------------------------------------------- */
export const adminAiActions = [
  "create_listing_draft",
  "update_listing",
  "write_listing_copy",
  "draft_blog_post",
  "send_lead_reply",
  "manage_viewing",
  "create_task",
  "update_lead",
  "create_utm_link",
  "send_listings_to_lead",
] as const;

export const aiSchema = z.object({
  assistantName: z.string().trim().min(1).max(40).default("Assistant"),
  greeting: z
    .string()
    .max(300)
    .default("Hi! I can help you find a home, answer questions and book a viewing."),
  tone: z.enum(["friendly", "formal", "short"]).default("friendly"),
  requiredBeforeBooking: z
    .object({ name: z.boolean(), phone: z.boolean(), email: z.boolean() })
    .default({ name: true, phone: true, email: false }),
  humanTopics: z
    .array(z.string().trim().min(1).max(80))
    .max(30)
    .default(["price negotiation", "legal questions", "tax advice", "complaints"]),
  showHumanButton: z.enum(["always", "after_3"]).default("always"),
  outsideHoursMessage: z
    .string()
    .max(300)
    .default(
      "Our team is offline right now. I can still help, and an agent will reply when the office opens.",
    ),
  firstReplyEnabled: z.boolean().default(true),
  /**
   * The chat button on the website (09 §1 #3). Until the assistant arrives (Phase 9) the team
   * answers from the inbox. Off by default.
   */
  webChat: z
    .object({ enabled: z.boolean(), askContactFirst: z.boolean() })
    .default({ enabled: false, askContactFirst: true }),
  adminAssistantEnabled: z.boolean().default(true),
  allowedActions: objectOf(adminAiActions, z.boolean()).default(
    Object.fromEntries(adminAiActions.map((a) => [a, true])) as Record<
      (typeof adminAiActions)[number],
      boolean
    >,
  ),
  /** Monthly spend limit in USD cents; 0 = no limit. */
  monthlySpendLimitCents: z.number().int().min(0).default(5000),
  /** Daily budget in USD cents; 0 = no daily budget (the monthly limit still applies). */
  dailySpendLimitCents: z.number().int().min(0).default(500),
  spendAlertPct: z.number().int().min(1).max(100).default(80),
  /**
   * One switch per AI feature (the admin assistant uses `adminAssistantEnabled`). A feature
   * that is off, or over budget, falls back to its plain version: the team answers chats,
   * leads are scored by the rules, writing helpers are hidden.
   */
  features: z
    .object({
      customerChat: z.boolean().default(true),
      whatsapp: z.boolean().default(true),
      writingHelpers: z.boolean().default(true),
      leadScoring: z.boolean().default(true),
      mcp: z.boolean().default(true),
    })
    .default({
      customerChat: true,
      whatsapp: true,
      writingHelpers: true,
      leadScoring: true,
      mcp: true,
    }),
  /** The agency's own rules for the website assistant, added to its instructions. */
  assistantRules: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
});

/* 10. Notifications ---------------------------------------------------------- */
export const notificationEvents = [
  "newLead",
  "leadNotAnswered",
  "newViewing",
  "viewingCancelled",
  "dailySummary",
  "weeklyReport",
  "integrationError",
] as const;
export type NotificationEvent = (typeof notificationEvents)[number];

const channelToggle = z.object({ email: z.boolean(), whatsapp: z.boolean() });
function channelDefaults(email: boolean, whatsapp: boolean) {
  return Object.fromEntries(notificationEvents.map((e) => [e, { email, whatsapp }])) as Record<
    NotificationEvent,
    { email: boolean; whatsapp: boolean }
  >;
}
export const notificationsSchema = z.object({
  admins: objectOf(notificationEvents, channelToggle).default(channelDefaults(true, false)),
  agents: objectOf(notificationEvents, channelToggle).default(channelDefaults(true, true)),
  dailySummaryTime: hhmm.default("08:00"),
  /**
   * The weekly report email (09 §7, 13 §2 "Weekly (Mon): weekly report email"): the overview
   * of the 7 days before, on `weekday` (0 = Sunday) at `hour` agency time. No recipients means
   * every active admin.
   */
  weeklyReport: z
    .object({
      enabled: z.boolean(),
      weekday: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      recipients: z.array(z.email()).max(20),
    })
    .default({ enabled: false, weekday: 1, hour: 8, recipients: [] }),
});

/* 11. Legal and privacy ------------------------------------------------------ */
export const legalSchema = z.object({
  privacyPageId: id,
  termsPageId: id,
  cookiePageId: id,
  howWeVerifyPageId: id,
  cookieBanner: z
    .object({
      text: z.string().max(600),
      analyticsLabel: z.string().max(80),
      marketingLabel: z.string().max(80),
    })
    .default({
      text: "We use cookies to run this site and, with your permission, to measure visits and show relevant ads.",
      analyticsLabel: "Analytics",
      marketingLabel: "Marketing",
    }),
  retention: z
    .object({
      guestChatMonths: z.number().int().min(1).max(120),
      anonymiseLostLeadsMonths: z.number().int().min(1).max(120),
    })
    .default({ guestChatMonths: 12, anonymiseLostLeadsMonths: 24 }),
});

/* 12. Admin users and security ---------------------------------------------- */
export const securitySchema = z.object({
  require2fa: z.boolean().default(true),
  adminSessionHours: z.number().int().min(1).max(72).default(12),
  customerSessionDays: z.number().int().min(1).max(90).default(30),
  googleSignIn: z.boolean().default(false),
  allowCustomHtmlScripts: z.boolean().default(false),
  /** Re-login required for sensitive admin actions after this many minutes (03 rules §6). */
  reauthMinutes: z.number().int().min(1).max(240).default(15),
});

/* 13. Website: footer text and the announcement bar (08 §2) ---------------- */
const siteLink = z
  .string()
  .trim()
  .max(300)
  .refine(
    (v) => v === "" || (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\/\S+$/.test(v),
    "Use a path like /off-plan or a full https:// address",
  );

export const footerSchema = z.strictObject({
  /** Under the logo; empty uses the agency's short description (General). */
  text: z.string().trim().max(300, "Use at most 300 characters").default(""),
  /** An extra line next to the copyright, e.g. who regulates the agency. */
  legalText: z.string().trim().max(300, "Use at most 300 characters").default(""),
  /** A newsletter signup in the footer (double opt-in, 05 §13). */
  newsletter: z.boolean().default(false),
});

/** Optional bar above the header with text, a link and a date range. */
export const announcementSchema = z
  .strictObject({
    enabled: z.boolean(),
    text: z.string().trim().max(160, "Keep it to 160 characters"),
    linkLabel: z.string().trim().max(40, "Use at most 40 characters"),
    href: siteLink,
    /** Shown from / until (instants; the editor uses the agency time zone). */
    startsAt: z.iso.datetime({ offset: true }).nullable(),
    endsAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .superRefine((a, ctx) => {
    if (a.enabled && !a.text)
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Write the announcement, or switch the bar off",
      });
    if (Boolean(a.linkLabel) !== Boolean(a.href))
      ctx.addIssue({
        code: "custom",
        path: [a.linkLabel ? "href" : "linkLabel"],
        message: "A link needs both a label and an address",
      });
    if (a.startsAt && a.endsAt && Date.parse(a.endsAt) <= Date.parse(a.startsAt))
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end must be after the start",
      });
  });

export const websiteSchema = z.object({
  footer: footerSchema.default({ text: "", legalText: "", newsletter: false }),
  announcement: announcementSchema.default({
    enabled: false,
    text: "",
    linkLabel: "",
    href: "",
    startsAt: null,
    endsAt: null,
  }),
});

/* Demo (16 §2-3): not an admin tab; the seed and "Switch demo market" write it. ---------- */
const demoPreset = z.enum(["haven-dune", "us-demo"]).nullable();
export const demoSchema = z.object({
  /** The preset the last seed loaded. */
  preset: demoPreset.default(null),
  /** "Switch demo market" on Cloudflare: the next reset (tonight) loads this one. */
  requestedPreset: demoPreset.default(null),
  requestedAt: z.iso.datetime().nullable().default(null),
  lastResetAt: z.iso.datetime().nullable().default(null),
});

export const settingsSchemas = {
  general: generalSchema,
  branding: brandingSchema,
  market: marketSchema,
  contact: contactSchema,
  leads: leadsSchema,
  viewings: viewingsSchema,
  seo: seoSchema,
  integrations: integrationsSchema,
  ai: aiSchema,
  notifications: notificationsSchema,
  legal: legalSchema,
  security: securitySchema,
  website: websiteSchema,
  demo: demoSchema,
} satisfies Record<SettingGroup, z.ZodObject>;

export type SettingsSchemas = typeof settingsSchemas;
export type SettingsOf<G extends SettingGroup> = z.output<SettingsSchemas[G]>;
export type AllSettings = { [G in SettingGroup]: SettingsOf<G> };

export type GeneralSettings = SettingsOf<"general">;
export type BrandingSettings = SettingsOf<"branding">;
export type MarketSettings = SettingsOf<"market">;
export type ContactSettings = SettingsOf<"contact">;
export type SeoSettings = SettingsOf<"seo">;
export type SecuritySettings = SettingsOf<"security">;
export type WebsiteSettings = SettingsOf<"website">;
export type FooterSettings = WebsiteSettings["footer"];
export type AnnouncementSettings = WebsiteSettings["announcement"];

export function defaultsFor<G extends SettingGroup>(group: G): SettingsOf<G> {
  return settingsSchemas[group].parse({}) as SettingsOf<G>;
}

/**
 * Lenient read of a stored value: a field that no longer validates (schema changed, bad
 * manual edit) falls back to its default instead of breaking the whole site.
 * Returns the parsed value plus the names of fields that fell back.
 */
export function readGroup<G extends SettingGroup>(
  group: G,
  raw: unknown,
): { value: SettingsOf<G>; invalidKeys: string[] } {
  const schema = settingsSchemas[group];
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const full = schema.safeParse(input);
  if (full.success) return { value: full.data as SettingsOf<G>, invalidKeys: [] };

  const value = defaultsFor(group) as Record<string, unknown>;
  const invalidKeys: string[] = [];
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    if (!(key in input)) continue;
    const res = (fieldSchema as z.ZodType).safeParse(input[key]);
    if (res.success) value[key] = res.data;
    else invalidKeys.push(key);
  }
  return { value: value as SettingsOf<G>, invalidKeys };
}

/** Strict validation of admin input for one group (unknown keys rejected, 14 §2). */
export function parseGroupInput<G extends SettingGroup>(group: G, input: unknown) {
  return settingsSchemas[group].strict().safeParse(input);
}
