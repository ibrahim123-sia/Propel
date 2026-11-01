import { search as t } from "@/lib/i18n/dictionaries/search";
import { format } from "@/lib/i18n";
import { formatMoney, type CurrencyFormat } from "@/lib/money";
import { areaUnitLabels, type AreaUnit } from "@/lib/units";
import { PAGE_SIZE, searchHref, searchPath, type SearchFilters } from "./params";

/**
 * Words for a search, from data the server looked up (06 §4.1 H1, filter chips, no-results
 * help). Pure: shared by the server page and the client filters.
 */
export type SearchLabels = {
  /** Location slug or `p.<project-slug>` -> name. */
  places: Record<string, string>;
  /** Type slug -> name as entered (singular). */
  types: Record<string, string>;
  facilities: Record<string, string>;
  /** Manual badge id -> name. */
  badges: Record<string, string>;
  agent: string | null;
  /** The commute filter's place (11 §9). */
  commutePlace?: string | null;
};

export const emptyLabels = (): SearchLabels => ({
  places: {},
  types: {},
  facilities: {},
  badges: {},
  agent: null,
});

/** "Apartment" -> "Apartments", "Penthouse" -> "Penthouses", "Office" -> "Offices". */
export function pluralType(name: string): string {
  const n = name.trim();
  if (!n) return n;
  if (/(s|x|z|ch|sh)$/i.test(n)) return `${n}es`;
  if (/[^aeiou]y$/i.test(n)) return `${n.slice(0, -1)}ies`;
  return `${n}s`;
}

function placeText(f: SearchFilters, labels: SearchLabels): string | null {
  if (f.poly && f.loc.length === 0) return t.heading.drawnArea;
  const names = f.loc.map((l) => labels.places[l]).filter(Boolean) as string[];
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return format(t.heading.and, { a: names[0]!, b: names[1]! });
  return format(t.heading.andMore, { first: names[0]!, count: names.length - 1 });
}

/** The generated H1, e.g. "Apartments for sale in Dubai Marina" (06 §4.1). */
export function searchHeading(f: SearchFilters, labels: SearchLabels): string {
  const typeNames = f.type.map((s) => labels.types[s]).filter(Boolean) as string[];
  const offPlan = f.completion === "off_plan" && f.purpose === "sale";
  const types =
    typeNames.length === 1
      ? pluralType(typeNames[0]!)
      : offPlan
        ? t.heading.homesOffPlan
        : t.heading.homes;
  const base = offPlan
    ? format(t.heading.offPlan, { types: typeNames.length === 1 ? types.toLowerCase() : types })
    : format(f.purpose === "rent" ? t.heading.rent : t.heading.sale, { types });
  const place = placeText(f, labels);
  return place ? format(t.heading.inPlace, { heading: base, place }) : base;
}

export function countText(total: number): string {
  if (total === 0) return t.count.none;
  if (total === 1) return t.count.one;
  return format(t.count.many, { count: total.toLocaleString("en") });
}

