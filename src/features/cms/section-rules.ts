import type { StoredSection } from "@/db/schema/cms";
import { richTextToPlain } from "@/lib/rich-text";
import { sectionInputSchema, sectionStyleSchema, type Section, type SectionType } from "./sections";

/**
 * What a section needs before its page can be published (08 §1). The draft saves without it;
 * Publish refuses until each problem is fixed, and the editor shows them next to the fields.
 */
export type SectionProblem = { field: string; message: string };

const empty = (v: string | null | undefined) => !v || !v.trim();

export function sectionProblems(s: Section): SectionProblem[] {
  const out: SectionProblem[] = [];
  // Field paths match the schema's error paths: "props.heading", "style.backgroundImageId".
  const need = (ok: boolean, field: string, message: string) => {
    if (!ok) out.push({ field: field.startsWith("style.") ? field : `props.${field}`, message });
  };
  switch (s.type) {
    case "hero_search":
    case "hero_simple":
      need(!empty(s.props.heading), "heading", "Add the heading.");
      break;
    case "promise_strip":
      s.props.items.forEach((item, i) =>
        need(!empty(item.title), `items.${i}.title`, `Give point ${i + 1} a title.`),
      );
      break;
    case "featured_listings":
      if (s.props.source === "manual")
        need(s.props.listingIds.length > 0, "listingIds", "Pick at least one listing.");
      if (s.props.source === "filter")
        need(!empty(s.props.filter), "filter", "Add the search filter.");
      break;
    case "projects_showcase":
      if (s.props.source === "manual")
        need(s.props.projectIds.length > 0, "projectIds", "Pick at least one project.");
      if (s.props.source === "area")
        need(s.props.locationId !== null, "locationId", "Choose the area.");
      break;
    case "areas_grid":
      if (s.props.source === "manual")
        need(s.props.locationIds.length > 0, "locationIds", "Pick at least one area.");
      break;
    case "search_embed":
      need(!empty(s.props.search), "search", "Add the search link.");
      break;
    case "text":
      need(richTextToPlain(s.props.body) !== "", "body", "Write the text.");
      break;
    case "text_image":
      need(
        !empty(s.props.heading) || richTextToPlain(s.props.body) !== "",
        "body",
        "Add a heading or some text.",
      );
      break;
    case "stats":
      s.props.items.forEach((item, i) => {
        need(!empty(item.value), `items.${i}.value`, `Enter number ${i + 1}.`);
        need(!empty(item.label), `items.${i}.label`, `Say what number ${i + 1} counts.`);
      });
      break;
    case "testimonials":
      if (s.props.source === "manual")
        need(s.props.testimonialIds.length > 0, "testimonialIds", "Pick at least one testimonial.");
      break;
    case "faq":
      if (s.props.source === "manual")
        need(s.props.faqIds.length > 0, "faqIds", "Pick at least one question.");
      break;
    case "team":
      if (s.props.source === "manual")
        need(s.props.agentIds.length > 0, "agentIds", "Pick at least one agent profile.");
      break;
    case "developer_logos":
      if (s.props.source === "manual")
        need(s.props.developerIds.length > 0, "developerIds", "Pick at least one developer.");
      break;
    case "blog_posts":
      if (s.props.source === "category")
        need(s.props.categoryId !== null, "categoryId", "Choose the category.");
      break;
    case "cta":
      need(!empty(s.props.heading), "heading", "Add the heading.");
      break;
    case "ai_teaser":
      need(!empty(s.props.heading), "heading", "Add the heading.");
      break;
    case "video":
      need(!empty(s.props.url), "url", "Add the video link.");
      break;
    case "gallery":
      need(s.props.images.length > 0, "images", "Add at least one image.");
      break;
    case "custom_html":
      need(!empty(s.props.html), "html", "Add the HTML.");
      break;
    case "tools":
    case "contact_block":
    case "form":
    case "map":
    case "divider":
      break;
  }
  if (s.style.background === "image")
    need(s.style.backgroundImageId !== null, "style.backgroundImageId", "Choose the image.");
  return out;
}

/** A short random id for a new section (unique within its page). */
export function newSectionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `s${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}

const emptyDoc = () => ({ type: "doc" as const, content: [{ type: "paragraph" as const }] });

/**
 * A new section of this type with empty content (never invented copy: the admin writes it).
 * Some start unfinished on purpose (a gallery without images); the draft keeps them.
 */
export function starterSection(type: SectionType, heading = ""): StoredSection {
  const props: Record<SectionType, Record<string, unknown>> = {
    hero_search: {
      heading,
      tabs: ["buy", "rent", "off_plan"],
      defaultTab: "buy",
      floatingBadge: false,
    },
    hero_simple: { heading, buttons: [] },
    promise_strip: {
      items: [0, 1, 2].map(() => ({ title: "", text: "", icon: "" })),
    },
    featured_listings: { source: "featured", count: 6 },
    projects_showcase: { source: "featured", count: 4, dark: true },
    areas_grid: { source: "featured", count: 4 },
    search_embed: { search: "/buy", count: 6 },
    text: { body: emptyDoc(), maxWidth: "narrow" },
    text_image: { heading, body: emptyDoc(), imageSide: "right" },
    stats: { items: [{ value: "", label: "", source: "" }] },
    testimonials: { source: "latest", count: 3 },
    faq: { source: "group", group: "general", count: 8 },
    team: { source: "all", count: 8 },
    developer_logos: { source: "all", count: 8 },
    blog_posts: { source: "latest", count: 3 },
    cta: { heading, buttons: [] },
    tools: {},
    ai_teaser: { heading, prompts: [] },
    contact_block: { showDetails: true, showMap: true, showForm: true },
    form: { heading, formType: "contact" },
    video: { url: "" },
    gallery: { images: [], layout: "grid", columns: 3 },
    map: { showListings: true, showOffice: true },
    divider: { size: "medium", line: true },
    custom_html: { html: "" },
  };
  const style = sectionStyleSchema.parse({
    background: type === "hero_search" || type === "hero_simple" ? "sand" : "white",
    spacing: type === "promise_strip" || type === "divider" ? "compact" : "normal",
  });
  const section: StoredSection = { id: newSectionId(), type, props: props[type], style };
  // Every starter is valid: parsing fills in the remaining defaults for the editor's fields.
  const parsed = sectionInputSchema().safeParse(section);
  return parsed.success ? (parsed.data as unknown as StoredSection) : section;
}

/**
 * A stored section as the editor works on it: with every default filled in when it is valid,
 * as stored when it is not (the editor then shows what is missing).
 */
export type EditorSection = StoredSection;

export function forEditor(raw: StoredSection[]): EditorSection[] {
  const schema = sectionInputSchema();
  return raw.map((s) => {
    const parsed = schema.safeParse(s);
    return parsed.success ? (parsed.data as unknown as EditorSection) : s;
  });
}

/** JSON with object keys sorted: Postgres jsonb does not keep key order, so compare this way. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
