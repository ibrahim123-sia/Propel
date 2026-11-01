import { describe, expect, it } from "vitest";
import { sectionsText } from "@/features/cms/section-text";

describe("the words a page's sections show", () => {
  it("keeps headings and text, drops ids, addresses and style tokens", () => {
    const sections = [
      {
        id: "0192f000-0000-7000-8000-000000000001",
        type: "hero",
        data: {
          heading: "Homes in Dubai Marina",
          body: { type: "doc", content: [{ type: "text", text: "Walk to the beach." }] },
          button: { label: "Search", href: "/buy" },
          align: "center",
          imageUrl: "https://example.com/a.jpg",
        },
      },
      {
        id: "x",
        type: "faq",
        data: { items: [{ q: "Pets allowed?", a: "Yes, with a deposit." }] },
      },
    ];
    expect(sectionsText(sections)).toBe(
      "Homes in Dubai Marina Walk to the beach. Search Pets allowed? Yes, with a deposit.",
    );
  });

  it("stops at the limit", () => {
    expect(sectionsText([{ text: "A long sentence here. ".repeat(100) }], 50)).toHaveLength(50);
  });
});
