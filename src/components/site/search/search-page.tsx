import { redirect } from "next/navigation";
import { SaveSearchButton } from "@/components/site/account/save-search-button";
import { Breadcrumb, type Crumb } from "@/components/site/breadcrumb";
import { FaqList } from "@/components/site/content/faq-list";
import { ListingCard, type CardContext } from "@/components/site/listings/listing-card";
import { resolveMapStyle } from "@/components/maps/map-style";
import { getSettings } from "@/features/settings/queries";
import { visitorCurrency } from "@/features/site/currency";
import {
  clearedSearch,
  countText,
  searchChips,
  searchHeading,
  showingText,
} from "@/features/search/labels";
import {
  liveListingSlugByRef,
  relaxSuggestions,
  searchLabels,
  searchOptions,
  siblingAreas,
  type LandingInfo,
} from "@/features/search/page-data";
import { parseSearch, searchHref, searchQuery, type SearchFilters } from "@/features/search/params";
import { searchListings } from "@/features/search/query";
import { format } from "@/lib/i18n";
import { content as c } from "@/lib/i18n/dictionaries/content";
import { search as t } from "@/lib/i18n/dictionaries/search";
import { FilterBar } from "./filter-bar";
import { TypeLandingLinks } from "./type-landing-links";
import { SearchLayout } from "./search-layout";

export type SearchPreset = Partial<Pick<SearchFilters, "purpose" | "completion" | "loc" | "type">>;
type Params = Record<string, string | string[] | undefined>;

/**
 * Search results page (06 §4) for /buy, /rent, /off-plan and the SEO landing routes. It reads
 * the URL first, like /projects: the page is the dynamic hole. With a Suspense boundary inside
 * the page instead, a cached page on Workers failed to resume ("Expected the resume to render
 * <...> in this slot") and never finished streaming.
 */
export async function SearchPage({
  preset,
  searchParams,
  landing,
}: {
  preset: SearchPreset;
  searchParams: Promise<Params>;
  landing?: LandingInfo | null;
}) {
  return (
    <div className="container-wide pt-5 pb-16">
      <SearchContent preset={preset} searchParams={searchParams} landing={landing ?? null} />
    </div>
  );
}

async function SearchContent({
  preset,
  searchParams,
  landing,
}: {
  preset: SearchPreset;
  searchParams: Promise<Params>;
  landing: LandingInfo | null;
}) {
  const f = parseSearch(await searchParams, preset);
  if (f.ref) {
    const slug = await liveListingSlugByRef(f.ref);
    if (slug) redirect(`/property/${slug}`);
  }
  const [result, labels, options, market, integrations, visitor] = await Promise.all([
    searchListings(f),
    searchLabels(f),
    searchOptions(),
    getSettings("market"),
    getSettings("integrations"),
    visitorCurrency(),
  ]);
  const units = { currency: market.baseCurrency, areaUnit: market.areaUnit };
  const heading = searchHeading(f, labels);
  const chips = searchChips(f, labels, units);
  const ctx: CardContext = {
    visitorCurrency: visitor.code,
    rates: visitor.rates,
    areaUnit: market.areaUnit,
    distanceUnit: market.distanceUnit,
  };
  const root =
    f.completion === "off_plan" && f.purpose === "sale"
      ? { label: t.breadcrumb.offPlan, href: "/off-plan" }
      : f.purpose === "rent"
        ? { label: t.breadcrumb.rent, href: "/rent" }
        : { label: t.breadcrumb.buy, href: "/buy" };
  const crumbs: Crumb[] = [{ label: t.breadcrumb.home, href: "/" }, root];
  if (landing?.location)
    crumbs.push({
      label: landing.location.name,
      href: searchHref({
        ...parseSearch({}, { ...preset, type: [] }),
        loc: [landing.location.slug],
      }),
    });
  if (landing?.type) crumbs.push({ label: landing.type.name });
  const style = resolveMapStyle(integrations.googleMaps);
  const pinsQuery = searchQuery({ ...f, page: 1 });

  return (
    <>
      <Breadcrumb items={crumbs} className="mb-3" baseUrl={process.env.APP_URL} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-h1 text-ink">{heading}</h1>
          <p className="mt-2 text-meta text-text-muted" aria-live="polite">
            {countText(result.total)}
          </p>
        </div>
        <SaveSearchButton query={searchQuery({ ...f, page: 1 })} defaultName={heading} />
      </div>
      {(landing?.guide?.intro || landing?.location?.description) && (
        <div className="mb-5 flex max-w-3xl flex-col gap-2">
          <p className="text-[15px] leading-relaxed text-text">
            {landing.guide?.intro || landing.location?.description}
          </p>
          {landing.guide && landing.location && (
            <a
              href={`/areas/${landing.guide.slug}`}
              className="self-start text-[14px] font-semibold text-accent underline underline-offset-4"
            >
              {format(c.areas.readGuide, { area: landing.location.name })}
            </a>
          )}
        </div>
      )}

      <FilterBar
        filters={f}
        labels={labels}
        options={options}
        currency={market.baseCurrency}
        visitor={visitor}
        areaUnit={market.areaUnit}
        total={result.total}
      />

      {chips.length > 0 && (
        <div
          className="mt-3 flex flex-wrap items-center gap-2"
          aria-label={t.filters.active}
          role="group"
        >
          {chips.map((c) => (
            <a
              key={c.key}
              href={searchHref(c.remove(f))}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-[13px] text-ink hover:border-ink/30"
            >
              {c.label}
              <span aria-hidden className="text-text-muted">
                ×
              </span>
              <span className="sr-only">{format(t.filters.remove, { label: c.label })}</span>
            </a>
          ))}
          <a
            href={searchHref(clearedSearch(f, labels, units))}
            className="text-[13px] font-medium text-accent underline-offset-2 hover:underline"
          >
            {t.filters.clearAll}
          </a>
        </div>
      )}

      <SearchLayout
        pinsQuery={pinsQuery}
        filters={f}
        styleUrl={style.styleUrl}
        center={market.mapCenter}
        zoom={market.mapZoom}
        ctx={ctx}
      >
        {result.total === 0 ? (
          <NoResults f={f} labels={labels} units={units} />
        ) : (
          <section aria-label={t.results.label} className="flex flex-col gap-4">
            <p className="text-[13px] text-text-muted">{showingText(result.total, result.page)}</p>
            <ol className="flex flex-col gap-4 [&_[data-highlight=true]]:outline-2 [&_[data-highlight=true]]:outline-offset-2 [&_[data-highlight=true]]:outline-accent">
              {result.cards.map((card, i) => (
                <li key={card.id}>
                  <ListingCard
                    listing={card}
                    ctx={ctx}
                    layout="row"
                    priority={i === 0}
                    headingLevel={2}
                  />
                </li>
              ))}
            </ol>
            <Pagination f={f} page={result.page} pages={result.pages} />
          </section>
        )}
      </SearchLayout>
      {landing?.guide && landing.location && (
        <div className="mt-12">
          <FaqList
            id="area-faqs"
            title={format(c.areas.faqs, { area: landing.location.name })}
            faqs={landing.guide.faqs}
          />
        </div>
      )}
      {landing?.location && !landing.type && f.completion !== "off_plan" && (
        <TypeLandingLinks location={landing.location} purpose={f.purpose} />
      )}
    </>
  );
}

