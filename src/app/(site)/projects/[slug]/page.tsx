import type { Metadata } from "next";
import { CompareButton } from "@/components/site/account/compare-button";
import { SaveHomeButton } from "@/components/site/account/save-home-button";
import { notFound } from "next/navigation";
import { resolveMapStyle } from "@/components/maps/map-style";
import { PaymentPlanView } from "@/components/payment-plan/plan-view";
import { Breadcrumb } from "@/components/site/breadcrumb";
import { JsonLd } from "@/components/site/json-ld";
import { ContactCard } from "@/components/site/contact-card";
import { BookTourButton } from "@/components/site/viewings/book-tour-button";
import { BrochureButton } from "@/components/site/brochure/brochure-button";
import { brochurePath } from "@/features/brochure/paths";
import { ListingCard, handoverLabel } from "@/components/site/listings/listing-card";
import { PlaceMap } from "@/components/site/maps/place-map";
import { MediaImage } from "@/components/site/media-image";
import { PriceTag } from "@/components/site/price-tag";
import { ProjectCard } from "@/components/site/projects/project-card";
import { poiCategories } from "@/db/schema/master-data";
import { getPublicMedia } from "@/features/media/queries";
import { getPublicProject, type PublicProject } from "@/features/projects/public";
import { getSettings } from "@/features/settings/queries";
import { visitorCurrency } from "@/features/site/currency";
import { projectStructuredData, projectTitle } from "@/features/seo/entity-seo";
import { htmlToText } from "@/features/site/seo";
import { siteOrigin, siteUrl } from "@/features/site/url";
import { formatFor } from "@/features/properties/format";
import type { Rates } from "@/lib/currency-display";
import { format, pages, site } from "@/lib/i18n";
import { Icon } from "@/lib/icons";
import { formatArea, formatDistance, formatDuration, type AreaUnit } from "@/lib/units";
import { redirectIfMoved } from "@/features/seo/serve";
import { shareImage } from "@/features/og/cards";

/** Per request: the slug (and the visitor's currency cookie) decide what renders; data is cached. */
export const instant = false;

const dateFormat = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export async function generateMetadata(props: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const p = await getPublicProject(slug);
  if (!p) {
    await redirectIfMoved(`/projects/${slug}`);
    return { title: site.errors.notFoundTitle };
  }
  const [seo, general] = await Promise.all([getSettings("seo"), getSettings("general")]);
  const title = projectTitle(p, seo.projectTitlePattern, general.agencyName);
  const description = projectDescription(p);
  const og = p.seo.ogImageId ? await getPublicMedia(p.seo.ogImageId) : null;
  const images = await shareImage("project", p.slug, og?.url);
  return {
    title,
    description,
    alternates: { canonical: p.seo.canonicalUrl || `/projects/${p.slug}` },
    robots: p.seo.noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      title,
      description,
      type: "website",
      images,
    },
    twitter: { card: "summary_large_image", title, description, images: images.map((i) => i.url) },
  };
}

function projectDescription(p: PublicProject): string {
  return (
    p.seo.description ||
    htmlToText(p.descriptionHtml) ||
    [p.name, p.developer?.name, p.locationPath.at(-1)?.name].filter(Boolean).join(" · ")
  );
}

function sizeRange(min: number | null, max: number | null, unit: AreaUnit): string {
  if (min == null && max == null) return "—";
  if (min != null && max != null && Math.round(min) !== Math.round(max))
    return `${formatArea(min, unit).split(" ")[0]}–${formatArea(max, unit)}`;
  return formatArea((min ?? max)!, unit);
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-text-muted">{label}</dt>
      <dd className="text-[15px] font-semibold text-ink">{children}</dd>
    </div>
  );
}

