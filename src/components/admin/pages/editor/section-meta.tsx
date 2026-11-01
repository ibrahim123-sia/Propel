"use client";

import {
  BarChart3Icon,
  BotIcon,
  BuildingIcon,
  CalculatorIcon,
  CodeIcon,
  ContactIcon,
  FileTextIcon,
  GalleryHorizontalIcon,
  HelpCircleIcon,
  HomeIcon,
  ImageIcon,
  LayoutGridIcon,
  MapIcon,
  MapPinIcon,
  MegaphoneIcon,
  MinusIcon,
  NewspaperIcon,
  QuoteIcon,
  SearchIcon,
  SparklesIcon,
  SquarePenIcon,
  UsersIcon,
  VideoIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import type { EditorSection } from "@/features/cms/section-rules";
import type { SectionType } from "@/features/cms/sections";
import { richTextToPlain, type RichDoc } from "@/lib/rich-text";

export const sectionIcons: Record<SectionType, LucideIcon> = {
  hero_search: SearchIcon,
  hero_simple: MegaphoneIcon,
  promise_strip: SparklesIcon,
  featured_listings: HomeIcon,
  projects_showcase: BuildingIcon,
  areas_grid: MapPinIcon,
  search_embed: LayoutGridIcon,
  text: FileTextIcon,
  text_image: ImageIcon,
  stats: BarChart3Icon,
  testimonials: QuoteIcon,
  faq: HelpCircleIcon,
  team: UsersIcon,
  developer_logos: BuildingIcon,
  blog_posts: NewspaperIcon,
  cta: MegaphoneIcon,
  tools: CalculatorIcon,
  ai_teaser: BotIcon,
  contact_block: ContactIcon,
  form: SquarePenIcon,
  video: VideoIcon,
  gallery: GalleryHorizontalIcon,
  map: MapIcon,
  divider: MinusIcon,
  custom_html: CodeIcon,
};

/** One line about what a section says, for the section list. */
export function sectionSummary(s: EditorSection): string {
  const p = s.props as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  const first =
    str("heading") ||
    str("label") ||
    (s.type === "text" && p.body ? richTextToPlain(p.body as RichDoc) : "") ||
    str("search") ||
    str("url");
  if (first) return first.length > 70 ? `${first.slice(0, 68)}…` : first;
  if (s.type === "gallery" && Array.isArray(p.images)) return `${p.images.length} images`;
  if (s.type === "tools" && Array.isArray(p.tools)) return `${p.tools.length} tools`;
  if (s.type === "promise_strip" && Array.isArray(p.items))
    return (p.items as Array<{ title?: string }>)
      .map((i) => i.title)
      .filter(Boolean)
      .join(" · ");
  return "";
}

const bar = (w: string, extra = "") => (
  <span className={cn("block h-1.5 rounded-full bg-current opacity-40", w, extra)} />
);

/** Small schematic of each section type for the section picker. */
export function SectionThumb({ type }: { type: SectionType }) {
  const box = "flex h-20 w-full overflow-hidden rounded-md border border-border p-2 text-ink";
  switch (type) {
    case "hero_search":
      return (
        <span className={cn(box, "gap-2 bg-[#F4EEE6]")}>
          <span className="flex flex-1 flex-col justify-center gap-1">
            {bar("w-3/4", "h-2 opacity-70")}
            {bar("w-1/2")}
            <span className="mt-1 block h-4 w-full rounded bg-white shadow-sm" />
          </span>
          <span className="block w-2/5 rounded bg-ink/20" />
        </span>
      );
    case "hero_simple":
      return (
        <span className={cn(box, "flex-col items-start justify-center gap-1.5 bg-[#F4EEE6]")}>
          {bar("w-2/3", "h-2 opacity-70")}
          {bar("w-1/2")}
          <span className="mt-1 flex gap-1">
            <span className="block h-3 w-8 rounded bg-accent" />
            <span className="block h-3 w-8 rounded border border-ink/40" />
          </span>
        </span>
      );
    case "cta":
      return (
        <span className={cn(box, "flex-col items-start justify-center gap-1.5 bg-ink text-white")}>
          {bar("w-1/2", "h-2 opacity-80")}
          {bar("w-2/3", "opacity-50")}
          <span className="mt-1 block h-3 w-10 rounded bg-accent" />
        </span>
      );
    case "tools":
      return (
        <span className={cn(box, "items-center gap-2")}>
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="flex h-full flex-1 flex-col gap-1 rounded border border-border p-1"
            >
              <span className="block size-3 rounded bg-accent/40" />
              {bar("w-full")}
            </span>
          ))}
        </span>
      );
    case "ai_teaser":
      return (
        <span className={cn(box, "gap-2")}>
          <span className="flex flex-1 flex-col justify-center gap-1">
            {bar("w-2/3", "h-2 opacity-70")}
            <span className="mt-1 flex gap-1">
              <span className="block h-3 w-8 rounded-full border border-ink/40" />
              <span className="block h-3 w-10 rounded-full border border-ink/40" />
            </span>
          </span>
          <span className="flex w-2/5 flex-col justify-end gap-1 rounded bg-ink/10 p-1">
            <span className="block h-2 w-3/4 rounded bg-white" />
            <span className="block h-2 w-1/2 self-end rounded bg-accent/50" />
          </span>
        </span>
      );
    case "promise_strip":
      return (
        <span className={cn(box, "items-center gap-2")}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-1 flex-col gap-1">
              <span className="block size-3 rounded bg-accent/40" />
              {bar("w-full")}
              {bar("w-2/3")}
            </span>
          ))}
        </span>
      );
    case "featured_listings":
    case "search_embed":
    case "blog_posts":
      return (
        <span className={cn(box, "items-stretch gap-1.5")}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex flex-1 flex-col gap-1 rounded border border-border p-1">
              <span className="block flex-1 rounded-sm bg-ink/15" />
              {bar("w-3/4")}
              {type !== "blog_posts" && bar("w-1/2", "bg-accent opacity-60")}
            </span>
          ))}
        </span>
      );
    case "projects_showcase":
      return (
        <span className={cn(box, "gap-1.5 bg-ink")}>
          {[0, 1].map((i) => (
            <span key={i} className="flex flex-1 flex-col gap-1 rounded bg-white/10 p-1">
              <span className="block flex-1 rounded-sm bg-white/25" />
              <span className="block h-1.5 w-2/3 rounded-full bg-white/50" />
            </span>
          ))}
        </span>
      );
    case "areas_grid":
      return (
        <span className={cn(box, "gap-1")}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="flex flex-1 items-end rounded bg-ink/20 p-1">
              <span className="block h-1.5 w-3/4 rounded-full bg-white/80" />
            </span>
          ))}
        </span>
      );
    case "text":
      return (
        <span className={cn(box, "flex-col justify-center gap-1.5 px-4")}>
          {bar("w-1/3", "h-2 opacity-70")}
          {bar("w-full")}
          {bar("w-full")}
          {bar("w-4/5")}
        </span>
      );
    case "text_image":
      return (
        <span className={cn(box, "items-center gap-2")}>
          <span className="flex flex-1 flex-col gap-1.5">
            {bar("w-2/3", "h-2 opacity-70")}
            {bar("w-full")}
            {bar("w-4/5")}
          </span>
          <span className="block h-full w-2/5 rounded bg-ink/20" />
        </span>
      );
    case "stats":
      return (
        <span className={cn(box, "items-center gap-2")}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="flex flex-1 flex-col gap-1">
              <span className="block h-3 w-3/4 rounded bg-ink/60" />
              {bar("w-full")}
            </span>
          ))}
        </span>
      );
    case "testimonials":
      return (
        <span className={cn(box, "gap-1.5")}>
          {[0, 1].map((i) => (
            <span key={i} className="flex flex-1 flex-col gap-1 rounded border border-border p-1.5">
              <QuoteIcon className="size-3 text-accent" aria-hidden />
              {bar("w-full")}
              {bar("w-2/3")}
            </span>
          ))}
        </span>
      );
    case "faq":
      return (
        <span className={cn(box, "flex-col justify-center gap-1")}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="flex items-center justify-between rounded border border-border px-1.5 py-1"
            >
              {bar("w-2/3")}
              <span className="text-[8px] leading-none opacity-60">+</span>
            </span>
          ))}
        </span>
      );
    case "team":
      return (
        <span className={cn(box, "items-center justify-around")}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="flex flex-col items-center gap-1">
              <span className="block size-6 rounded-full bg-ink/25" />
              <span className="block h-1.5 w-8 rounded-full bg-current opacity-40" />
            </span>
          ))}
        </span>
      );
    case "developer_logos":
      return (
        <span className={cn(box, "items-center justify-around")}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="block h-4 w-7 rounded bg-ink/25" />
          ))}
        </span>
      );
    case "contact_block":
      return (
        <span className={cn(box, "gap-2")}>
          <span className="flex flex-1 flex-col justify-center gap-1.5">
            {bar("w-2/3", "h-2 opacity-70")}
            {bar("w-1/2")}
            {bar("w-3/5")}
          </span>
          <span className="flex flex-1 flex-col gap-1 rounded border border-border p-1">
            <span className="block h-2 rounded-sm bg-ink/10" />
            <span className="block h-2 rounded-sm bg-ink/10" />
            <span className="block h-3 w-1/2 rounded-sm bg-accent" />
          </span>
        </span>
      );
    case "form":
      return (
        <span className={cn(box, "flex-col justify-center gap-1 px-6")}>
          <span className="block h-2.5 rounded-sm border border-border" />
          <span className="block h-2.5 rounded-sm border border-border" />
          <span className="block h-3 w-1/3 rounded-sm bg-accent" />
        </span>
      );
    case "map":
      return (
        <span className={cn(box, "items-center justify-center bg-[#E7EEE9]")}>
          <MapPinIcon className="size-6 text-accent" aria-hidden />
        </span>
      );
    case "gallery":
      return (
        <span className={cn(box, "grid grid-cols-3 gap-1")}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <span key={i} className="block rounded-sm bg-ink/20" />
          ))}
        </span>
      );
    case "video":
      return (
        <span className={cn(box, "items-center justify-center bg-ink/80")}>
          <span className="flex size-7 items-center justify-center rounded-full bg-white/90">
            <span className="ms-0.5 block size-0 border-y-[5px] border-s-[8px] border-y-transparent border-s-ink" />
          </span>
        </span>
      );
    case "divider":
      return (
        <span className={cn(box, "items-center px-4")}>
          <span className="block h-px w-full bg-ink/40" />
        </span>
      );
    case "custom_html":
      return (
        <span
          className={cn(box, "items-center justify-center font-mono text-[13px] text-text-muted")}
        >
          {"</>"}
        </span>
      );
  }
}
