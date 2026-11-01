import {
  BadgeCheckIcon,
  BadgeDollarSignIcon,
  CalculatorIcon,
  Columns3Icon,
  HousePlusIcon,
  MapPinIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Fragment, Suspense, type ReactNode } from "react";
import { ListingCard } from "@/components/site/listings/listing-card";
import { MediaImage } from "@/components/site/media-image";
import { ProjectCard } from "@/components/site/projects/project-card";
import { getPublicMedia } from "@/features/media/queries";
import { withHeadingIds } from "@/features/cms/headings";
import { areaCards, featuredListingCards, heroSearchOptions } from "@/features/cms/queries";
import { sectionCatalog } from "@/features/cms/section-catalog";
import { showcaseProjectCards } from "@/features/projects/public";
import type { Section, SiteTool } from "@/features/cms/sections";
import { getSettings } from "@/features/settings/queries";
import { ChatPromptChips } from "@/components/site/chat/chat-controls";
import { Icon } from "@/lib/icons";
import { sectionsText as t } from "@/lib/i18n/dictionaries/home";
import { renderRichText } from "@/lib/rich-text";
import { HeroSearchCard } from "./hero-search-card";
import {
  BlogPosts,
  ContactBlock,
  CustomHtml,
  DeveloperLogos,
  Divider,
  Faq,
  FormSection,
  Gallery,
  MapSection,
  SearchEmbed,
  Team,
  Testimonials,
  TextImage,
  Video,
} from "./more-sections";
import { Carousel } from "./section-clients";
import {
  BlockSkeleton,
  Buttons,
  GridSkeleton,
  withCurrency,
  type SectionContext,
} from "./section-parts";

export type { SectionContext } from "./section-parts";
import { SectionHeading, SectionShell } from "./section-shell";

