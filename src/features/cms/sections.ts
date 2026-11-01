import { z } from "zod";
import { faqGroups } from "@/db/schema/content";
import { richDocSchema } from "@/lib/rich-text";
import { isPlayableVideoUrl } from "@/lib/video";

/**
 * Page sections (08 §1): each stored as `{ id, type, props, style, hidden }` in `pages.sections`.
 * Invalid or unknown sections are skipped on the site, never fatal. The page builder saves a
 * draft even when a section is not finished yet; publishing checks every section strictly.
 */

const text = (max: number) => z.string().trim().max(max).default("");
const id = z.uuid();

/**
 * Internal paths ("/buy?beds=2"), anchors on the page ("#pricing"), full http(s) links, and
 * mailto:/tel: for "write to us" and "call us" buttons. Never javascript: or data: links.
 */
const href = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) =>
      v === "" ||
      v.startsWith("/") ||
      /^#[a-z0-9-]+$/.test(v) ||
      /^https?:\/\//.test(v) ||
      /^(mailto|tel):[^\s"'<>]+$/i.test(v),
    "Use a path like /buy, an anchor like #pricing or a full link",
  );

const button = z.object({ label: text(40), href }).strict();

const lngLat = z
  .object({ lng: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) })
  .strict();

/** Forms the "Form" section can show (08 §1). Phase 6 turns every submit into a lead. */
export const pageFormTypes = [
  "contact",
  "callback",
  "valuation",
  "list_property",
  "newsletter",
] as const;
export type PageFormType = (typeof pageFormTypes)[number];

/** The tools a "Tools" section can show (06 §3 item 7, 11). */
export const siteTools = [
  "mortgage",
  "rental_returns",
  "compare",
  "valuation",
  "list_property",
] as const;
export type SiteTool = (typeof siteTools)[number];
const defaultTools: SiteTool[] = ["mortgage", "rental_returns", "compare", "valuation"];

export const sectionStyleSchema = z
  .object({
    background: z.enum(["sand", "white", "soft", "ink", "image"]).default("white"),
    backgroundImageId: id.nullable().default(null),
    spacing: z.enum(["compact", "normal", "large"]).default("normal"),
    width: z.enum(["contained", "full"]).default("contained"),
    anchor: z
      .string()
      .regex(/^[a-z0-9-]*$/, "Lowercase letters, numbers and hyphens")
      .max(40)
      .default(""),
    hideOn: z.enum(["none", "phone", "desktop"]).default("none"),
  })
  .strict();

export type SectionStyle = z.infer<typeof sectionStyleSchema>;

const galleryImage = z.object({ mediaId: id, caption: text(200), alt: text(200) }).strict();

