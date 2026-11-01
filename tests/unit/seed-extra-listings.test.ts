import { describe, expect, it } from "vitest";
import { withExtraListings } from "@/db/seed/extra-listings";
import { havenDune } from "@/db/seed/presets/haven-dune";
import { usDemo } from "@/db/seed/presets/us-demo";

describe("extra seed listings (pnpm db:seed --listings=N)", () => {
  it("adds listings up to the total, made from the preset's own areas, types and prices", () => {
    const p = withExtraListings(havenDune, 100);
    expect(p.listings).toHaveLength(100);
    expect(p.listings.slice(0, havenDune.listings.length)).toEqual(havenDune.listings);
    const own = new Set(
      havenDune.listings.map(([purpose, type, loc]) => `${purpose}|${type}|${loc}`),
    );
    for (const [purpose, type, loc, beds, , size, price, title, extras] of p.listings.slice(40)) {
      expect(own.has(`${purpose}|${type}|${loc}`)).toBe(true);
      expect(size).toBeGreaterThan(0);
      expect(price).toBeGreaterThan(0);
      expect(extras.project).toBeUndefined();
      expect(title.length).toBeGreaterThan(10);
      if (type === "villa") expect(beds).toBeGreaterThanOrEqual(3);
    }
    // The same every time, and nothing changes when the preset already has enough.
    expect(withExtraListings(havenDune, 100)).toEqual(p);
    expect(withExtraListings(havenDune, 10)).toBe(havenDune);
    expect(withExtraListings(usDemo, 30).listings).toHaveLength(30);
  });
});
