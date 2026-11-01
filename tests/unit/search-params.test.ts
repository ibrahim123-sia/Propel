import { describe, expect, it } from "vitest";
import {
  decodePolygon,
  encodePolygon,
  hasExtraFilters,
  parseSearch,
  searchHref,
  searchQuery,
} from "@/features/search/params";
import {
  compactAmount,
  displayPrice,
  fromBaseMinor,
  roundForDisplay,
  toBaseMinor,
  type Rates,
} from "@/lib/currency-display";

describe("search filters in the URL", () => {
  it("parses what it understands and drops the rest", () => {
    const f = parseSearch({
      purpose: "rent",
      loc: ["dubai-marina", "p.the-linden", "Bad Slug!"],
      type: "apartments,villas",
      min: "1000000",
      max: "abc",
      beds: ["studio", "2", "9"],
      baths: "2",
      fac: "01a15a6f-4d91-71e8-b8e1-9b6e108751d1,not-a-uuid",
      badge: ["verified", "oops"],
      handover: "2027-Q3",
      plan: "post_handover",
      sort: "price_desc",
      page: "3",
    });
    expect(f).toMatchObject({
      purpose: "rent",
      completion: null,
      loc: ["dubai-marina", "p.the-linden"],
      type: ["apartments", "villas"],
      min: 1_000_000,
      max: null,
      beds: [0, 2],
      baths: 2,
      fac: ["01a15a6f-4d91-71e8-b8e1-9b6e108751d1"],
      badge: ["verified"],
      handover: "2027-Q3",
      plan: "post_handover",
      sort: "price_desc",
      page: 3,
    });
  });

  it("writes the same URL for the same search, in a fixed order", () => {
    const a = parseSearch({ beds: ["3", "1"], type: "villas", min: "500000", purpose: "sale" });
    const b = parseSearch({ min: "500000", type: "villas", beds: ["1", "3"] });
    expect(searchQuery(a)).toBe(searchQuery(b));
    expect(searchQuery(a)).toBe("type=villas&min=500000&beds=1&beds=3");
  });

  it("uses SEO landing routes for one area (and one type)", () => {
    expect(searchHref(parseSearch({ loc: "dubai-marina", type: "apartments" }))).toBe(
      "/buy/dubai-marina/apartments",
    );
    expect(searchHref(parseSearch({ purpose: "rent", loc: "jbr", beds: "2" }))).toBe(
      "/rent/jbr?beds=2",
    );
    expect(searchHref(parseSearch({ completion: "off_plan" }))).toBe("/off-plan");
    expect(searchHref(parseSearch({ loc: ["a", "b"] }))).toBe("/buy?loc=a&loc=b");
    expect(searchHref(parseSearch({ loc: "p.linden" }))).toBe("/buy?loc=p.linden");
  });

  it("route presets are not repeated in the query", () => {
    const f = parseSearch({ sort: "size" }, { purpose: "rent", loc: ["jbr"] });
    expect(f.loc).toEqual(["jbr"]);
    expect(searchHref(f)).toBe("/rent/jbr?sort=size");
    expect(hasExtraFilters(parseSearch({}, { loc: ["jbr"] }))).toBe(false);
    expect(hasExtraFilters(parseSearch({ beds: "2" }, { loc: ["jbr"] }))).toBe(true);
  });

  it("encodes a drawn area compactly and reads it back", () => {
    const ring: Array<[number, number]> = [
      [55.1403, 25.0805],
      [55.15, 25.09],
      [55.16, 25.075],
    ];
    const text = encodePolygon(ring);
    expect(text).toMatch(/^[\x3f-\x7e]+$/);
    expect(decodePolygon(text)).toEqual(ring);
    expect(decodePolygon("abc")).toBeNull();
    expect(decodePolygon(encodePolygon(ring.slice(0, 2)))).toBeNull();
  });

  it("reads and writes a commute limit; anything else is dropped", () => {
    const poi = "0192f000-0000-7000-8000-0000000000aa";
    const f = parseSearch({ commute: `${poi}.walk.15` });
    expect(f.commute).toEqual({ poi, mode: "walk", minutes: 15 });
    expect(searchQuery(f)).toBe(`commute=${poi}.walk.15`);
    for (const bad of [`${poi}.bike.15`, `${poi}.drive.7`, `${poi}.drive.90`, "nope.drive.10"])
      expect(parseSearch({ commute: bad }).commute).toBeNull();
  });
});

describe("prices in the visitor's currency", () => {
  const rates: Rates = {
    base: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
    others: [
      { code: "USD", symbol: "$", symbolPosition: "before", decimals: 2, rate: 0.2723 },
      { code: "JPY", symbol: "¥", symbolPosition: "before", decimals: 0, rate: 40.1 },
    ],
  };

  it("converts through the base currency", () => {
    expect(fromBaseMinor(245_000_000, "USD", rates)).toBe(66_713_500);
    expect(toBaseMinor(66_713_500, "USD", rates)).toBe(245_000_000);
    expect(fromBaseMinor(100_00, "JPY", rates)).toBe(4010);
    expect(toBaseMinor(1, "GBP", rates)).toBeNull();
  });

  it("marks converted prices as approximate and rounds them", () => {
    expect(displayPrice(245_000_000, "AED", "USD", rates)).toEqual({
      text: "≈ $667,000",
      approximate: true,
      listed: "AED 2,450,000",
    });
    expect(displayPrice(245_000_000, "AED", "AED", rates)).toMatchObject({
      text: "AED 2,450,000",
      approximate: false,
    });
    expect(displayPrice(245_000_000, "AED", null, rates).approximate).toBe(false);
    expect(roundForDisplay(66_713_500, 2)).toBe(66_700_000);
    expect(compactAmount(245_000_000, 2)).toBe("2.45M");
    expect(compactAmount(12_000_000, 2)).toBe("120K");
  });
});
