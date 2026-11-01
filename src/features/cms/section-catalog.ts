import type { SectionType } from "./sections";

/** Names and short descriptions of the section types (08 §1 table), for the section picker. */
export type SectionGroup = "intro" | "listings" | "content" | "people" | "contact" | "media";

export const sectionGroups: Array<{ key: SectionGroup; label: string }> = [
  { key: "intro", label: "Heroes and calls to action" },
  { key: "listings", label: "Listings, projects and areas" },
  { key: "content", label: "Text and content" },
  { key: "people", label: "Team, partners and reviews" },
  { key: "contact", label: "Contact and forms" },
  { key: "media", label: "Media and layout" },
];

export const sectionCatalog: Record<
  SectionType,
  { label: string; description: string; group: SectionGroup }
> = {
  hero_search: {
    label: "Hero with search",
    description: "Big heading, a search card and a photo.",
    group: "intro",
  },
  hero_simple: {
    label: "Hero",
    description: "Heading, subheading, an optional photo and up to two buttons.",
    group: "intro",
  },
  cta: {
    label: "Call to action",
    description: "A heading, a short text and up to two buttons.",
    group: "intro",
  },
  tools: {
    label: "Tools",
    description: "Cards for the calculators, compare and valuation.",
    group: "intro",
  },
  ai_teaser: {
    label: "AI assistant teaser",
    description: "A short text and example questions that open the website chat.",
    group: "intro",
  },
  promise_strip: {
    label: "Promise strip",
    description: "Two to four short selling points with icons.",
    group: "intro",
  },
  featured_listings: {
    label: "Featured listings",
    description: "Listing cards: featured, newest, picked by hand or by a filter.",
    group: "listings",
  },
  search_embed: {
    label: "Search results",
    description: "Live results of a saved search, e.g. villas under 5M.",
    group: "listings",
  },
  projects_showcase: {
    label: "Projects showcase",
    description: "Off-plan project cards, on a dark band if you like.",
    group: "listings",
  },
  areas_grid: {
    label: "Areas grid",
    description: "Area cards with how many homes are for sale and to rent.",
    group: "listings",
  },
  text: {
    label: "Text",
    description: "Rich text: headings, paragraphs, lists and links.",
    group: "content",
  },
  text_image: {
    label: "Text and image",
    description: "Text beside a photo, with up to two buttons.",
    group: "content",
  },
  stats: {
    label: "Stats",
    description: "Numbers you enter, each with where it comes from.",
    group: "content",
  },
  faq: {
    label: "FAQ",
    description: "Questions and answers from Website -> FAQs, with FAQ structured data.",
    group: "content",
  },
  blog_posts: {
    label: "Blog posts",
    description: "The latest posts, or the latest of one category.",
    group: "content",
  },
  testimonials: {
    label: "Testimonials",
    description: "What clients say: the latest, or picked by hand.",
    group: "people",
  },
  team: {
    label: "Team",
    description: "Agent profiles: all of them, or picked by hand.",
    group: "people",
  },
  developer_logos: {
    label: "Developer logos",
    description: "Logos of the developers you work with.",
    group: "people",
  },
  contact_block: {
    label: "Contact block",
    description: "Office details, a map and a contact form.",
    group: "contact",
  },
  form: {
    label: "Form",
    description: "Contact, callback, valuation, list your property or newsletter.",
    group: "contact",
  },
  map: {
    label: "Map",
    description: "A map with your office, listings and nearby places.",
    group: "contact",
  },
  gallery: {
    label: "Gallery",
    description: "Photos in a grid, a masonry layout or a carousel.",
    group: "media",
  },
  video: {
    label: "Video",
    description: "A YouTube or Vimeo video, or a video file, with a poster image.",
    group: "media",
  },
  divider: {
    label: "Divider or spacer",
    description: "Space between sections, with or without a line.",
    group: "media",
  },
  custom_html: {
    label: "Custom HTML",
    description: "Your own HTML, cleaned for safety. Scripts only if Settings allow them.",
    group: "media",
  },
};