const propsByType = {
  hero_search: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      subheading: text(240),
      tabs: z
        .array(z.enum(["buy", "rent", "off_plan"]))
        .min(1)
        .max(3)
        .default(["buy", "rent", "off_plan"]),
      defaultTab: z.enum(["buy", "rent", "off_plan"]).default("buy"),
      imageId: id.nullable().default(null),
      floatingBadge: z.boolean().default(true),
      floatingBadgeText: text(60),
    })
    .strict(),
  hero_simple: z
    .object({
      heading: text(120),
      subheading: text(240),
      imageId: id.nullable().default(null),
      buttons: z.array(button).max(2).default([]),
    })
    .strict(),
  promise_strip: z
    .object({
      items: z
        .array(z.object({ title: text(60), text: text(200), icon: text(40) }).strict())
        .min(2)
        .max(4),
    })
    .strict(),
  featured_listings: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["featured", "newest", "manual", "filter"]).default("featured"),
      listingIds: z.array(id).max(12).default([]),
      /** For "filter": a search query string, e.g. "type=villas&max=5000000". */
      filter: z.string().max(500).default(""),
      count: z.number().int().min(3).max(12).default(6),
      layout: z.enum(["grid", "carousel"]).default("grid"),
      viewAll: button.nullable().default(null),
    })
    .strict(),
  projects_showcase: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["featured", "manual", "area"]).default("featured"),
      projectIds: z.array(id).max(8).default([]),
      locationId: id.nullable().default(null),
      count: z.number().int().min(1).max(8).default(4),
      dark: z.boolean().default(true),
      viewAll: button.nullable().default(null),
    })
    .strict(),
  areas_grid: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["featured", "manual"]).default("featured"),
      locationIds: z.array(id).max(12).default([]),
      count: z.number().int().min(2).max(12).default(4),
    })
    .strict(),
  search_embed: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      /** A search link, e.g. "/buy/marina/villas?max=5000000" (08 §1 "saved filter set"). */
      search: z.string().trim().max(500).default("/buy"),
      count: z.number().int().min(3).max(12).default(6),
      layout: z.enum(["grid", "carousel"]).default("grid"),
      viewAllLabel: text(40),
      showViewAll: z.boolean().default(true),
    })
    .strict(),
  text: z
    .object({ body: richDocSchema, maxWidth: z.enum(["narrow", "normal"]).default("narrow") })
    .strict(),
  text_image: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      body: richDocSchema,
      imageId: id.nullable().default(null),
      imageSide: z.enum(["left", "right"]).default("right"),
      imageShape: z.enum(["portrait", "square", "landscape"]).default("portrait"),
      buttons: z.array(button).max(2).default([]),
    })
    .strict(),
  stats: z
    .object({
      heading: text(120),
      // Admin-entered only, each with where the number comes from (08 §1).
      items: z
        .array(z.object({ value: text(20), label: text(60), source: text(120) }).strict())
        .min(1)
        .max(6),
    })
    .strict(),
  testimonials: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["latest", "manual"]).default("latest"),
      testimonialIds: z.array(id).max(12).default([]),
      count: z.number().int().min(1).max(12).default(3),
      layout: z.enum(["grid", "carousel", "quote"]).default("grid"),
    })
    .strict(),
  faq: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["group", "manual"]).default("group"),
      group: z.enum(faqGroups).default("general"),
      faqIds: z.array(id).max(30).default([]),
      count: z.number().int().min(1).max(30).default(8),
      /** FAQPage structured data (08 §6); only the first FAQ section of a page outputs it. */
      schema: z.boolean().default(true),
    })
    .strict(),
  team: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["all", "manual"]).default("all"),
      agentIds: z.array(id).max(24).default([]),
      count: z.number().int().min(1).max(24).default(8),
      viewAll: button.nullable().default(null),
    })
    .strict(),
  developer_logos: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["all", "manual"]).default("all"),
      developerIds: z.array(id).max(24).default([]),
      count: z.number().int().min(1).max(24).default(8),
    })
    .strict(),
  blog_posts: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      source: z.enum(["latest", "category"]).default("latest"),
      categoryId: id.nullable().default(null),
      count: z.number().int().min(1).max(12).default(3),
      viewAll: button.nullable().default(null),
    })
    .strict(),
  cta: z
    .object({ heading: text(120), text: text(300), buttons: z.array(button).max(2).default([]) })
    .strict(),
  tools: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      tools: z
        .array(z.enum(siteTools))
        .min(1)
        .max(siteTools.length)
        .default([...defaultTools]),
    })
    .strict(),
  ai_teaser: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      text: text(300),
      /** Chips that open the chat with this question already typed (06 §3 item 6). */
      prompts: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
    })
    .strict(),
  contact_block: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      text: text(400),
      showDetails: z.boolean().default(true),
      showMap: z.boolean().default(true),
      showForm: z.boolean().default(true),
      formHeading: text(120),
    })
    .strict(),
  form: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      text: text(400),
      formType: z.enum(pageFormTypes).default("contact"),
      buttonLabel: text(40),
      /** What the visitor reads after sending ("We'll call you back within the hour"). */
      successMessage: text(300),
    })
    .strict(),
  video: z
    .object({
      heading: text(120),
      url: z
        .string()
        .trim()
        .max(500)
        .refine(
          (v) => v === "" || isPlayableVideoUrl(v),
          "Use a YouTube or Vimeo link, or an https link to a video file",
        )
        .default(""),
      posterId: id.nullable().default(null),
      caption: text(200),
      aspect: z.enum(["16:9", "4:3", "1:1", "9:16"]).default("16:9"),
    })
    .strict(),
  gallery: z
    .object({
      eyebrow: text(60),
      heading: text(120),
      images: z.array(galleryImage).max(40).default([]),
      layout: z.enum(["grid", "masonry", "carousel"]).default("grid"),
      columns: z.number().int().min(2).max(4).default(3),
    })
    .strict(),
  map: z
    .object({
      heading: text(120),
      /** Empty: the market's map centre (Settings -> Market). */
      center: lngLat.nullable().default(null),
      zoom: z.number().min(2).max(18).default(12),
      showListings: z.boolean().default(true),
      showPois: z.boolean().default(false),
      showOffice: z.boolean().default(true),
      height: z.enum(["small", "medium", "large"]).default("medium"),
    })
    .strict(),
  divider: z
    .object({
      size: z.enum(["small", "medium", "large"]).default("medium"),
      line: z.boolean().default(true),
    })
    .strict(),
  custom_html: z
    .object({
      /** Cleaned when shown: no scripts unless Settings -> Security allows them (08 §1). */
      html: z.string().max(20_000).default(""),
      /** A note for the section list ("Calendly booking widget"); never shown on the site. */
      label: text(80),
    })
    .strict(),
} as const;