export function showingText(total: number, page: number): string {
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return format(t.count.showing, {
    from: from.toLocaleString("en"),
    to: to.toLocaleString("en"),
    total: total.toLocaleString("en"),
  });
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

/** "AED 1.5M", "$750K": short money for chips and price pickers (major units). */
export function compactMoney(major: number, currency: CurrencyFormat): string {
  const amount = compact.format(major);
  if (currency.symbolPosition === "after") return `${amount} ${currency.symbol}`;
  return /^[A-Za-z]+$/.test(currency.symbol)
    ? `${currency.symbol} ${amount}`
    : `${currency.symbol}${amount}`;
}

export const fullMoney = (major: number, currency: CurrencyFormat) =>
  formatMoney(Math.round(major * 10 ** currency.decimals), currency);

export type Chip = {
  key: string;
  label: string;
  /** The same search without this filter. */
  remove: (f: SearchFilters) => SearchFilters;
};

const bedLabel = (b: number) =>
  b === 0
    ? t.filters.studio
    : b >= 5
      ? t.chips.bedsPlus
      : format(b === 1 ? t.chips.bedsOne : t.chips.bedsMany, { count: b });

/**
 * One chip per active filter beyond the route (06 §4.2 "active filter chips with ×").
 * Location and type chips appear only when they are not the landing route itself.
 */
export function searchChips(
  f: SearchFilters,
  labels: SearchLabels,
  units: { currency: CurrencyFormat; areaUnit: AreaUnit },
): Chip[] {
  const { preset } = searchPath(f);
  const chips: Chip[] = [];
  const reset = (patch: Partial<SearchFilters>) => (x: SearchFilters) => ({
    ...x,
    ...patch,
    page: 1,
  });
  if (f.completion && !preset?.completion)
    chips.push({
      key: "completion",
      label: f.completion === "off_plan" ? t.completion.offPlan : t.completion.ready,
      remove: reset({ completion: null }),
    });
  for (const l of f.loc) {
    if (preset?.loc?.includes(l)) continue;
    chips.push({
      key: `loc:${l}`,
      label: labels.places[l] ?? l,
      remove: (x) => ({ ...x, loc: x.loc.filter((v) => v !== l), page: 1 }),
    });
  }
  if (f.poly) chips.push({ key: "poly", label: t.chips.poly, remove: reset({ poly: null }) });
  if (f.commute && labels.commutePlace)
    chips.push({
      key: "commute",
      label: format(t.commute.chip, {
        minutes: f.commute.minutes,
        mode: f.commute.mode === "walk" ? t.commute.walk : t.commute.drive,
        place: labels.commutePlace,
      }),
      remove: reset({ commute: null }),
    });
  for (const s of f.type) {
    if (preset?.type?.includes(s)) continue;
    chips.push({
      key: `type:${s}`,
      label: pluralType(labels.types[s] ?? s),
      remove: (x) => ({ ...x, type: x.type.filter((v) => v !== s), page: 1 }),
    });
  }
  if (f.min !== null || f.max !== null) {
    const c = units.currency;
    const label =
      f.min !== null && f.max !== null
        ? format(t.chips.price, { min: compactMoney(f.min, c), max: compactMoney(f.max, c) })
        : f.min !== null
          ? format(t.chips.priceFrom, { min: compactMoney(f.min, c) })
          : format(t.chips.priceTo, { max: compactMoney(f.max!, c) });
    chips.push({ key: "price", label, remove: reset({ min: null, max: null }) });
  }
  if (f.beds.length)
    chips.push({
      key: "beds",
      label: f.beds.map(bedLabel).join(", "),
      remove: reset({ beds: [] }),
    });
  if (f.baths !== null)
    chips.push({
      key: "baths",
      label: format(t.chips.baths, { count: f.baths }),
      remove: reset({ baths: null }),
    });
  if (f.smin !== null || f.smax !== null) {
    const u = areaUnitLabels[units.areaUnit];
    const n = (v: number) => `${v.toLocaleString("en")} ${u}`;
    const label =
      f.smin !== null && f.smax !== null
        ? format(t.chips.size, { min: n(f.smin), max: n(f.smax) })
        : f.smin !== null
          ? format(t.chips.sizeFrom, { min: n(f.smin) })
          : format(t.chips.sizeTo, { max: n(f.smax!) });
    chips.push({ key: "size", label, remove: reset({ smin: null, smax: null }) });
  }
  if (f.furn) chips.push({ key: "furn", label: f.furn, remove: reset({ furn: null }) });
  for (const id of f.fac)
    chips.push({
      key: `fac:${id}`,
      label: labels.facilities[id] ?? t.filters.facilities,
      remove: (x) => ({ ...x, fac: x.fac.filter((v) => v !== id), page: 1 }),
    });
  for (const b of f.badge)
    chips.push({
      key: `badge:${b}`,
      label:
        b === "verified"
          ? t.filters.verified
          : b === "price_reduced"
            ? t.filters.priceReduced
            : b === "new_listing"
              ? t.filters.newListing
              : (labels.badges[b] ?? b),
      remove: (x) => ({ ...x, badge: x.badge.filter((v) => v !== b), page: 1 }),
    });
  if (f.handover)
    chips.push({
      key: "handover",
      label: format(t.chips.handover, { when: f.handover.replace("-", " ") }),
      remove: reset({ handover: null }),
    });
  if (f.plan)
    chips.push({
      key: "plan",
      label: f.plan === "post_handover" ? t.filters.planPostHandover : t.filters.planAny,
      remove: reset({ plan: null }),
    });
  if (f.cheques !== null)
    chips.push({
      key: "cheques",
      label: format(t.chips.cheques, { count: f.cheques }),
      remove: reset({ cheques: null }),
    });
  if (f.q)
    chips.push({ key: "q", label: format(t.chips.keyword, { q: f.q }), remove: reset({ q: "" }) });
  if (f.agent)
    chips.push({
      key: "agent",
      label: format(t.chips.agent, { name: labels.agent ?? f.agent }),
      remove: reset({ agent: null }),
    });
  return chips;
}

/** The search with every chip removed (keeps the route, sort and nothing else). */
export function clearedSearch(
  f: SearchFilters,
  labels: SearchLabels,
  units: Parameters<typeof searchChips>[2],
) {
  return searchChips(f, labels, units).reduce((acc, c) => c.remove(acc), { ...f, page: 1 });
}

export { searchHref };
