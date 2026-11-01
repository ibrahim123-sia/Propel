import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { Badge } from "@/components/site/badge-chip";
import { Breadcrumb, type Crumb } from "@/components/site/breadcrumb";
import { JsonLd } from "@/components/site/json-ld";
import { ListingCard, type CardContext } from "@/components/site/listings/listing-card";
import { PaymentPlanView } from "@/components/payment-plan/plan-view";
import { resolveMapStyle } from "@/components/maps/map-style";
import {
  About,
  DetailsTable,
  Facilities,
  FactsBar,
  Investment,
  PriceHistory,
  ProjectBlock,
  RentPayments,
  Section,
  StatusBanner,
  type PageContext,
} from "@/components/site/property/blocks";
import { ContactBottomBar, type ContactInfo } from "@/components/site/property/contact-actions";
import { ContactCard } from "@/components/site/property/contact-card";
import { Gallery } from "@/components/site/property/gallery";
import { ListingMap } from "@/components/site/property/listing-map";
import { MortgageMini } from "@/components/site/property/mortgage-mini";
import { PriceTrendsSection } from "@/components/site/price-trends/price-trends";
import { NearbyList } from "@/components/site/property/nearby-list";
import { RecentlyViewed } from "@/components/site/property/recently-viewed";
import { TrackListingView } from "@/components/site/visitor-tracker";
import { CompareButton } from "@/components/site/account/compare-button";
import { SaveHomeButton } from "@/components/site/account/save-home-button";
import { SharePrint } from "@/components/site/property/share-print";
import { brochurePath } from "@/features/brochure/paths";
import { getPublicListing, listingRedirect, type PublicListing } from "@/features/listings/public";
import { similarListings } from "@/features/listings/similar";
import { listingStructuredData, listingTitle } from "@/features/seo/entity-seo";
import { getSettings } from "@/features/settings/queries";
import { visitorCurrency } from "@/features/site/currency";
import { mortgageLinkFor, roiLinkFor } from "@/features/tools/calculator-params";
import { displayPrice, toBaseMinor } from "@/lib/currency-display";
import { areaFromSqm, perAreaFromSqm } from "@/lib/units";
import { format } from "@/lib/i18n";
import { Icon } from "@/lib/icons";
import { property as t } from "@/lib/i18n/dictionaries/property";
import { redirectIfMoved } from "@/features/seo/serve";
import { shareImage } from "@/features/og/cards";

/** Per request: the slug (and the visitor's currency cookie) decide what renders; data is cached. */
export const instant = false;

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** "Garden villa · Pier Seven, 7 Quay Road, Old Harbour, Coastal City" — never the unit number. */
/** Building, address and the place path, each name once ("Dubai Marina" is often in all three). */
function addressLine(l: PublicListing): string {
  const places = [...l.places].reverse().map((p) => p.name);
  const parts = [l.buildingName, ...(l.addressLine ?? "").split(","), ...places]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const seen = new Set<string>();
  return parts.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(", ");
}

export async function generateMetadata(props: PageProps<"/property/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const l = await getPublicListing(slug);
  if (!l) {
    // Checked here too: metadata is resolved before the page streams, so bots get a real 308.
    await redirectIfMoved(`/property/${slug}`);
    return {};
  }
  const [seo, market, general] = await Promise.all([
    getSettings("seo"),
    getSettings("market"),
    getSettings("general"),
  ]);
  const title = listingTitle(l, seo.listingTitlePattern, market, general.agencyName);
  const description = (l.seo.description || l.descriptionText).slice(0, 160) || undefined;
  const canonical = l.seo.canonicalUrl || `/property/${l.slug}`;
  const images = await shareImage("property", l.slug, l.seo.chosenOgImageUrl);
  return {
    title,
    description,
    alternates: { canonical },
    robots: l.seo.noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      images,
    },
    twitter: { card: "summary_large_image", title, description, images: images.map((i) => i.url) },
  };
}