/** /projects/[slug] (06 §6). Only published projects; others are a 404. */
export default async function ProjectPage(props: PageProps<"/projects/[slug]">) {
  const { slug } = await props.params;
  const p = await getPublicProject(slug);
  if (!p) {
    await redirectIfMoved(`/projects/${slug}`);
    notFound();
  }
  const t = pages.projects;
  const [{ code, rates }, market, contact, integrations, leadSettings] = await Promise.all([
    visitorCurrency(),
    getSettings("market"),
    getSettings("contact"),
    getSettings("integrations"),
    getSettings("leads"),
  ]);
  const ctx = {
    visitorCurrency: code,
    rates,
    areaUnit: market.areaUnit,
    distanceUnit: market.distanceUnit,
  };
  const [cover, ...gallery] = p.photos;
  const area = p.locationPath.at(-1);
  const currency: Rates["base"] = formatFor(p.currency || market.baseCurrency.code, {
    [market.baseCurrency.code]: market.baseCurrency,
    ...Object.fromEntries(market.visitorCurrencies.map((c) => [c.code, c])),
  });
  const mapsStyle = resolveMapStyle(integrations.googleMaps).styleUrl;
  const nearbyGroups = poiCategories
    .map((c) => ({ category: c, items: p.nearby.filter((n) => n.category === c) }))
    .filter((g) => g.items.length > 0);

  return (
    <article className="pb-16">
      <div className="container-site flex flex-col gap-4 pt-6">
        <Breadcrumb
          items={[
            { label: pages.common.home, href: "/" },
            { label: t.title, href: "/projects" },
            { label: p.name },
          ]}
          baseUrl={siteOrigin()}
        />
        <JsonLd data={projectStructuredData(p, market, siteOrigin(), projectDescription(p))} />
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-surface px-3 py-1 text-[12.5px] font-semibold text-ink shadow-soft">
              {t.statuses[p.status]}
            </span>
            {p.planLabel && (
              <span className="rounded-full bg-ink px-3 py-1 text-[12.5px] font-semibold text-surface">
                {p.planLabel}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-display">{p.name}</h1>
            <SaveHomeButton projectId={p.id} label={p.name} variant="page" />
          </div>
          {(p.developer || area) && (
            <p className="text-lg text-text">
              {[
                p.developer?.name,
                p.locationPath
                  .map((l) => l.name)
                  .reverse()
                  .join(", "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
        </header>
        {cover && (
          <MediaImage
            src={cover.url}
            alt={cover.alt}
            sizes="(min-width: 1280px) 1200px, 100vw"
            aspect="16 / 9"
            color={cover.color}
            priority
            className="rounded-[24px]"
          />
        )}
      </div>

      <div className="container-site mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-12">
          <section aria-labelledby="facts">
            <h2 id="facts" className="sr-only">
              {t.keyFacts}
            </h2>
            <dl className="grid grid-cols-2 gap-6 rounded-[20px] bg-surface p-6 shadow-soft md:grid-cols-4">
              {p.developer && <Fact label={t.factDeveloper}>{p.developer.name}</Fact>}
              {area && <Fact label={t.factLocation}>{area.name}</Fact>}
              {p.handover && <Fact label={t.factHandover}>{handoverLabel(p.handover)}</Fact>}
              <Fact label={t.factStartingPrice}>
                <PriceTag
                  price={p.startingPrice}
                  currency={p.currency || market.baseCurrency.code}
                  visitorCurrency={code}
                  rates={rates}
                  onRequestText={t.priceOnRequest}
                />
              </Fact>
              {p.planLabel && <Fact label={t.factPlan}>{p.planLabel}</Fact>}
              <Fact label={t.factStatus}>{t.statuses[p.status]}</Fact>
              {p.progress != null && (
                <Fact label={t.factProgress}>
                  <span className="flex flex-col gap-1.5">
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted"
                        aria-hidden
                      >
                        <span
                          className="block h-full rounded-full bg-success"
                          style={{ width: `${p.progress}%` }}
                        />
                      </span>
                      <span className="tabular">{p.progress}%</span>
                    </span>
                    {p.progressUpdatedAt && (
                      <span className="text-[12.5px] font-normal text-text-muted">
                        {format(t.progressUpdated, {
                          date: dateFormat.format(new Date(p.progressUpdatedAt)),
                        })}
                      </span>
                    )}
                  </span>
                </Fact>
              )}
              {p.totalUnits != null && <Fact label={t.factUnits}>{p.totalUnits}</Fact>}
            </dl>
          </section>

          {(p.descriptionHtml || p.highlights.length > 0) && (
            <section aria-labelledby="about" className="flex flex-col gap-4">
              <h2 id="about" className="text-h2">
                {t.about}
              </h2>
              {p.descriptionHtml && (
                <div
                  className="rich-text max-w-prose text-[16px] leading-relaxed text-text"
                  // Rendered on the server from the editor's allowlisted JSON (lib/rich-text).
                  dangerouslySetInnerHTML={{ __html: p.descriptionHtml }}
                />
              )}
              {p.highlights.length > 0 && (
                <>
                  <h3 className="text-[17px] font-semibold text-ink">{t.highlights}</h3>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {p.highlights.map((h) => (
                      <li key={h} className="flex items-start gap-2 text-[15px] text-text">
                        <span
                          className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
                          aria-hidden
                        />
                        {h}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}

          {p.unitTypes.length > 0 && (
            <section aria-labelledby="units" className="flex flex-col gap-4">
              <h2 id="units" className="text-h2">
                {t.unitTypes}
              </h2>
              <div className="overflow-x-auto rounded-[20px] bg-surface shadow-soft">
                <table className="w-full text-start text-[14.5px]">
                  <thead className="border-b border-border text-[12.5px] text-text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-3 text-start font-semibold">
                        {t.unitType}
                      </th>
                      <th scope="col" className="px-4 py-3 text-start font-semibold">
                        {t.beds}
                      </th>
                      <th scope="col" className="px-4 py-3 text-start font-semibold">
                        {t.size}
                      </th>
                      <th scope="col" className="px-4 py-3 text-start font-semibold">
                        {t.priceFrom}
                      </th>
                      <th scope="col" className="px-4 py-3 text-start font-semibold">
                        {t.floorPlan}
                      </th>
                      <th scope="col" className="px-4 py-3">
                        <span className="sr-only">{t.enquire}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.unitTypes.map((u) => (
                      <tr key={u.id} className="border-b border-border last:border-0">
                        <th scope="row" className="px-4 py-3 text-start font-semibold text-ink">
                          {u.name}
                          {u.availableCount != null && (
                            <span className="block text-[12.5px] font-normal text-text-muted">
                              {format(t.available, { count: u.availableCount })}
                            </span>
                          )}
                        </th>
                        <td className="px-4 py-3">
                          {u.beds == null ? "—" : u.beds === 0 ? t.studio : u.beds}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {sizeRange(u.sizeMin, u.sizeMax, market.areaUnit)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {u.priceFrom != null ? (
                            <PriceTag
                              price={u.priceFrom}
                              currency={p.currency || market.baseCurrency.code}
                              visitorCurrency={code}
                              rates={rates}
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {u.floorPlanUrl ? (
                            <a
                              href={u.floorPlanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-ink underline underline-offset-2"
                            >
                              {t.viewPlan}
                              <span className="sr-only">: {u.name}</span>
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 text-end">
                          <div className="flex items-center justify-end gap-3">
                            {/* Unit types can be compared side by side too (11 §3). */}
                            <CompareButton propertyId={u.id} label={`${p.name} · ${u.name}`} />
                            <a
                              href="#contact"
                              className="font-semibold text-accent underline-offset-2 hover:underline"
                            >
                              {t.enquire}
                              <span className="sr-only">: {u.name}</span>
                            </a>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {p.listings.length > 0 && (
            <section aria-labelledby="listings" className="flex flex-col gap-4">
              <h2 id="listings" className="text-h2">
                {t.listings}
              </h2>
              <ul className="grid gap-6 sm:grid-cols-2">
                {p.listings.map((l) => (
                  <li key={l.id}>
                    <ListingCard listing={l} ctx={ctx} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.plan && (
            <div className="rounded-[20px] bg-surface p-6 shadow-soft">
              <PaymentPlanView
                steps={p.plan.steps}
                summaryLabel={p.plan.summaryLabel}
                notes={p.plan.notes}
                headingLevel={2}
                price={p.startingPrice ? { amount: p.startingPrice, currency } : null}
                scheduleHref={`/api/brochure/project/${p.id}/schedule`}
              />
            </div>
          )}

          {p.facilities.length > 0 && (
            <section aria-labelledby="amenities" className="flex flex-col gap-4">
              <h2 id="amenities" className="text-h2">
                {t.amenities}
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {p.facilities.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center gap-2 rounded-[14px] bg-surface px-3 py-2.5 text-[14.5px] text-ink shadow-soft"
                  >
                    <Icon name={f.icon} className="size-4.5 shrink-0 text-accent" />
                    {f.name}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.point && (
            <section aria-labelledby="location" className="flex flex-col gap-4">
              <h2 id="location" className="text-h2">
                {t.location}
              </h2>
              <PlaceMap
                center={p.point}
                styleUrl={mapsStyle}
                label={format(pages.map.label, { name: p.name })}
                places={p.nearby.flatMap((n) =>
                  n.point ? [{ id: n.id, name: n.name, point: n.point }] : [],
                )}
              />
              {nearbyGroups.length === 0 ? (
                <p className="text-[14px] text-text-muted">{t.nearbyEmpty}</p>
              ) : (
                <div className="grid gap-6 sm:grid-cols-2">
                  {nearbyGroups.map((g) => (
                    <div key={g.category}>
                      <h3 className="mb-2 text-[15px] font-semibold text-ink">
                        {pages.nearby.categories[g.category]}
                      </h3>
                      <ul className="flex flex-col gap-1.5 text-[14.5px]">
                        {g.items.map((n) => (
                          <li key={n.id} className="flex justify-between gap-3">
                            <span className="text-ink">
                              {n.name}
                              <span className="block text-[12.5px] text-text-muted">
                                {n.typeName}
                              </span>
                            </span>
                            <span className="shrink-0 text-end text-text-muted tabular">
                              {n.overrideText ??
                                (n.seconds
                                  ? `${formatDuration(n.seconds)} ${n.mode === "walk" ? pages.nearby.walk : pages.nearby.drive}`
                                  : formatDistance(n.distanceM, market.distanceUnit))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {gallery.length > 0 && (
            <section aria-labelledby="gallery" className="flex flex-col gap-4">
              <h2 id="gallery" className="text-h2">
                {t.gallery}
              </h2>
              <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {gallery.map((g) => (
                  <li key={g.url}>
                    <a href={g.url} target="_blank" rel="noopener noreferrer" className="block">
                      <MediaImage
                        src={g.url}
                        alt={g.alt}
                        sizes="(min-width: 768px) 30vw, 50vw"
                        color={g.color}
                        className="rounded-[16px]"
                        maxWidth={1080}
                      />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.masterPlan && (
            <section aria-labelledby="master-plan" className="flex flex-col gap-4">
              <h2 id="master-plan" className="text-h2">
                {t.masterPlan}
              </h2>
              {p.masterPlan.isPdf ? (
                <a
                  href={p.masterPlan.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[15px] font-semibold text-ink underline underline-offset-4"
                >
                  {t.masterPlan} (PDF)
                </a>
              ) : (
                <MediaImage
                  src={p.masterPlan.url}
                  alt={p.masterPlan.alt}
                  sizes="(min-width: 1024px) 800px, 100vw"
                  aspect="4 / 3"
                  fit="contain"
                  className="rounded-[20px] bg-surface"
                />
              )}
            </section>
          )}

          <ul className="flex flex-wrap gap-3 print:hidden">
            <li>
              {/* The uploaded brochure, else one made from the project (11 §4). */}
              <BrochureButton
                kind="project"
                id={p.id}
                href={brochurePath("project", p.id)}
                gated={leadSettings.brochureEmailGate}
                label={t.brochure}
                subject={p.name}
                className="inline-flex h-11 items-center gap-2 rounded-button bg-ink px-5 text-[15px] font-semibold text-surface"
              />
            </li>
            {p.videoUrl && (
              <li>
                <a
                  href={p.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center rounded-button border border-ink/20 px-5 text-[15px] font-semibold text-ink"
                >
                  {t.video}
                </a>
              </li>
            )}
            {p.tourUrl && (
              <li>
                <a
                  href={p.tourUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center rounded-button border border-ink/20 px-5 text-[15px] font-semibold text-ink"
                >
                  {t.tour}
                </a>
              </li>
            )}
          </ul>

          {p.developer && (
            <section
              aria-labelledby="developer"
              className="flex flex-col gap-4 rounded-[20px] bg-surface p-6 shadow-soft sm:flex-row sm:items-start"
            >
              {p.developer.logo && (
                <div className="flex h-16 w-32 shrink-0 items-center justify-center">
                  <MediaImage
                    src={p.developer.logo.url}
                    alt=""
                    sizes="128px"
                    aspect="2 / 1"
                    fit="contain"
                    maxWidth={384}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <h2 id="developer" className="text-[18px] font-semibold text-ink">
                  {t.developerCard}: {p.developer.name}
                </h2>
                {p.developer.description && (
                  <p className="line-clamp-4 text-[15px] text-text">{p.developer.description}</p>
                )}
                <a
                  href={`/developers/${p.developer.slug}`}
                  className="text-[15px] font-semibold text-ink underline underline-offset-4"
                >
                  {format(t.developerLink, { name: p.developer.name })}
                </a>
              </div>
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-3 lg:sticky lg:top-24 lg:self-start">
          <BookTourButton
            projectId={p.id}
            subject={p.name}
            agentName={(await getSettings("general")).agencyName}
          />
          <ContactCard
            id="contact"
            entity={{ type: "project", id: p.id }}
            subject={p.name}
            pageUrl={siteUrl(`/projects/${p.slug}`)}
            whatsapp={contact.whatsapp}
            phone={contact.phone}
            email={contact.email}
          />
        </aside>
      </div>

      {p.similar.length > 0 && (
        <section aria-labelledby="similar" className="container-site mt-16 flex flex-col gap-6">
          <h2 id="similar" className="text-h2">
            {t.similar}
          </h2>
          <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {p.similar.map((s) => (
              <li key={s.id} className="flex">
                <ProjectCard project={s} visitorCurrency={code} rates={rates} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
