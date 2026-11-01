import { BathIcon, BedDoubleIcon, BadgeCheckIcon, MapPinIcon, RulerIcon } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/site/badge-chip";
import { MediaImage } from "@/components/site/media-image";
import { PriceTag } from "@/components/site/price-tag";
import type { ListingCardData } from "@/features/listings/cards";
import type { Rates } from "@/lib/currency-display";
import {
  formatArea,
  formatDistance,
  formatDuration,
  type AreaUnit,
  type DistanceUnit,
} from "@/lib/units";
import { SaveHomeButton } from "@/components/site/account/save-home-button";
import { format } from "@/lib/i18n";
import { search as t } from "@/lib/i18n/dictionaries/search";
import { VerifiedAgo } from "./verified-ago";

/** "Q3 2027" for a date; quarter texts as they are. */
export function handoverLabel(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-\d{2}$/);
  return m ? `Q${Math.ceil(Number(m[2]) / 3)} ${m[1]}` : value;
}

export const bedsText = (beds: number) =>
  beds === 0 ? "Studio" : `${beds} ${beds === 1 ? "bed" : "beds"}`;

export type CardContext = {
  visitorCurrency: string;
  rates: Rates;
  areaUnit: AreaUnit;
  distanceUnit: DistanceUnit;
};

/**
 * PropertyCard (vertical) and PropertyRow (horizontal, search list), 02 §4 and 06 §4.4.
 * The whole card opens the listing; photos swipe on phones. `data-listing-id` lets the search
 * page sync hovering with the map.
 */
export function ListingCard({
  listing: l,
  ctx,
  layout = "card",
  priority,
  sizes,
  headingLevel = 3,
}: {
  listing: ListingCardData;
  ctx: CardContext;
  layout?: "card" | "row";
  priority?: boolean;
  sizes?: string;
  headingLevel?: 2 | 3;
}) {
  const href = `/property/${l.slug}`;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const row = layout === "row";
  const photoSizes =
    sizes ??
    (row
      ? "(min-width: 768px) 320px, 100vw"
      : "(min-width: 1280px) 400px, (min-width: 768px) 50vw, 100vw");
  const nearby = l.nearby
    ? `${l.nearby.typeName} · ${
        l.nearby.seconds
          ? `${formatDuration(l.nearby.seconds)} ${l.nearby.mode === "walk" ? "walk" : "drive"}`
          : formatDistance(l.nearby.distanceM, ctx.distanceUnit)
      }`
    : null;

  return (
    <article
      data-listing-id={l.id}
      className={cn(
        "group relative overflow-hidden rounded-[20px] bg-surface shadow-soft transition-shadow hover:shadow-md",
        row ? "grid gap-0 sm:grid-cols-[minmax(0,20rem)_1fr]" : "flex flex-col",
      )}
    >
      {/* Above the title link's full-card overlay, so photos can be swiped. */}
      <div className="relative z-[1]">
        <div className="flex snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {(l.photos.length ? l.photos : [null]).map((p, i) => (
            <a
              key={p?.url ?? "empty"}
              href={href}
              tabIndex={-1}
              aria-hidden
              className="block w-full shrink-0 snap-start"
            >
              {p ? (
                <MediaImage
                  src={p.url}
                  alt=""
                  sizes={photoSizes}
                  color={p.color}
                  priority={priority && i === 0}
                  maxWidth={1080}
                  className={cn(row && "sm:h-full")}
                />
              ) : (
                <div className="aspect-[4/3] w-full bg-photo-placeholder" />
              )}
            </a>
          ))}
        </div>
        {l.badges.length > 0 && (
          <div className="pointer-events-none absolute start-3 top-3 flex flex-wrap gap-1.5">
            {l.badges.slice(0, 3).map((b) => (
              <Badge key={b.name} name={b.name} color={b.color} textColor={b.textColor} />
            ))}
          </div>
        )}
        <div className="absolute end-3 top-3">
          <SaveHomeButton propertyId={l.id} label={l.title} />
        </div>
        {l.photos.length > 1 && (
          <span className="pointer-events-none absolute end-3 bottom-3 rounded-full bg-ink/70 px-2 py-0.5 text-[11.5px] font-medium text-surface">
            {l.photos.length} photos
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2 p-4 sm:p-5">
        <PriceTag
          price={l.price}
          currency={l.currency}
          visitorCurrency={ctx.visitorCurrency}
          rates={ctx.rates}
          period={l.purpose === "rent" ? l.pricePeriod : null}
          className="text-[20px] md:text-[22px]"
        />
        <Heading className="font-display text-[18px] leading-snug font-medium text-ink md:text-[20px]">
          <a
            href={href}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {l.title}
          </a>
        </Heading>
        {l.locationName && (
          <p className="flex items-center gap-1 text-[13.5px] text-text-muted">
            <MapPinIcon className="size-3.5 shrink-0" aria-hidden />
            {l.locationName}
          </p>
        )}
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-text"
          aria-label="Key facts"
        >
          {l.beds != null && (
            <li className="flex items-center gap-1">
              <BedDoubleIcon className="size-4 text-text-muted" aria-hidden />
              {bedsText(l.beds)}
            </li>
          )}
          {l.baths != null && (
            <li className="flex items-center gap-1">
              <BathIcon className="size-4 text-text-muted" aria-hidden />
              {l.baths} {l.baths === 1 ? "bath" : "baths"}
            </li>
          )}
          {l.size != null && (
            <li className="flex items-center gap-1">
              <RulerIcon className="size-4 text-text-muted" aria-hidden />
              {formatArea(l.size, ctx.areaUnit)}
            </li>
          )}
        </ul>
        {(l.handover || nearby || l.verifiedAt || l.commute) && (
          <div className="mt-1 flex flex-col gap-1 text-[12.5px] text-text-muted">
            {l.commute && (
              <p className="font-medium text-ink">
                {format(l.commute.estimate ? t.commute.cardEstimate : t.commute.card, {
                  minutes: l.commute.minutes,
                  mode: l.commute.mode === "walk" ? t.commute.walk : t.commute.drive,
                  place: l.commute.place,
                })}
              </p>
            )}
            {l.handover && <p>Handover {handoverLabel(l.handover)}</p>}
            {nearby && <p>{nearby}</p>}
            {l.verifiedAt && (
              <p className="flex items-center gap-1 text-success">
                <BadgeCheckIcon className="size-3.5" aria-hidden />
                <VerifiedAgo iso={l.verifiedAt} />
              </p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
