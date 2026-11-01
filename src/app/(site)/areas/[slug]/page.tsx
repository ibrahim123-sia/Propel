import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { resolveMapStyle } from "@/components/maps/map-style";
import { Breadcrumb } from "@/components/site/breadcrumb";
import { FaqList } from "@/components/site/content/faq-list";
import { PostBody } from "@/components/site/content/post-body";
import { PostCard } from "@/components/site/content/post-card";
import { JsonLd } from "@/components/site/json-ld";
import { ListingCard } from "@/components/site/listings/listing-card";
import { PlaceMap } from "@/components/site/maps/place-map";
import { MediaImage } from "@/components/site/media-image";
import { PriceTrendsSection } from "@/components/site/price-trends/price-trends";
import { PriceTag } from "@/components/site/price-tag";
import { ProjectCard } from "@/components/site/projects/project-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getPublicGuide, type PublicGuide } from "@/features/area-guides/public";
import { placeJsonLd } from "@/features/content/json-ld";
import { followRedirect } from "@/features/content/redirect";
import { getPublicMedia } from "@/features/media/queries";
import { getSettings } from "@/features/settings/queries";
import { cardContext } from "@/features/site/card-context";
import { fillTitlePattern } from "@/features/site/seo";
import { siteOrigin, siteUrl } from "@/features/site/url";
import { format, pages, site } from "@/lib/i18n";
import { content } from "@/lib/i18n/dictionaries/content";
import { areaUnitLabels, perAreaFromSqm } from "@/lib/units";
import { shareImage } from "@/features/og/cards";

/** Per request: the slug (and the visitor's currency for prices) decide what renders. */
export const instant = false;

const describe = (g: PublicGuide) => g.seo.description || g.intro || "";

export async function generateMetadata(props: PageProps<"/areas/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const g = await getPublicGuide(slug);
  if (!g) return { title: site.errors.notFoundTitle };
  const seo = await getSettings("seo");
  const title =
    g.seo.title || fillTitlePattern(seo.areaTitlePattern, { area: g.location.name }, g.title);
  const og = g.seo.ogImageId ? await getPublicMedia(g.seo.ogImageId) : null;
  const images = await shareImage("area", g.slug, og?.url);
  const description = describe(g).slice(0, 160) || undefined;
  return {
    title,
    description,
    alternates: { canonical: g.seo.canonicalUrl || `/areas/${g.slug}` },
    robots: g.seo.noindex ? { index: false, follow: true } : undefined,
    openGraph: { title, description, images },
    twitter: { card: "summary_large_image", title, description, images: images.map((i) => i.url) },
  };
}

