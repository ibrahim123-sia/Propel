import "server-only";
import { getDb } from "@/db/client";
import { loadEmailBrand, type EmailBrand } from "@/emails/brand";
import { getPublicGuide } from "@/features/area-guides/public";
import { getPublicPost } from "@/features/blog/public";
import { getPublicListing } from "@/features/listings/public";
import { currencyFormats, formatFor, priceLabel } from "@/features/properties/format";
import { getPublicProject } from "@/features/projects/public";
import { getSettings } from "@/features/settings/queries";
import { mediaVariant } from "@/lib/media-src";
import { formatMoney } from "@/lib/money";
import { formatArea } from "@/lib/units";
import { shareCardVersion, type ShareCardData } from "./share-card";

/** What each kind of page puts on its share card (11 §10). */

export const shareCardKinds = ["property", "project", "area", "post"] as const;
export type ShareCardKind = (typeof shareCardKinds)[number];

/** The library address of the photo; the route inlines it when drawing (inline-media.ts). */
const photo = (url: string | null | undefined) => url ?? null;

async function propertyCard(slug: string): Promise<ShareCardData | null> {
  const l = await getPublicListing(slug);
  if (!l) return null;
  const market = await getSettings("market");
  const beds =
    l.beds === null ? null : l.beds === 0 ? "Studio" : `${l.beds} bed${l.beds === 1 ? "" : "s"}`;
  const verified = l.badges.find((b) => /verified/i.test(b.name));
  return {
    image: photo(l.photos[0]?.url),
    eyebrow:
      [...l.places]
        .reverse()
        .slice(0, 2)
        .map((p) => p.name)
        .join(", ") || null,
    title: l.title,
    highlight: priceLabel({ ...l, priceOnRequest: l.price === null }, currencyFormats(market)),
    facts: [
      beds,
      l.baths ? `${l.baths} bath${l.baths === 1 ? "" : "s"}` : null,
      l.size ? formatArea(l.size, market.areaUnit) : null,
      l.type?.name ?? null,
    ].filter((x): x is string => Boolean(x)),
    badge: verified?.name ?? l.badges[0]?.name ?? null,
  };
}

const projectStatus = {
  announced: "Announced",
  under_construction: "Under construction",
  completed: "Completed",
} as const;

async function projectCard(slug: string): Promise<ShareCardData | null> {
  const p = await getPublicProject(slug);
  if (!p) return null;
  const market = await getSettings("market");
  return {
    image: photo(p.photos[0]?.url),
    eyebrow: [p.developer?.name, p.locationPath.at(-1)?.name].filter(Boolean).join(" · ") || null,
    title: p.name,
    highlight:
      p.startingPrice !== null
        ? `From ${formatMoney(p.startingPrice, formatFor(p.currency, currencyFormats(market)))}`
        : null,
    facts: [
      p.handover ? `Handover ${p.handover}` : null,
      p.planLabel ? `${p.planLabel} plan` : null,
      p.unitTypesSummary,
    ].filter((x): x is string => Boolean(x)),
    badge: projectStatus[p.status],
  };
}

async function areaCard(slug: string): Promise<ShareCardData | null> {
  const g = await getPublicGuide(slug);
  if (!g) return null;
  return {
    image: photo(g.cover?.url),
    eyebrow: g.location.parentName ? `Area guide · ${g.location.parentName}` : "Area guide",
    title: g.title,
    highlight: null,
    facts: [
      g.counts.sale ? `${g.counts.sale} for sale` : null,
      g.counts.rent ? `${g.counts.rent} to rent` : null,
    ].filter((x): x is string => Boolean(x)),
    badge: null,
  };
}

async function postCard(slug: string): Promise<ShareCardData | null> {
  const p = await getPublicPost(slug);
  if (!p) return null;
  return {
    image: photo(p.cover?.url),
    eyebrow: p.category?.name ?? "Insights",
    title: p.title,
    highlight: null,
    facts: [`${p.readingMinutes} min read`, p.author?.name ?? null].filter((x): x is string =>
      Boolean(x),
    ),
    badge: null,
  };
}

const loaders: Record<ShareCardKind, (slug: string) => Promise<ShareCardData | null>> = {
  property: propertyCard,
  project: projectCard,
  area: areaCard,
  post: postCard,
};

export async function loadShareCard(
  kind: ShareCardKind,
  slug: string,
): Promise<{ data: ShareCardData | null; brand: EmailBrand; version: string | null }> {
  const brand = await loadEmailBrand(await getDb());
  const data = await loaders[kind](slug);
  return { data, brand, version: data ? await shareCardVersion(data, brand) : null };
}

/** og:image for a page: the admin's chosen share image wins, else the generated card. */
export async function shareImage(
  kind: ShareCardKind,
  slug: string,
  chosen?: string | null,
): Promise<Array<{ url: string; width: number; height?: number; alt?: string }>> {
  if (chosen) return [{ url: mediaVariant(chosen, 1200), width: 1200 }];
  const { data, version } = await loadShareCard(kind, slug);
  if (!data || !version) return [];
  return [{ url: `/og/${kind}/${slug}?v=${version}`, width: 1200, height: 630, alt: data.title }];
}