function Pagination({ f, page, pages }: { f: SearchFilters; page: number; pages: number }) {
  if (pages <= 1) return null;
  const window = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const list = [...window].sort((a, b) => a - b);
  const link = (p: number) => searchHref({ ...f, page: p });
  return (
    <nav
      aria-label={t.results.pagination}
      className="mt-4 flex flex-wrap items-center justify-center gap-1.5"
    >
      {page > 1 && (
        <a
          href={link(page - 1)}
          rel="prev"
          className="rounded-full border border-border px-4 py-2 text-[14px] hover:border-ink/30"
        >
          {t.results.previous}
        </a>
      )}
      {list.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && list[i - 1]! < p - 1 && (
            <span aria-hidden className="px-1 text-text-muted">
              …
            </span>
          )}
          {p === page ? (
            <span
              aria-current="page"
              className="rounded-full bg-ink px-4 py-2 text-[14px] font-semibold text-surface"
            >
              {p}
            </span>
          ) : (
            <a
              href={link(p)}
              aria-label={format(t.results.goToPage, { page: p })}
              className="rounded-full border border-border px-4 py-2 text-[14px] hover:border-ink/30"
            >
              {p}
            </a>
          )}
        </span>
      ))}
      {page < pages && (
        <a
          href={link(page + 1)}
          rel="next"
          className="rounded-full border border-border px-4 py-2 text-[14px] hover:border-ink/30"
        >
          {t.results.next}
        </a>
      )}
    </nav>
  );
}

/** 06 §4.6: what to change to get results back, and nearby areas that have homes. */
async function NoResults({
  f,
  labels,
  units,
}: {
  f: SearchFilters;
  labels: Awaited<ReturnType<typeof searchLabels>>;
  units: Parameters<typeof searchChips>[2];
}) {
  const [relax, nearby] = await Promise.all([relaxSuggestions(f, labels, units), siblingAreas(f)]);
  const cleared = searchHref(clearedSearch(f, labels, units));
  return (
    <section
      aria-label={t.empty.title}
      className="rounded-[20px] border border-border bg-surface p-6 md:p-8"
    >
      <h2 className="text-h3 text-ink">{t.empty.title}</h2>
      <p className="mt-2 text-[15px] text-text-muted">{t.empty.text}</p>
      {relax.length > 0 && (
        <ul className="mt-5 flex flex-col gap-2">
          {relax.map((s) => (
            <li key={s.href}>
              <a
                href={s.href}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {s.count === 1
                  ? format(t.empty.relaxOne, { label: s.label })
                  : format(t.empty.relax, { label: s.label, count: s.count.toLocaleString("en") })}
              </a>
            </li>
          ))}
        </ul>
      )}
      {nearby.length > 0 && (
        <div className="mt-6">
          <h3 className="text-[15px] font-semibold text-ink">{t.empty.nearby}</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {nearby.map((s) => (
              <li key={s.href}>
                <a
                  href={s.href}
                  className="inline-flex rounded-full border border-border px-3 py-1.5 text-[14px] text-ink hover:border-ink/30"
                >
                  {format(t.empty.nearbyCount, {
                    name: s.label,
                    count: s.count.toLocaleString("en"),
                  })}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <a
        href={cleared}
        className="mt-6 inline-block text-[14px] font-medium text-ink underline underline-offset-2"
      >
        {t.empty.clearAll}
      </a>
    </section>
  );
}
