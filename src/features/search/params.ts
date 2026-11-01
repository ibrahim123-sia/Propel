/**
 * Search filters as URL parameters (06 §4.2), so every search can be shared, bookmarked and
 * saved. Parsing is forgiving (bad values are dropped, never an error page); writing always
 * gives the same order, so equal searches have equal URLs (caching, canonical links).
 */

export const searchSorts = ["newest", "price_asc", "price_desc", "size", "ppa", "reduced"] as const;
export type SearchSort = (typeof searchSorts)[number];

export type SearchFilters = {
  purpose: "sale" | "rent";
  /** null: any. `/off-plan` presets off_plan. */
  completion: "ready" | "off_plan" | null;
  /** Location slugs, or `p.<project-slug>` for a project (from autocomplete). */
  loc: string[];
  /** Drawn area: one ring of [lng, lat] (06 §4.5). */
  poly: Array<[number, number]> | null;
  /** Commute time (11 §9): to one of the agency's places, by car or on foot, within N minutes. */
  commute: SearchCommute | null;
  /** Property type slugs. */
  type: string[];
  /** Price in major units of the base currency. */
  min: number | null;
  max: number | null;
  /** 0 = studio; 5 means 5 or more. */
  beds: number[];
  /** At least this many. */
  baths: number | null;
  /** Size in the market's area unit. */
  smin: number | null;
  smax: number | null;
  furn: string | null;
  /** Facility ids: listings must have all of them. */
  fac: string[];
  /** "verified", "price_reduced", "new_listing" or a badge id. */
  badge: string[];
  /** Off-plan handover by: "2027" or "2027-Q3". */
  handover: string | null;
  /** Has a payment plan, or a post-handover plan. */
  plan: "any" | "post_handover" | null;
  /** Rent can be paid in this many payments. */
  cheques: number | null;
  q: string;
  ref: string | null;
  /** Agent slug. */
  agent: string | null;
  sort: SearchSort;
  page: number;
};

export const PAGE_SIZE = 20;

export const commuteModes = ["drive", "walk"] as const;
export type CommuteMode = (typeof commuteModes)[number];
/** The minute limits the filter offers (11 §9: 5 to 60). */
export const commuteMinutes = [5, 10, 15, 20, 30, 45, 60] as const;

export type SearchCommute = { poi: string; mode: CommuteMode; minutes: number };

/** `commute=<poi id>.<drive|walk>.<minutes>` */
export function parseCommute(raw: string | undefined): SearchCommute | null {
  const m = /^([0-9a-f-]{36})\.(drive|walk)\.(\d{1,2})$/i.exec(raw ?? "");
  if (!m) return null;
  const minutes = Number(m[3]);
  if (!(commuteMinutes as readonly number[]).includes(minutes)) return null;
  return { poi: m[1]!.toLowerCase(), mode: m[2] as CommuteMode, minutes };
}

export const commuteParam = (c: SearchCommute) => `${c.poi}.${c.mode}.${c.minutes}`;

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function getAll(sp: Params, key: string): string[] {
  const raw =
    sp instanceof URLSearchParams
      ? sp.getAll(key)
      : Array.isArray(sp[key])
        ? (sp[key] as string[])
        : sp[key]
          ? [sp[key] as string]
          : [];
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}
const get = (sp: Params, key: string) => getAll(sp, key)[0];

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function num(v: string | undefined, { min = 0, max = 1e13 } = {}): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

const unique = <T>(list: T[]) => [...new Set(list)];

/* Drawn areas: Google's polyline encoding (precision 5), compact in a URL. --------------- */

export function encodePolygon(ring: Array<[number, number]>): string {
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  const enc = (v: number) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (value >= 0x20) {
      s += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return s + String.fromCharCode(value + 63);
  };
  for (const [lng, lat] of ring) {
    const la = Math.round(lat * 1e5);
    const ln = Math.round(lng * 1e5);
    out += enc(la - prevLat) + enc(ln - prevLng);
    prevLat = la;
    prevLng = ln;
  }
  return out;
}

export function decodePolygon(text: string): Array<[number, number]> | null {
  if (!text || text.length > 4000) return null;
  const points: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      if (index >= text.length) return null;
      b = text.charCodeAt(index++) - 63;
      if (b < 0 || b > 63) return null;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return null;
    lat += dLat;
    lng += dLng;
    const p: [number, number] = [lng / 1e5, lat / 1e5];
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) return null;
    points.push(p);
  }
  if (points.length < 3 || points.length > 200) return null;
  return points;
}

/* Parse and write --------------------------------------------------------------------- */