async function HeroSearch({
  s,
  ctx,
  first,
}: {
  s: Extract<Section, { type: "hero_search" }>;
  ctx: SectionContext;
  first: boolean;
}) {
  const [image, options] = await Promise.all([
    getPublicMedia(s.props.imageId),
    heroSearchOptions(),
  ]);
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
        <div className="flex flex-col gap-6">
          {s.props.eyebrow && <p className="text-eyebrow text-accent">{s.props.eyebrow}</p>}
          {first ? (
            <h1 className="text-display text-ink">{s.props.heading}</h1>
          ) : (
            <h2 className="text-display text-ink">{s.props.heading}</h2>
          )}
          {s.props.subheading && (
            <p className="max-w-xl text-[17px] text-text">{s.props.subheading}</p>
          )}
          <HeroSearchCard
            tabs={s.props.tabs}
            defaultTab={s.props.defaultTab}
            types={options.types}
            budgets={options.budgets}
            currency={ctx.baseCurrency}
          />
        </div>
        {image && (
          <div className="relative">
            <MediaImage
              src={image.url}
              alt={image.alt ?? ""}
              sizes="(min-width: 1024px) 50vw, 100vw"
              aspect="4 / 5"
              color={image.dominantColor}
              priority={first}
              className="rounded-[28px]"
            />
            {s.props.floatingBadge && s.props.floatingBadgeText && (
              <p className="absolute start-4 bottom-4 flex items-center gap-2 rounded-[20px] bg-surface px-4 py-3 text-[14px] font-semibold text-ink shadow-soft">
                <BadgeCheckIcon className="size-5 text-success" aria-hidden />
                {s.props.floatingBadgeText}
              </p>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
}

async function HeroSimple({
  s,
  first,
}: {
  s: Extract<Section, { type: "hero_simple" }>;
  first: boolean;
}) {
  const image = await getPublicMedia(s.props.imageId);
  const Heading = first ? "h1" : "h2";
  return (
    <SectionShell style={s.style} label={s.props.heading} backgroundUrl={image?.url}>
      <div className="max-w-3xl">
        <Heading className="text-display">{s.props.heading}</Heading>
        {s.props.subheading && <p className="mt-6 text-[17px]">{s.props.subheading}</p>}
        <Buttons buttons={s.props.buttons} />
      </div>
    </SectionShell>
  );
}

async function FeaturedListings({
  s,
  ctx,
}: {
  s: Extract<Section, { type: "featured_listings" }>;
  ctx: SectionContext;
}) {
  const [cards, cardCtx] = await Promise.all([featuredListingCards(s.props), withCurrency(ctx)]);
  if (cards.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading
        eyebrow={s.props.eyebrow}
        heading={s.props.heading}
        action={
          s.props.viewAll?.href ? (
            <a
              href={s.props.viewAll.href}
              className="text-[15px] font-semibold text-ink underline-offset-4 hover:underline"
            >
              {s.props.viewAll.label || t.listings.viewAll}
            </a>
          ) : null
        }
      />
      {s.props.layout === "carousel" ? (
        <Carousel label={s.props.heading || t.listings.viewAll}>
          {cards.map((c) => (
            <li key={c.id}>
              <ListingCard listing={c} ctx={cardCtx} />
            </li>
          ))}
        </Carousel>
      ) : (
        <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {cards.map((c) => (
            <li key={c.id}>
              <ListingCard listing={c} ctx={cardCtx} />
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

async function ProjectsShowcase({
  s,
  ctx,
}: {
  s: Extract<Section, { type: "projects_showcase" }>;
  ctx: SectionContext;
}) {
  const [items, cardCtx] = await Promise.all([showcaseProjectCards(s.props), withCurrency(ctx)]);
  if (items.length === 0) return null;
  const style = s.props.dark ? { ...s.style, background: "ink" as const } : s.style;
  return (
    <SectionShell style={style} label={s.props.heading}>
      <SectionHeading
        eyebrow={s.props.eyebrow}
        heading={s.props.heading}
        action={
          s.props.viewAll?.href ? (
            <a
              href={s.props.viewAll.href}
              className="text-[15px] font-semibold underline-offset-4 hover:underline"
            >
              {s.props.viewAll.label || t.listings.viewAll}
            </a>
          ) : null
        }
      />
      <ul className="grid gap-6 md:grid-cols-2">
        {items.map((p) => (
          <li key={p.id} className="flex">
            <ProjectCard
              project={p}
              visitorCurrency={cardCtx.visitorCurrency}
              rates={cardCtx.rates}
            />
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

async function AreasGrid({
  s,
  ctx,
}: {
  s: Extract<Section, { type: "areas_grid" }>;
  ctx: SectionContext;
}) {
  void ctx;
  const areas = await areaCards(s.props);
  if (areas.length === 0) return null;
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {areas.map((a) => (
          <li key={a.id}>
            <article className="group relative overflow-hidden rounded-[20px] bg-surface shadow-soft">
              {a.cover ? (
                <MediaImage
                  src={a.cover.url}
                  alt=""
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  aspect="4 / 5"
                  color={a.cover.color}
                />
              ) : (
                <div className="aspect-[4/5] bg-photo-placeholder" />
              )}
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/85 to-transparent p-4 pt-16 text-surface">
                <h3 className="text-h3 text-surface">
                  <a
                    href={`/buy/${a.slug}`}
                    className="after:absolute after:inset-0 after:content-['']"
                  >
                    {a.name}
                  </a>
                </h3>
                <p className="mt-1 flex items-center gap-1 text-[13px] text-surface/85">
                  <MapPinIcon className="size-3.5" aria-hidden />
                  {a.forSale + a.forRent === 0
                    ? t.areas.noHomes
                    : [
                        a.forSale ? t.areas.forSale(a.forSale) : "",
                        a.forRent ? t.areas.toRent(a.forRent) : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                </p>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function PromiseStrip({ s }: { s: Extract<Section, { type: "promise_strip" }> }) {
  return (
    <SectionShell style={s.style}>
      <ul className="grid gap-6 md:grid-cols-3">
        {s.props.items.map((item, i) => (
          <li key={`${item.title}-${i}`} className="flex gap-4">
            {item.icon && (
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Icon name={item.icon} className="size-5" />
              </span>
            )}
            <div>
              {/* The strip has no heading of its own, so its items are the next level. */}
              <h2 className="text-[17px] font-semibold text-ink">{item.title}</h2>
              <p className="mt-1 text-[14.5px] text-text">{item.text}</p>
            </div>
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

function TextSection({
  s,
  headingIds,
}: {
  s: Extract<Section, { type: "text" }>;
  headingIds?: string[];
}) {
  return (
    <SectionShell style={s.style}>
      <div
        className={`rich-text text-[17px] text-text ${s.props.maxWidth === "narrow" ? "max-w-2xl" : "max-w-4xl"}`}
        // Rendered from the validated document by our own allowlist renderer (lib/rich-text).
        dangerouslySetInnerHTML={{
          __html: withHeadingIds(renderRichText(s.props.body), headingIds),
        }}
      />
    </SectionShell>
  );
}

function Stats({ s }: { s: Extract<Section, { type: "stats" }> }) {
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <SectionHeading heading={s.props.heading} />
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {s.props.items.map((item, i) => (
          <div key={`${item.label}-${i}`}>
            <dt className="text-[14px] text-text-muted">{item.label}</dt>
            <dd className="text-h2 text-ink tabular">{item.value}</dd>
            {item.source && <dd className="mt-1 text-[12px] text-text-muted">{item.source}</dd>}
          </div>
        ))}
      </dl>
    </SectionShell>
  );
}

function Cta({ s }: { s: Extract<Section, { type: "cta" }> }) {
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className="max-w-2xl">
        <h2 className="text-h2">{s.props.heading}</h2>
        {s.props.text && <p className="mt-4 text-[17px]">{s.props.text}</p>}
        <Buttons buttons={s.props.buttons} />
      </div>
    </SectionShell>
  );
}

const toolLinks: Record<SiteTool, { href: string; icon: LucideIcon }> = {
  mortgage: { href: "/tools/mortgage", icon: CalculatorIcon },
  rental_returns: { href: "/tools/rental-returns", icon: TrendingUpIcon },
  compare: { href: "/tools/compare", icon: Columns3Icon },
  valuation: { href: "/valuation", icon: BadgeDollarSignIcon },
  list_property: { href: "/list-your-property", icon: HousePlusIcon },
};

/** 06 §3 item 7: cards for the agency's tools. */
function Tools({ s }: { s: Extract<Section, { type: "tools" }> }) {
  return (
    <SectionShell style={s.style} label={s.props.heading || t.tools.label}>
      <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {s.props.tools.map((tool) => {
          const ToolIcon = toolLinks[tool].icon;
          return (
            <li key={tool}>
              <Link
                href={toolLinks[tool].href}
                prefetch={false}
                className="flex h-full flex-col gap-3 rounded-[20px] border border-border bg-surface p-6 transition-colors hover:border-ink/40"
              >
                <ToolIcon className="size-6 text-accent" aria-hidden />
                <span className="text-h4 text-ink">{t.tools.items[tool].title}</span>
                <span className="text-[14.5px] text-text-muted">{t.tools.items[tool].text}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </SectionShell>
  );
}

/**
 * 06 §3 item 6: the assistant teaser, with question chips that open the chat and a small
 * example of a conversation. Hidden while the website chat is off (there is nothing to open).
 */
async function AiTeaser({ s }: { s: Extract<Section, { type: "ai_teaser" }> }) {
  const ai = await getSettings("ai");
  if (!ai.webChat.enabled) return null;
  const first = s.props.prompts[0];
  return (
    <SectionShell style={s.style} label={s.props.heading}>
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <SectionHeading eyebrow={s.props.eyebrow} heading={s.props.heading} />
          {s.props.text && <p className="-mt-4 text-[17px] text-text">{s.props.text}</p>}
          {s.props.prompts.length > 0 && (
            <ChatPromptChips prompts={s.props.prompts} label={t.aiTeaser.prompts} />
          )}
        </div>
        <figure
          aria-label={t.aiTeaser.previewLabel}
          className="flex flex-col gap-3 rounded-[24px] border border-border bg-surface-soft p-6"
        >
          <p className="max-w-[85%] self-start rounded-2xl rounded-ss-sm bg-surface px-4 py-3 text-[14.5px] text-ink shadow-sm">
            {ai.greeting}
          </p>
          {first && (
            <p className="max-w-[85%] self-end rounded-2xl rounded-se-sm bg-ink px-4 py-3 text-[14.5px] text-surface">
              {first}
            </p>
          )}
          <figcaption className="text-[12.5px] text-text-muted">{ai.assistantName}</figcaption>
        </figure>
      </div>
    </SectionShell>
  );
}

export type RenderOptions = {
  /** Whether the first hero may render the page's h1 (false when the page shows its own). */
  h1?: boolean;
  /** The page builder's preview: each section marked so a click selects it in the editor. */
  editable?: boolean;
  /** h2 ids per text section (anchors, the legal template's contents). */
  headingIds?: Map<string, string[]>;
};

/** The market values sections need (units, base currency); the visitor's currency is read later. */
export function sectionContext(market: {
  areaUnit: SectionContext["areaUnit"];
  distanceUnit: SectionContext["distanceUnit"];
  baseCurrency: { code: string; decimals: number };
}): SectionContext {
  return {
    areaUnit: market.areaUnit,
    distanceUnit: market.distanceUnit,
    baseCurrency: { code: market.baseCurrency.code, decimals: market.baseCurrency.decimals },
  };
}

function renderSection(
  s: Section,
  ctx: SectionContext,
  opts: { first: boolean; headingIds?: string[]; faqSchema: boolean },
): ReactNode {
  const { first } = opts;
  switch (s.type) {
    case "hero_search":
      return <HeroSearch s={s} ctx={ctx} first={first} />;
    case "hero_simple":
      return <HeroSimple s={s} first={first} />;
    case "promise_strip":
      return <PromiseStrip s={s} />;
    case "featured_listings":
      return (
        <Suspense fallback={<GridSkeleton count={Math.min(s.props.count, 3)} />}>
          <FeaturedListings s={s} ctx={ctx} />
        </Suspense>
      );
    case "projects_showcase":
      return (
        <Suspense fallback={<GridSkeleton count={2} />}>
          <ProjectsShowcase s={s} ctx={ctx} />
        </Suspense>
      );
    case "areas_grid":
      return <AreasGrid s={s} ctx={ctx} />;
    case "text":
      return <TextSection s={s} headingIds={opts.headingIds} />;
    case "stats":
      return <Stats s={s} />;
    case "cta":
      return <Cta s={s} />;
    case "tools":
      return <Tools s={s} />;
    case "ai_teaser":
      return (
        <Suspense fallback={<BlockSkeleton />}>
          <AiTeaser s={s} />
        </Suspense>
      );
    case "search_embed":
      return (
        <Suspense fallback={<GridSkeleton count={Math.min(s.props.count, 3)} />}>
          <SearchEmbed s={s} ctx={ctx} />
        </Suspense>
      );
    case "text_image":
      return <TextImage s={s} headingIds={opts.headingIds} />;
    case "testimonials":
      return (
        <Suspense fallback={<GridSkeleton count={Math.min(s.props.count, 3)} />}>
          <Testimonials s={s} />
        </Suspense>
      );
    case "faq":
      return (
        <Suspense fallback={<BlockSkeleton />}>
          <Faq s={s} schema={opts.faqSchema} />
        </Suspense>
      );
    case "team":
      return (
        <Suspense fallback={<GridSkeleton count={4} />}>
          <Team s={s} />
        </Suspense>
      );
    case "developer_logos":
      return (
        <Suspense fallback={<BlockSkeleton height="h-20" />}>
          <DeveloperLogos s={s} />
        </Suspense>
      );
    case "blog_posts":
      return (
        <Suspense fallback={<GridSkeleton count={Math.min(s.props.count, 3)} />}>
          <BlogPosts s={s} />
        </Suspense>
      );
    case "contact_block":
      return (
        <Suspense fallback={<BlockSkeleton height="h-96" />}>
          <ContactBlock s={s} ctx={ctx} />
        </Suspense>
      );
    case "form":
      return (
        <Suspense fallback={<BlockSkeleton height="h-96" />}>
          <FormSection s={s} ctx={ctx} />
        </Suspense>
      );
    case "video":
      return <Video s={s} />;
    case "gallery":
      return (
        <Suspense fallback={<GridSkeleton count={3} />}>
          <Gallery s={s} />
        </Suspense>
      );
    case "map":
      return (
        <Suspense fallback={<BlockSkeleton height="h-80" />}>
          <MapSection s={s} />
        </Suspense>
      );
    case "divider":
      return <Divider s={s} />;
    case "custom_html":
      return <CustomHtml s={s} />;
  }
}

/** Renders a page's sections in order; the first heading section owns the page's h1. */
export async function RenderSections({
  sections,
  ctx,
  h1 = true,
  editable = false,
  headingIds,
}: {
  sections: Section[];
  ctx: SectionContext;
} & RenderOptions) {
  const visible = sections.filter((s) => !s.hidden);
  // One FAQPage per page (08 §6): the first FAQ section that asks for it.
  const faqOwner = visible.find((s) => s.type === "faq" && s.props.schema)?.id ?? null;
  return (
    <>
      {visible.map((s, i) => {
        const node = renderSection(s, ctx, {
          first: h1 && i === 0,
          headingIds: headingIds?.get(s.id),
          faqSchema: s.id === faqOwner,
        });
        return editable ? (
          <div
            key={s.id}
            data-section-id={s.id}
            data-section-label={sectionCatalog[s.type].label}
            className="propel-preview-section"
          >
            {node}
          </div>
        ) : (
          <Fragment key={s.id}>{node}</Fragment>
        );
      })}
    </>
  );
}
