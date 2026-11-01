import { z } from "zod";
import { pageTemplates, type pageStatuses } from "@/db/schema/cms";
import { isValidSlug } from "@/lib/slug";

/** Page builder inputs (08 §1): new page, page settings, draft, publish and schedule. */

export type PageStatus = (typeof pageStatuses)[number];
export type PageTemplate = (typeof pageTemplates)[number];

export const pageStatusLabels: Record<PageStatus, string> = {
  draft: "Draft",
  published: "Published",
  scheduled: "Scheduled",
};

export const pageTemplateLabels: Record<PageTemplate, string> = {
  default: "Default",
  landing: "Landing",
  legal: "Legal",
};

export const pageTemplateHelp: Record<PageTemplate, string> = {
  default: "Header, the sections and the footer.",
  landing: "For ad campaigns: logo and phone only at the top, no menus at the bottom.",
  legal: "A narrow text column with a table of contents, for policies and terms.",
};

/** Keep the last 20 published versions of a page (05 §8 page_revisions). */
export const REVISIONS_KEPT = 20;

/** Shareable preview links work for 7 days (08 §1). */
export const PREVIEW_LINK_DAYS = 7;

/** Sections a page can hold, and the size of a draft, so one page can't grow without end. */
export const MAX_SECTIONS = 60;
export const MAX_DRAFT_BYTES = 400_000;

/**
 * Addresses the site already uses (06 §1, and routes later phases add): a page with one of
 * these slugs could never be reached, so the slug is refused.
 */
export const reservedSlugs: ReadonlySet<string> = new Set([
  "account",
  "admin",
  "agents",
  "api",
  "areas",
  "buy",
  "compare",
  "developers",
  "forgot-password",
  "insights",
  "list-your-property",
  "media",
  "off-plan",
  "og",
  "preview",
  "projects",
  "property",
  "rent",
  "reset-password",
  "search",
  "sign-in",
  "sign-up",
  "sitemap",
  "tools",
  "valuation",
]);

export const pageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Enter the address")
  .max(80, "Use at most 80 characters")
  .refine(isValidSlug, "Use lowercase letters, numbers and single hyphens")
  .refine((s) => !reservedSlugs.has(s), "The site already uses this address. Choose another.");

/** What a new page starts with (the editor adds and removes sections from there). */
export const pageStarters = ["standard", "blank", "landing", "legal"] as const;
export type PageStarter = (typeof pageStarters)[number];

export const pageStarterLabels: Record<PageStarter, { label: string; help: string }> = {
  standard: { label: "Standard page", help: "A heading, a text block and a call to action." },
  blank: { label: "Blank", help: "No sections: add them yourself." },
  landing: {
    label: "Campaign landing page",
    help: "A heading, the selling points, a form and testimonials, without menus.",
  },
  legal: { label: "Policy or terms", help: "One long text with a table of contents." },
};

export const newPageSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a title").max(120, "Use at most 120 characters"),
    starter: z.enum(pageStarters).default("standard"),
  })
  .strict();

/** Canonical: empty (the page itself), a path on this site or a full https link. */
const canonicalUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => v.startsWith("/") || /^https?:\/\/[^\s"'<>]+$/i.test(v),
    "Use a path like /about or a full link starting with https://",
  )
  .nullable();

export const pageSettingsSchema = z
  .object({
    title: z.string().trim().min(1, "Enter a title").max(120, "Use at most 120 characters"),
    slug: pageSlugSchema,
    template: z.enum(pageTemplates),
    seoTitle: z.string().trim().max(120, "Use at most 120 characters").nullable(),
    seoDescription: z.string().trim().max(300, "Use at most 300 characters").nullable(),
    ogImageId: z.uuid().nullable(),
    canonicalUrl,
    noindex: z.boolean(),
    hideChat: z.boolean().default(false),
  })
  .strict();

export type PageSettingsInput = z.input<typeof pageSettingsSchema>;
export type PageSettings = z.output<typeof pageSettingsSchema>;

const version = z.iso.datetime({ offset: true });

export const pageRefSchema = z.object({ id: z.uuid() }).strict();
export const pageVersionedSchema = z.object({ id: z.uuid(), expectedUpdatedAt: version }).strict();

export const saveSettingsSchema = z
  .object({ id: z.uuid(), expectedUpdatedAt: version, data: pageSettingsSchema })
  .strict();

/** Each section is checked by the handler: unfinished ones are kept and reported, not refused. */
export const saveDraftSchema = z
  .object({
    id: z.uuid(),
    expectedUpdatedAt: version,
    sections: z.array(z.unknown()).max(MAX_SECTIONS, `A page can hold ${MAX_SECTIONS} sections`),
  })
  .strict();

export const scheduleSchema = z
  .object({
    id: z.uuid(),
    expectedUpdatedAt: version,
    /** Null cancels the schedule. */
    publishAt: version.nullable(),
  })
  .strict();

export const restoreRevisionSchema = z
  .object({ pageId: z.uuid(), revisionId: z.uuid(), expectedUpdatedAt: version })
  .strict();

/** What a revision remembers next to the sections (title and SEO when it was published). */
export type RevisionSeo = {
  title: string;
  slug: string;
  template: PageTemplate;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
};

/** A listing in the "pick listings" field of the featured listings section. */
export type ListingOption = { id: string; label: string; detail: string };