export function parseSearch(
  sp: Params,
  preset: Partial<Pick<SearchFilters, "purpose" | "completion" | "loc" | "type">> = {},
): SearchFilters {
  const purpose = preset.purpose ?? (get(sp, "purpose") === "rent" ? "rent" : "sale");
  const completionRaw = get(sp, "completion");
  const completion =
    preset.completion ??
    (completionRaw === "ready" || completionRaw === "off_plan" ? completionRaw : null);
  const handover = get(sp, "handover") ?? null;
  const sort = get(sp, "sort");
  const plan = get(sp, "plan");
  const page = num(get(sp, "page"), { min: 1, max: 500 });
  return {
    purpose,
    completion,
    loc: unique([
      ...(preset.loc ?? []),
      ...getAll(sp, "loc").filter((l) => SLUG.test(l.replace(/^p\./, ""))),
    ]).slice(0, 10),
    poly: decodePolygon(get(sp, "poly") ?? ""),
    commute: parseCommute(get(sp, "commute")),
    type: unique([...(preset.type ?? []), ...getAll(sp, "type").filter((t) => SLUG.test(t))]).slice(
      0,
      10,
    ),
    min: num(get(sp, "min")),
    max: num(get(sp, "max")),
    beds: unique(
      getAll(sp, "beds")
        .map((b) => (b === "studio" ? 0 : Number(b)))
        .filter((b) => Number.isInteger(b) && b >= 0 && b <= 5),
    ).sort((a, b) => a - b),
    baths: num(get(sp, "baths"), { min: 1, max: 10 }),
    smin: num(get(sp, "smin")),
    smax: num(get(sp, "smax")),
    furn: get(sp, "furn")?.slice(0, 40) ?? null,
    fac: unique(getAll(sp, "fac").filter((f) => UUID.test(f))).slice(0, 20),
    badge: unique(
      getAll(sp, "badge").filter(
        (b) => ["verified", "price_reduced", "new_listing"].includes(b) || UUID.test(b),
      ),
    ).slice(0, 5),
    handover: handover && /^\d{4}(-Q[1-4])?$/.test(handover) ? handover : null,
    plan: plan === "any" || plan === "post_handover" ? plan : null,
    cheques: num(get(sp, "cheques"), { min: 1, max: 12 }),
    q: (get(sp, "q") ?? "").slice(0, 100),
    ref: get(sp, "ref")?.slice(0, 30) ?? null,
    agent: get(sp, "agent") && SLUG.test(get(sp, "agent")!) ? get(sp, "agent")! : null,
    sort: searchSorts.includes(sort as SearchSort) ? (sort as SearchSort) : "newest",
    page: page && Number.isInteger(page) ? page : 1,
  };
}

/**
 * The query string for filters, leaving out what the route already says (`preset`) and
 * defaults. Keys and values in a fixed order.
 */
export function searchQuery(
  f: SearchFilters,
  preset: Partial<Pick<SearchFilters, "purpose" | "completion" | "loc" | "type">> = {},
): string {
  const p = new URLSearchParams();
  const add = (k: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") p.append(k, String(v));
  };
  if (!preset.purpose && f.purpose !== "sale") add("purpose", f.purpose);
  if (!preset.completion) add("completion", f.completion);
  for (const l of f.loc) if (!preset.loc?.includes(l)) add("loc", l);
  if (f.poly) add("poly", encodePolygon(f.poly));
  if (f.commute) add("commute", commuteParam(f.commute));
  for (const t of f.type) if (!preset.type?.includes(t)) add("type", t);
  add("min", f.min);
  add("max", f.max);
  for (const b of f.beds) add("beds", b === 0 ? "studio" : b);
  add("baths", f.baths);
  add("smin", f.smin);
  add("smax", f.smax);
  add("furn", f.furn);
  for (const x of f.fac) add("fac", x);
  for (const x of f.badge) add("badge", x);
  add("handover", f.handover);
  add("plan", f.plan);
  add("cheques", f.cheques);
  add("q", f.q);
  add("agent", f.agent);
  if (f.sort !== "newest") add("sort", f.sort);
  if (f.page > 1) add("page", f.page);
  return p.toString();
}

/** The base route for a search: SEO landings when only purpose, one area and a type are set. */
export function searchPath(f: SearchFilters): {
  path: string;
  preset: Parameters<typeof searchQuery>[1];
} {
  const root =
    f.completion === "off_plan" && f.purpose === "sale"
      ? "/off-plan"
      : f.purpose === "rent"
        ? "/rent"
        : "/buy";
  const preset: Parameters<typeof searchQuery>[1] = {
    purpose: f.purpose,
    ...(root === "/off-plan" ? { completion: "off_plan" as const } : {}),
  };
  const area = f.loc.length === 1 && !f.loc[0]!.startsWith("p.") ? f.loc[0]! : null;
  if (root !== "/off-plan" && area) {
    if (f.type.length === 1) {
      return {
        path: `${root}/${area}/${f.type[0]}`,
        preset: { ...preset, loc: [area], type: [f.type[0]!] },
      };
    }
    return { path: `${root}/${area}`, preset: { ...preset, loc: [area] } };
  }
  return { path: root, preset };
}

/** Full URL path with query for these filters. */
export function searchHref(f: SearchFilters): string {
  const { path, preset } = searchPath(f);
  const query = searchQuery(f, preset);
  return query ? `${path}?${query}` : path;
}

/** Whether anything beyond the route preset is filtered (for "Clear all" and robots). */
export function hasExtraFilters(f: SearchFilters): boolean {
  const { preset } = searchPath(f);
  return searchQuery({ ...f, page: 1, sort: "newest" }, preset) !== "";
}