export default async function PropertyPage(props: PageProps<"/property/[slug]">) {
  const { slug } = await props.params;
  const listing = await getPublicListing(slug);
  if (!listing) {
    const moved = await listingRedirect(slug);
    if (moved) (moved.permanent ? permanentRedirect : redirect)(moved.to);
    notFound();
  }
  const l = listing;
  const [{ code, rates }, market, contact, general, integrations, leadSettings] = await Promise.all(
    [
      visitorCurrency(),
      getSettings("market"),
      getSettings("contact"),
      getSettings("general"),
      getSettings("integrations"),
      getSettings("leads"),
    ],
  );
  const ctx: PageContext = {
    visitorCurrency: code,
    rates,
    areaUnit: market.areaUnit,
    permitLabel: market.permit.label,
    permitsEnabled: market.permit.enabled,
  };
  const cardCtx: CardContext = {
    visitorCurrency: code,
    rates,
    areaUnit: market.areaUnit,
    distanceUnit: market.distanceUnit,
  };
  const url = `${appUrl()}/property/${l.slug}`;
  const whatsapp = (l.agent?.whatsapp || contact.whatsapp || "").replace(/\D/g, "");
  const info: ContactInfo = {
    propertyId: l.id,
    reference: l.reference,
    whatsappHref: whatsapp
      ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(format(t.contact.whatsappText, { ref: l.reference, url }))}`
      : null,
    phone: l.agent?.phone || contact.phone || null,
    // Every live listing has a brochure: the uploaded one, else one made from the listing.
    brochureUrl: brochurePath("property", l.id),
    brochureGated: leadSettings.brochureEmailGate,
    title: l.title,
    agentName: l.agent?.name.split(/\s+/)[0] ?? general.agencyName,
  };
  const similar = await similarListings(l);
  const gone = l.status === "sold" || l.status === "rented";
  const purposeRoot = l.purpose === "rent" ? "/rent" : "/buy";
  const crumbs: Crumb[] = [
    { label: t.breadcrumb.home, href: "/" },
    { label: l.purpose === "rent" ? t.breadcrumb.rent : t.breadcrumb.sale, href: purposeRoot },
    ...l.places
      .filter((p) => p.level !== "building")
      .map((p) => ({ label: p.name, href: `${purposeRoot}/${p.slug}` })),
    { label: l.title },
  ];
  const listedFormat =
    l.currency === rates.base.code ? rates.base : rates.others.find((c) => c.code === l.currency);
  const mapStyle = resolveMapStyle(integrations.googleMaps);
  // The calculators work in the base currency and the market's area unit (11 §1, §2).
  const toBase = (v: number | null) => (v == null ? null : toBaseMinor(v, l.currency, rates));
  const basePrice = toBase(l.price);
  const decimals = rates.base.decimals;
  const mortgageHref =
    basePrice != null
      ? mortgageLinkFor({ price: basePrice, reference: l.reference }, decimals)
      : null;
  const roiHref =
    basePrice != null
      ? roiLinkFor(
          {
            price: basePrice,
            reference: l.reference,
            rentYearly: toBase(l.expectedRentYearly),
            size: l.size != null ? areaFromSqm(l.size, market.areaUnit) : null,
            serviceChargePerArea: toBase(
              l.serviceChargePerArea != null
                ? perAreaFromSqm(l.serviceChargePerArea, market.areaUnit)
                : null,
            ),
          },
          decimals,
        )
      : null;

  const similarSection = (
    <Section id="similar" title={t.similar.title}>
      {similar.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {similar.map((c) => (
            <ListingCard key={c.id} listing={c} ctx={cardCtx} />
          ))}
        </div>
      ) : (
        <p className="text-[15px] text-text-muted">{t.similar.none}</p>
      )}
    </Section>
  );

  return (
    <>
      <div className="container-wide flex flex-col gap-6 pt-6 pb-28 lg:pb-16">
        <Breadcrumb items={crumbs} baseUrl={appUrl()} />
        <JsonLd data={listingStructuredData(l, market, appUrl())} />

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            {l.badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {l.badges.map((b) => (
                  <Badge
                    key={b.name}
                    name={b.name}
                    color={b.color}
                    textColor={b.textColor}
                    icon={b.icon}
                  />
                ))}
              </div>
            )}
            <h1 className="text-h1 text-ink">{l.title}</h1>
            <p className="text-[15px] text-text-muted">{addressLine(l)}</p>
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            <SaveHomeButton propertyId={l.id} label={l.title} variant="page" />
            <CompareButton propertyId={l.id} label={l.title} />
            <SharePrint title={l.title} url={url} />
          </div>
        </header>

        <StatusBanner listing={l} />
        {gone && similarSection}

        <Gallery listing={l} />

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-10">
            <FactsBar listing={l} ctx={ctx} />
            <About listing={l} />
            <DetailsTable listing={l} ctx={ctx} />
            <Facilities listing={l} />
            {l.plan && (
              <Section id="plan" title={t.plan.title}>
                <PaymentPlanView
                  headingLevel={3}
                  scheduleHref={`/api/brochure/property/${l.id}/schedule`}
                  steps={l.plan.steps}
                  summaryLabel={l.plan.summaryLabel}
                  notes={l.plan.notes}
                  price={
                    l.price != null && listedFormat
                      ? { amount: l.price, currency: listedFormat }
                      : null
                  }
                />
              </Section>
            )}
            <RentPayments listing={l} ctx={ctx} />
            {(l.point || l.nearby.length > 0) && (
              <Section id="location" title={t.location.title}>
                {l.point && (
                  <ListingMap point={l.point} styleUrl={mapStyle.styleUrl} label={t.location.map} />
                )}
                {l.point?.approx && (
                  <p className="text-[13.5px] text-text-muted">{t.location.approx}</p>
                )}
                <NearbyList
                  places={l.nearby}
                  distanceUnit={market.distanceUnit}
                  icons={Object.fromEntries(
                    [...new Set(l.nearby.map((p) => p.typeIcon ?? ""))].map((name) => [
                      name,
                      <Icon key={name} name={name || null} className="size-4 text-accent" />,
                    ]),
                  )}
                />
              </Section>
            )}
            {l.purpose === "sale" && l.price != null && !gone && (
              <Section id="mortgage" title={t.mortgage.title}>
                <MortgageMini
                  price={l.price}
                  currency={l.currency}
                  visitorCurrency={code}
                  rates={rates}
                  defaults={market.mortgage}
                  calculatorHref={mortgageHref}
                />
              </Section>
            )}
            {l.purpose === "rent" && l.price != null && !gone && (
              <p className="flex flex-wrap items-center gap-2 rounded-[16px] bg-accent-soft px-5 py-4 text-[14.5px] text-ink">
                {format(t.mortgage.rentHint, {
                  amount: displayPrice(
                    l.pricePeriod === "month" ? l.price * 12 : l.price,
                    l.currency,
                    code,
                    rates,
                  ).text,
                })}
                <Link
                  href="/tools/mortgage"
                  prefetch={false}
                  className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
                >
                  {t.mortgage.rentLink}{" "}
                  <ArrowRightIcon className="size-4 rtl:rotate-180" aria-hidden />
                </Link>
              </p>
            )}
            <Investment listing={l} ctx={ctx} roi={market.roi} simulatorHref={roiHref} />
            <PriceHistory listing={l} ctx={ctx} />
            {l.locationId && (
              <Suspense fallback={null}>
                <PriceTrendsSection
                  locationId={l.locationId}
                  typeSlug={l.type?.slug ?? null}
                  only={l.purpose}
                  small
                />
              </Suspense>
            )}
            <ProjectBlock listing={l} />
          </div>
          <div className="lg:sticky lg:top-24 lg:self-start">
            <ContactCard listing={l} ctx={ctx} info={info} agencyName={general.agencyName} />
          </div>
        </div>

        {!gone && similarSection}
        <RecentlyViewed currentId={l.id} ctx={cardCtx} />
        <TrackListingView propertyId={l.id} />
      </div>
      {!gone && <ContactBottomBar info={info} />}
    </>
  );
}