export type SectionType = keyof typeof propsByType;
export const sectionTypes = Object.keys(propsByType) as SectionType[];

export function isSectionType(v: unknown): v is SectionType {
  return typeof v === "string" && Object.hasOwn(propsByType, v);
}

/** The props schema of one section type (the editor checks fields against it). */
export function sectionPropsSchema<T extends SectionType>(type: T): (typeof propsByType)[T] {
  return propsByType[type];
}

export type SectionPropsOf<T extends SectionType> = z.infer<(typeof propsByType)[T]>;

export type Section = {
  [T in SectionType]: {
    id: string;
    type: T;
    props: z.infer<(typeof propsByType)[T]>;
    style: SectionStyle;
    /** Hidden from the page without deleting it ("hide" in the section list). */
    hidden?: boolean;
  };
}[SectionType];

/** One stored section, or null when it is unknown or invalid (the site skips it). */
export function parseSection(raw: unknown): Section | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as {
    id?: unknown;
    type?: unknown;
    props?: unknown;
    style?: unknown;
    hidden?: unknown;
  };
  if (typeof s.id !== "string" || !isSectionType(s.type)) return null;
  const props = propsByType[s.type].safeParse(s.props ?? {});
  const style = sectionStyleSchema.safeParse(s.style ?? {});
  if (!props.success || !style.success) return null;
  return {
    id: s.id,
    type: s.type,
    props: props.data,
    style: style.data,
    ...(s.hidden === true ? { hidden: true } : {}),
  } as Section;
}

const sectionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, hyphens and underscores");

/** Strict validation for saving (the page builder, the seed). */
export function sectionInputSchema() {
  return z.discriminatedUnion(
    "type",
    sectionTypes.map((type) =>
      z
        .object({
          id: sectionId,
          type: z.literal(type),
          props: propsByType[type],
          style: sectionStyleSchema.default(sectionStyleSchema.parse({})),
          hidden: z.boolean().optional(),
        })
        .strict(),
    ) as unknown as [z.ZodObject, ...z.ZodObject[]],
  );
}

/** Media ids a section points at (images, posters, backgrounds), for the library's usage. */
export function sectionMediaIds(section: {
  type: string;
  props?: unknown;
  style?: unknown;
}): string[] {
  const out: string[] = [];
  const p = (section.props ?? {}) as Record<string, unknown>;
  const s = (section.style ?? {}) as Record<string, unknown>;
  for (const key of ["imageId", "posterId"]) {
    const v = p[key];
    if (typeof v === "string") out.push(v);
  }
  if (typeof s.backgroundImageId === "string") out.push(s.backgroundImageId);
  if (Array.isArray(p.images))
    for (const img of p.images) {
      const v = (img as { mediaId?: unknown } | null)?.mediaId;
      if (typeof v === "string") out.push(v);
    }
  return out.filter((x) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x),
  );
}
