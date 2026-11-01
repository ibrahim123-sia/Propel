import { registerMockRule, type MockContext, type MockReply } from "./providers/mock";

/**
 * The AI helpers' answers from the built-in test provider (development without a key, tests,
 * e2e). Built from the facts in the request only, like the real prompts ask.
 */

function tagged(ctx: MockContext, tag: string): unknown {
  const hit = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(ctx.lastUserText);
  if (!hit) return null;
  try {
    return JSON.parse(hit[1]!);
  } catch {
    return hit[1];
  }
}

type Facts = Record<string, unknown>;

const join = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v));

function description(f: Facts): string {
  const beds =
    f.bedrooms === "studio" ? "studio" : f.bedrooms ? `${String(f.bedrooms)}-bedroom` : "";
  const what = [beds, String(f.type ?? "home").toLowerCase()].filter(Boolean).join(" ");
  const where = f.location ? ` in ${String(f.location).split(",")[0]}` : "";
  const first = `This ${what}${where} is ${String(f.purpose ?? "available")}${f.size ? `, with ${String(f.size)} of space` : ""}.`;
  const layout = [
    f.bathrooms ? `${String(f.bathrooms)} bathrooms` : null,
    f.view ? `${join(f.view)} views` : "[add detail: the view]",
    f.furnishing ? String(f.furnishing).toLowerCase() : null,
  ]
    .filter(Boolean)
    .join(", ");
  const extras = f.facilities ? `Residents can use the ${join(f.facilities).toLowerCase()}.` : "";
  return [first, `It has ${layout}.`, extras || "[add detail: the building or community]"].join(
    "\n\n",
  );
}

function titles(f: Facts): string[] {
  const type = String(f.type ?? "Home");
  const beds = f.bedrooms === "studio" ? "Studio" : f.bedrooms ? `${String(f.bedrooms)}-Bed` : "";
  const area = f.location ? String(f.location).split(",")[0] : "";
  const feature =
    Array.isArray(f.view) && f.view.length ? `${String(f.view[0])} view` : "great layout";
  return [
    `${beds} ${type} in ${area}`.replace(/\s+/g, " ").trim(),
    `${beds} ${type} with ${feature}`.replace(/\s+/g, " ").trim(),
    `${type} ${String(f.purpose ?? "")} in ${area}`.replace(/\s+/g, " ").trim(),
  ].map((t) => t.slice(0, 80));
}

function seo(page: { title?: string; content?: string }) {
  const title = String(page.title ?? "Home").slice(0, 45);
  const text = String(page.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const desc = (extra: string) =>
    `${text.slice(0, 110)}${text.length > 110 ? "…" : ""} ${extra}`
      .trim()
      .slice(0, 155)
      .padEnd(55, ".");
  return {
    options: [
      { title: `${title} | Details`, description: desc("See photos and details.") },
      { title: `${title} | Book a viewing`, description: desc("Book a viewing today.") },
      { title: title.padEnd(12, " ").trim().padEnd(10, "."), description: desc("Ask our team.") },
    ],
  };
}

function blog(brief: string) {
  const topic = brief.split(/[.\n]/)[0]!.trim().slice(0, 80) || "Living here";
  return {
    title: topic.charAt(0).toUpperCase() + topic.slice(1),
    excerpt: `A short guide: ${topic.toLowerCase()}.`,
    sections: [
      { heading: "What to know", paragraphs: [`${topic}. [add source] for any figures.`] },
      { heading: "Next steps", paragraphs: ["Speak to our team for advice on your situation."] },
    ],
  };
}

function listing(text: string) {
  const num = (re: RegExp) => {
    const m = re.exec(text)?.[1];
    return m ? Number(m.replace(/,/g, "")) : undefined;
  };
  const type = /\b(apartment|villa|townhouse|penthouse|studio|office)\b/i.exec(text)?.[1];
  return {
    title: text.split(/[.\n]/)[0]!.trim().slice(0, 100) || "New listing",
    purpose: /\brent\b|per year|a year|monthly/i.test(text) ? "rent" : "sale",
    ...(type ? { propertyType: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() } : {}),
    ...(/\bin ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*)/.exec(text)
      ? { location: /\bin ([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*)/.exec(text)![1] }
      : {}),
    ...(num(/(\d+)\s*(?:bed|br\b|bedroom)/i) !== undefined
      ? { beds: num(/(\d+)\s*(?:bed|br\b|bedroom)/i) }
      : {}),
    ...(num(/(\d+)\s*bath/i) !== undefined ? { baths: num(/(\d+)\s*bath/i) } : {}),
    ...(num(/([\d,]{4,})\s*(?:aed|usd|\$|dollars|dirhams)?\s*(?:asking|price)?/i) !== undefined
      ? { price: num(/(?:aed|usd|\$|price|asking)\s*([\d,]{4,})/i) ?? num(/([\d,]{5,})/) }
      : {}),
    ...(num(/([\d,]+)\s*(?:sq\s*ft|sqft|m2|m²|sqm)/i) !== undefined
      ? { size: num(/([\d,]+)\s*(?:sq\s*ft|sqft|m2|m²|sqm)/i) }
      : {}),
    description: text.trim().slice(0, 1500),
    unknown: ["photos", "exact location"],
  };
}

function reply(ctx: MockContext): MockReply | null {
  const system = ctx.request.system;
  if (system.startsWith("You write property listing descriptions"))
    return { text: description((tagged(ctx, "facts") ?? {}) as Facts) };
  if (system.startsWith("You edit property listing descriptions")) {
    // The test provider keeps the admin's words: "improve" tidies spacing, "shorten" keeps
    // the first sentences up to the asked length.
    const current = String(tagged(ctx, "current") ?? "")
      .replace(/[ \t]+/g, " ")
      .trim();
    const words = /about (\d+) words/.exec(system);
    if (!words) return { text: current };
    const max = Number(words[1]);
    const out: string[] = [];
    for (const sentence of current.split(/(?<=[.!?])\s+/)) {
      if (out.join(" ").split(/\s+/).length + sentence.split(/\s+/).length > max && out.length)
        break;
      out.push(sentence);
    }
    return { text: out.join(" ") };
  }
  if (system.startsWith("Suggest 3 titles"))
    return { text: JSON.stringify({ titles: titles((tagged(ctx, "facts") ?? {}) as Facts) }) };
  if (system.startsWith("Suggest 3 search-engine"))
    return { text: JSON.stringify(seo((tagged(ctx, "page") ?? {}) as { title?: string })) };
  if (system.startsWith("Write alt text")) {
    const c = (tagged(ctx, "context") ?? {}) as Facts;
    const where = c.listing ? ` at ${String(c.listing)}` : "";
    return { text: `${String(c.caption ?? "A room")}${where}`.slice(0, 120) };
  }
  if (system.includes("You draft blog posts"))
    return { text: JSON.stringify(blog(String(tagged(ctx, "brief") ?? ""))) };
  if (system.startsWith("Turn the pasted text"))
    return { text: JSON.stringify(listing(String(tagged(ctx, "text") ?? ""))) };
  return null;
}

export function registerHelperMockRules(): void {
  registerMockRule({ name: "ai-helpers", reply });
}
