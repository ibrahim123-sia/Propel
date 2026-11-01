import { rng } from "./rng";
import type { ListingSpec, SeedPreset } from "./types";

/**
 * More listings for a preset (`pnpm db:seed --listings=100`), made in the preset's own image:
 * the same type and area pairs, prices per area unit and buildings as its hand-written
 * listings, so the extra ones look like the market and go through the same seeding (photos,
 * floor plans, facilities, descriptions, nearby places, badges, history). Deterministic: the
 * same preset and count always give the same listings. Off-plan units stay with the projects.
 */

const bedWords = ["Studio", "One-bed", "Two-bed", "Three-bed", "Four-bed", "Five-bed", "Six-bed"];

const extrasByShape: Record<"flat" | "house" | "commercial" | "land", string[]> = {
  flat: [
    "with a balcony",
    "on a high floor",
    "with a renovated kitchen",
    "close to the metro",
    "facing the water",
    "with built-in wardrobes",
    "next to the park",
    "with a study",
  ],
  house: [
    "with a private garden",
    "with a pool",
    "on a quiet street",
    "backing onto the park",
    "with a maid's room",
    "with a roof terrace",
    "near the school",
  ],
  commercial: ["on a main road", "with parking", "fitted and ready", "near the metro"],
  land: [
    "for a family villa",
    "on a corner",
    "with road access on two sides",
    "for a small building",
  ],
};

const shapeOf = (typeKey: string, category: string): "flat" | "house" | "commercial" =>
  category !== "residential"
    ? "commercial"
    : ["villa", "townhouse", "house", "single-family", "condo-house"].includes(typeKey)
      ? "house"
      : "flat";

const round = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

export function withExtraListings(preset: SeedPreset, total: number): SeedPreset {
  const own = preset.listings.filter(([, , , , , , , , extras]) => !extras.project);
  if (total <= preset.listings.length || own.length === 0) return preset;
  const r = rng(20261101);
  const types = new Map(preset.propertyTypes.map((t) => [t.key, t]));
  const locName = new Map(preset.locations.map((l) => [l.key, l.name]));

  // What the hand-written listings say about the market: price per area unit by purpose,
  // type and area; sizes per bedroom; buildings per area.
  const perUnit = new Map<string, number[]>();
  const buildings = new Map<string, string[]>();
  for (const [purpose, type, loc, , , size, price, , extras] of own) {
    if (price && size) {
      const key = `${purpose}|${type}|${loc}`;
      perUnit.set(key, [...(perUnit.get(key) ?? []), price / size]);
      perUnit.set(`${purpose}|${type}`, [
        ...(perUnit.get(`${purpose}|${type}`) ?? []),
        price / size,
      ]);
    }
    if (extras.building) buildings.set(loc, [...(buildings.get(loc) ?? []), extras.building]);
  }
  const avg = (xs: number[] | undefined) =>
    xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const combos = own.map(([purpose, type, loc]) => ({ purpose, type, loc }));

  const extra: ListingSpec[] = [];
  for (let i = preset.listings.length; i < total; i++) {
    const { purpose, type: typeKey, loc } = r.pick(combos);
    const type = types.get(typeKey);
    if (!type) continue;
    const shape = shapeOf(typeKey, type.category);
    const land = type.category === "land";
    const beds =
      shape === "commercial" || land
        ? null
        : shape === "house"
          ? r.int(3, 6)
          : typeKey === "penthouse"
            ? r.int(3, 5)
            : r.int(0, 3);
    const baths = beds === null ? (land ? null : r.int(1, 2)) : Math.max(1, beds + r.int(0, 1));
    // Size in the preset's area unit, scaled from what the market's listings of this type use.
    const sizes = own.filter(([, t]) => t === typeKey).map(([, , , , , s]) => s);
    const typical = avg(sizes) ?? 1000;
    const bedFactor =
      beds === null
        ? 1
        : (beds + 1) /
          (avg(own.filter(([, t]) => t === typeKey).map(([, , , b]) => (b ?? 0) + 1)) ?? 2);
    const size = round(typical * bedFactor * (0.85 + r.next() * 0.3), 10);
    const rate =
      avg(perUnit.get(`${purpose}|${typeKey}|${loc}`)) ??
      avg(perUnit.get(`${purpose}|${typeKey}`)) ??
      avg(
        [...perUnit.entries()].filter(([k]) => k.startsWith(`${purpose}|`)).flatMap(([, v]) => v),
      ) ??
      1000;
    const price = round(size * rate * (0.88 + r.next() * 0.24), purpose === "rent" ? 1000 : 10_000);
    const area = locName.get(loc) ?? loc;
    const building =
      shape === "flat" && buildings.get(loc)?.length ? r.pick(buildings.get(loc)!) : undefined;
    const what =
      shape === "commercial" || land
        ? type.name
        : `${bedWords[Math.min(beds ?? 0, bedWords.length - 1)]} ${type.name.toLowerCase()}`;
    const title = `${what} ${r.pick(extrasByShape[land ? "land" : shape])} in ${area}`;
    const roll = r.next();
    extra.push([
      purpose,
      typeKey,
      loc,
      beds,
      baths,
      size,
      price,
      title,
      {
        ...(building ? { building } : {}),
        ...(roll < 0.08 ? { featured: true } : {}),
        ...(roll > 0.85
          ? { reducedFrom: round(price * 1.06, purpose === "rent" ? 1000 : 10_000) }
          : {}),
        ...(roll > 0.7 && roll < 0.78 ? { stale: true } : {}),
      },
    ]);
  }
  return { ...preset, listings: [...preset.listings, ...extra] };
}