/** /areas/[slug] (06 §7): the guide, live numbers, places, homes, projects and questions. */
export default async function AreaGuidePage(props: PageProps<"/areas/[slug]">) {
  const { slug } = await props.params;
  const g = await getPublicGuide(slug);
  if (!g) {
    await followRedirect(`/areas/${slug}`);
    notFound();
  }
  const t = content.areas;
  const origin = siteOrigin();
  const [ctx, general, integrations, market] = await Promise.all([
    cardContext(),
    getSettings("general"),
    getSettings("integrations"),
    getSettings("market"),
  ]);
  const area = g.location.name;
  const placeGroups = [
    ...g.places.reduce(
      (m, p) => m.set(p.typeName, [...(m.get(p.typeName) ?? []), p]),
      new Map<string, typeof g.places>(),
    ),
  ];

  return (
    <div className="section-y">
      <div className="container-site flex flex-col gap-12">
        <div className="flex flex-col gap-6">
          <Breadcrumb
            items={[
              { label: pages.common.home, href: "/" },
              { label: t.title, href: "/areas" },
              { label: g.title },
            ]}
            baseUrl={origin}
          />
          <header className="flex max-w-3xl flex-col gap-4">
            <h1 className="text-display">{g.title}</h1>
            {g.intro && <p className="text-lg leading-relaxed text-text">{g.intro}</p>}
          </header>
          {g.cover && (
            <div className="overflow-hidden rounded-[20px]">
              <MediaImage
                src={g.cover.url}
                alt={g.cover.alt}
                aspect="21 / 9"
                sizes="(min-width: 1280px) 1200px, 100vw"
                color={g.cover.dominantColor}
                priority
              />
            </div>
          )}
        </div>

        <section aria-labelledby="at-a-glance" className="flex flex-col gap-5">
          <h2 id="at-a-glance" className="text-h2">
            {t.stats}
          </h2>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-[20px] bg-surface p-5 shadow-soft">
              <dt className="text-[13.5px] text-text-muted">{t.homesForSale}</dt>
              <dd className="mt-1 text-[26px] font-semibold text-ink">
                <a href={`/buy/${g.location.slug}`} className="hover:underline">
                  {g.counts.sale}
                </a>
              </dd>
            </div>
            <div className="rounded-[20px] bg-surface p-5 shadow-soft">
              <dt className="text-[13.5px] text-text-muted">{t.homesToRent}</dt>
              <dd className="mt-1 text-[26px] font-semibold text-ink">
                <a href={`/rent/${g.location.slug}`} className="hover:underline">
                  {g.counts.rent}
                </a>
              </dd>
            </div>
            {g.average && (
              <div className="rounded-[20px] bg-surface p-5 shadow-soft">
                <dt className="text-[13.5px] text-text-muted">
                  {format(t.averagePrice, { unit: areaUnitLabels[market.areaUnit] })}
                </dt>
                <dd className="mt-1">
                  <PriceTag
                    price={Math.round(perAreaFromSqm(g.average.perSqm, market.areaUnit))}
                    currency={g.average.currency}
                    visitorCurrency={ctx.visitorCurrency}
                    rates={ctx.rates}
                    className="text-[22px]"
                  />
                </dd>
              </div>
            )}
            {g.stats.map((s) => (
              <div
                key={`${s.label}-${s.value}`}
                className="rounded-[20px] bg-surface p-5 shadow-soft"
              >
                <dt className="text-[13.5px] text-text-muted">{s.label}</dt>
                <dd className="mt-1 text-[26px] font-semibold text-ink">{s.value}</dd>
                <dd className="mt-1 text-[12.5px] text-text-muted">
                  {format(t.statSource, { source: s.source })}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-[12.5px] text-text-muted">{t.liveCounts}</p>
        </section>

        <Suspense fallback={null}>
          <PriceTrendsSection locationId={g.location.id} />
        </Suspense>

        {g.highlights.length > 0 && (
          <section aria-labelledby="living-here" className="flex flex-col gap-4">
            <h2 id="living-here" className="text-h2">
              {t.highlights}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {g.highlights.map((h) => (
                <li
                  key={h}
                  className="rounded-[16px] bg-surface px-4 py-3 text-[15.5px] text-ink shadow-soft"
                >
                  {h}
                </li>
              ))}
            </ul>
          </section>
        )}

        {g.segments.length > 0 && (
          <div className="max-w-3xl">
            <PostBody segments={g.segments} />
          </div>
        )}

        {g.gallery.length > 0 && (
          <section aria-labelledby="area-photos" className="flex flex-col gap-4">
            <h2 id="area-photos" className="text-h2">
              {t.gallery}
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.gallery.map((p) => (
                <li key={p.id}>
                  <figure className="flex flex-col gap-2">
                    <MediaImage
                      src={p.url}
                      alt={p.alt}
                      aspect="4 / 3"
                      sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                      color={p.dominantColor}
                      className="rounded-[16px]"
                    />
                    {p.caption && (
                      <figcaption className="text-[13px] text-text-muted">{p.caption}</figcaption>
                    )}
                  </figure>
                </li>
              ))}
            </ul>
          </section>
        )}

        {g.location.center && (
          <section aria-labelledby="around-the-area" className="flex flex-col gap-4">
            <h2 id="around-the-area" className="text-h2">
              {t.nearby}
            </h2>
            <PlaceMap
              center={g.location.center}
              places={g.places.map((p) => ({ id: p.id, name: p.name, point: p.point }))}
              styleUrl={resolveMapStyle(integrations.googleMaps).styleUrl}
              label={format(t.map, { area })}
              zoom={13}
            />
            {placeGroups.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {placeGroups.map(([type, list]) => (
                  <div key={type}>
                    <h3 className="text-[15px] font-semibold text-ink">{type}</h3>
                    <ul className="mt-1 text-[14.5px] text-text">
                      {list.map((p) => (
                        <li key={p.id}>{p.name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="area-homes" className="flex flex-col gap-4">
          <h2 id="area-homes" className="text-h2">
            {format(t.homesTabs, { area })}
          </h2>
          <Tabs defaultValue="sale">
            <TabsList>
              <TabsTrigger value="sale">{t.homesForSale}</TabsTrigger>
              <TabsTrigger value="rent">{t.homesToRent}</TabsTrigger>
            </TabsList>
            {(
              [
                ["sale", g.forSale, t.noneForSale, `/buy/${g.location.slug}`, t.viewAllSale],
                ["rent", g.toRent, t.noneToRent, `/rent/${g.location.slug}`, t.viewAllRent],
              ] as const
            ).map(([value, cards, none, href, all]) => (
              // Both lists stay in the page (for search engines); only the chosen one shows.
              <TabsContent
                key={value}
                value={value}
                forceMount
                className="mt-4 flex flex-col gap-4 data-[state=inactive]:hidden"
              >
                {cards.length === 0 ? (
                  <p className="text-text-muted">{none}</p>
                ) : (
                  <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                    {cards.map((c) => (
                      <li key={c.id}>
                        <ListingCard listing={c} ctx={ctx} />
                      </li>
                    ))}
                  </ul>
                )}
                <a
                  href={href}
                  className="self-start font-semibold text-accent underline underline-offset-4"
                >
                  {format(all, { area })}
                </a>
              </TabsContent>
            ))}
          </Tabs>
        </section>

        {g.projects.length > 0 && (
          <section aria-labelledby="area-projects" className="flex flex-col gap-4">
            <h2 id="area-projects" className="text-h2">
              {format(t.projects, { area })}
            </h2>
            <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {g.projects.map((p) => (
                <li key={p.id} className="flex">
                  <ProjectCard
                    project={p}
                    visitorCurrency={ctx.visitorCurrency}
                    rates={ctx.rates}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        <FaqList id="area-faqs" title={format(t.faqs, { area })} faqs={g.faqs} />

        {g.related.length > 0 && (
          <section aria-labelledby="area-reading" className="flex flex-col gap-4">
            <h2 id="area-reading" className="text-h2">
              {format(t.related, { area })}
            </h2>
            <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {g.related.map((p) => (
                <li key={p.id} className="flex">
                  <PostCard post={p} timeZone={general.timeZone} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <JsonLd
        data={placeJsonLd(g, {
          url: siteUrl(`/areas/${g.slug}`),
          origin,
          description: describe(g),
        })}
      />
    </div>
  );
}
