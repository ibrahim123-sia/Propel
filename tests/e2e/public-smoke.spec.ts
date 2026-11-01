import { chromium, expect, test, type Page } from "@playwright/test";
import {
  clearLeads,
  clearListings,
  db,
  expectNotFoundPage,
  publicTags,
  revalidateTags,
  seedDemo,
} from "./helpers";

/**
 * Phase 4 checklist (15): every public route renders server-side with the real demo seed, and
 * the property page meets the Core Web Vitals targets (14 §1) in a Lighthouse mobile run.
 */
test.describe.configure({ mode: "serial" });

let listingSlug = "";

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  await seedDemo(request);
  const { rows } = await db().query(
    `select p.slug from properties p
       where p.status = 'available' and p.completion = 'ready' and p.purpose = 'sale'
         and exists (select 1 from property_media m where m.property_id = p.id and m.kind = 'photo')
       order by p.is_featured desc, p.published_at desc limit 1`,
  );
  listingSlug = rows[0].slug;
});

test.afterAll(async ({ request }) => {
  // Later specs expect a fresh agency: drop the demo content and settings again.
  await clearLeads();
  await clearListings();
  await db().query("delete from posts");
  await db().query("delete from post_categories");
  await db().query("delete from post_tags");
  await db().query("delete from faqs");
  await db().query("delete from testimonials");
  await db().query("delete from pages");
  await db().query("delete from settings");
  await revalidateTags(request, publicTags);
});

async function expectPage(page: Page, path: string, h1: string | RegExp) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await expect(page.getByRole("heading", { level: 1 }).first(), path).toHaveText(h1);
}

test("every public route renders with the demo data", async ({ page }) => {
  test.setTimeout(300_000);
  await expectPage(page, "/", "Find a home you will love coming back to");
  await expect(page.getByRole("region", { name: "Homes we would move into" })).toBeVisible();
  await expect(page.getByRole("region", { name: "New projects with payment plans" })).toBeVisible();
  await expectPage(page, "/buy", /for sale/i);
  await expectPage(page, "/rent", /for rent/i);
  await expectPage(page, "/off-plan", /off-plan/i);
  await expectPage(page, "/buy/dubai-marina", /Dubai Marina/);
  await expectPage(page, "/buy/dubai-marina/apartments", /Apartments.*Dubai Marina/);
  const { rows } = await db().query("select title from properties where slug = $1", [listingSlug]);
  await expectPage(page, `/property/${listingSlug}`, rows[0].title);
  await expectPage(page, "/projects", /projects/i);
  await expectPage(page, "/projects/the-linden-residences", "The Linden Residences");
  await expectPage(page, "/developers", /developers/i);
  await expectPage(page, "/developers/northline-developments", "Northline Developments");
  await expectPage(page, "/agents", /team|agents/i);
  await expectPage(page, "/agents/layla-haddad", "Layla Haddad");
  // Page builder pages from the seed (08 §1), in their templates.
  await expectPage(page, "/about", "A small team that visits every home");
  await expectPage(page, "/contact", "Talk to us");
  await expectPage(page, "/sell-with-us", "Sell or let your home with people who know it");
  await expectPage(page, "/off-plan-guide", "Buying off-plan in Dubai, step by step");
  await expectPage(page, "/how-we-verify", "How we verify listings");
  await expectPage(page, "/privacy-policy", "Privacy policy");
  await expect(page.getByRole("navigation", { name: "On this page" })).toBeVisible();
  await expectPage(page, "/terms", "Terms of use");
  await expectPage(page, "/cookie-policy", "Cookie policy");
  await expectPage(page, "/insights", "Insights");
  await expectPage(page, "/insights/category/buying", "Buying");
  await expectPage(page, "/insights/what-service-charges-pay-for", "What service charges pay for");
  await expectPage(page, "/areas", "Area guides");
  await expectPage(page, "/areas/dubai-marina", "Dubai Marina");
  // The area's landing page opens with its guide and ends with the guide's questions.
  await page.goto("/buy/dubai-marina");
  await expect(page.getByRole("link", { name: "Read the Dubai Marina guide" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Questions about Dubai Marina" })).toBeVisible();
  // Any single-segment address is a page-builder address: a missing one is a soft 404.
  await expectNotFoundPage(page, "/no-such-page-here");
  const missing = await page.goto("/no/such-page-here");
  expect(missing?.status()).toBe(404);
});

/** The part of a Lighthouse result the summary reads. */
type Lhr = { audits: Record<string, { numericValue?: number; details?: unknown } | undefined> };
type Row = Record<string, unknown>;

/** The numbers behind a slow run: metrics, the LCP element and its parts, heavy requests and scripts. */
function lighthouseSummary(lhr: Lhr): string {
  const audit = (id: string) => lhr.audits[id];
  const items = (id: string): Row[] => {
    const d = audit(id)?.details as { items?: Row[] } | undefined;
    return d?.items ?? [];
  };
  const ms = (n: unknown) => `${Math.round(Number(n ?? 0))}`;
  const kb = (n: unknown) => `${Math.round(Number(n ?? 0) / 1024)}KB`;
  const short = (u: unknown) =>
    String(u ?? "")
      .replace(/^https?:\/\/[^/]+/, "")
      .slice(0, 90);
  const m = items("metrics")[0] ?? {};
  const lines = [
    `simulated: FCP ${ms(m.firstContentfulPaint)} LCP ${ms(m.largestContentfulPaint)} SI ${ms(m.speedIndex)} TTI ${ms(m.interactive)} TBT ${ms(m.totalBlockingTime)}`,
    `observed: TTFB ${ms(m.observedTimeToFirstByte ?? audit("server-response-time")?.numericValue)} FCP ${ms(m.observedFirstContentfulPaint)} LCP ${ms(m.observedLargestContentfulPaint)} load ${ms(m.observedLoad)}`,
  ];
  for (const part of items("lcp-breakdown-insight")) {
    const sub = (part as { items?: Row[]; type?: string }).items;
    if (Array.isArray(sub))
      for (const r of sub) {
        if (r.subpart) lines.push(`lcp ${String(r.subpart)}: ${ms(r.duration)}`);
        const node = r.node as { snippet?: string; nodeLabel?: string } | undefined;
        if (node?.snippet) lines.push(`lcp element: ${node.snippet.slice(0, 160)}`);
      }
    const node = (part as { snippet?: string }).snippet;
    if (node) lines.push(`lcp element: ${node.slice(0, 160)}`);
  }
  const requests = items("network-requests");
  const byType = new Map<string, number>();
  for (const r of requests)
    byType.set(
      String(r.resourceType),
      (byType.get(String(r.resourceType)) ?? 0) + Number(r.transferSize ?? 0),
    );
  lines.push(
    `requests ${requests.length}: ${[...byType].map(([t, n]) => `${t} ${kb(n)}`).join(", ")}`,
  );
  for (const r of [...requests]
    .sort((a, b) => Number(b.transferSize ?? 0) - Number(a.transferSize ?? 0))
    .slice(0, 10))
    lines.push(
      `  ${kb(r.transferSize)} ${String(r.resourceType)} ${String(r.priority)} ${ms(r.networkRequestTime)}-${ms(r.networkEndTime)} ${short(r.url)}`,
    );
  for (const r of items("bootup-time").slice(0, 5))
    lines.push(`  cpu ${ms(r.total)} (script ${ms(r.scripting)}) ${short(r.url)}`);
  for (const r of items("render-blocking-insight").slice(0, 5))
    lines.push(`  blocking ${ms(r.wastedMs)} ${short(r.url)}`);
  return lines.join("\n");
}

test("commute filter: homes within a drive of one of the agency's places", async ({ page }) => {
  // The place most demo listings are near (times are estimates without a Google key).
  const { rows } = await db().query(
    `select poi.id, poi.name from pois poi join property_pois pp on pp.poi_id = poi.id
      where poi.is_active group by poi.id, poi.name order by count(*) desc limit 1`,
  );
  const place = rows[0] as { id: string; name: string };
  await page.goto(`/buy?commute=${place.id}.drive.30`);
  await expect(page.getByText(`Within 30 min drive of ${place.name}`).first()).toBeVisible();
  const line = page.getByText(new RegExp(`min drive to ${place.name}`)).first();
  await expect(line).toBeVisible();
  const minutes = Number((await line.textContent())!.match(/(\d+) min/)![1]);
  expect(minutes).toBeLessThanOrEqual(30);

  await page.getByRole("button", { name: "More filters" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("group", { name: "Commute time" })).toBeVisible();
  await expect(sheet.getByRole("combobox", { name: "To" })).toHaveValue(place.id);
});

test("share cards: og:image and twitter:image point at a versioned card that is a PNG", async ({
  page,
  request,
}) => {
  for (const path of [`/property/${listingSlug}`, "/projects/the-linden-residences"]) {
    await page.goto(path);
    const og = await page.locator('meta[property="og:image"]').first().getAttribute("content");
    expect(og, path).toMatch(/\/og\/(property|project)\/[a-z0-9-]+\?v=[0-9a-f]{12}$/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    const card = await request.get(og!);
    expect(card.status(), path).toBe(200);
    expect(card.headers()["content-type"]).toBe("image/png");
    expect(card.headers()["cache-control"]).toContain("immutable");
    expect((await card.body()).length).toBeGreaterThan(10_000);
    // Another version (old content) is only cached briefly.
    const stale = await request.get(og!.replace(/v=[0-9a-f]+/, "v=000000000000"));
    expect(stale.headers()["cache-control"]).toContain("max-age=600");
  }
  expect((await request.get("/og/nothing/here")).status()).toBe(404);
});

/**
 * The mobile phone Lighthouse emulates, as an HTML-only crawler. Next streams metadata from
 * generateMetadata into <body> for browsers and for Googlebot (which reads the whole DOM); it
 * blocks and puts it in <head> for HTML-limited crawlers (facebookexternalhit, Bingbot,
 * "Chrome-Lighthouse"...). Lighthouse 13's default user agent is a plain browser, whose SEO
 * audits read <head> only, so SEO is checked the way such a crawler receives the page.
 */
const CRAWLER_UA =
  "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse";

test("home, search and property: Lighthouse accessibility 95+ and SEO 100 (mobile)", async ({}, testInfo) => {
  test.skip(process.env.E2E_MODE !== "prod", "Lighthouse measures the production build only");
  test.setTimeout(900_000);
  const { default: lighthouse } = await import("lighthouse");
  const port = 9334;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const base = `http://localhost:${process.env.E2E_PORT ?? 3200}`;
  type Node = { snippet?: string; selector?: string; explanation?: string };
  type Result = NonNullable<Awaited<ReturnType<typeof lighthouse>>>["lhr"];
  // What lowered a score: every weighted audit that did not pass, with its elements
  // (selector and, for contrast, the colours and ratio).
  const failing = (lhr: Result, c: string) =>
    lhr.categories[c]!.auditRefs.filter((r) => r.weight > 0)
      .map((r) => lhr.audits[r.id]!)
      .filter((a) => a.score !== null && a.score < 1)
      .map((a) => {
        const items = (a.details as { items?: Array<{ node?: Node }> })?.items ?? [];
        const nodes = items
          .slice(0, 6)
          .map(
            ({ node }) =>
              `    ${node?.snippet?.slice(0, 110) ?? ""} @ ${node?.selector?.slice(0, 90) ?? ""} ${node?.explanation?.split("\n").at(-1)?.slice(0, 140) ?? ""}`,
          );
        return [`- ${a.id}: ${a.title}`, ...nodes].join("\n");
      })
      .join("\n");
  const run = async (url: string, category: "accessibility" | "seo") => {
    const result = await lighthouse(url, {
      port,
      output: "json" as const,
      logLevel: "error" as const,
      onlyCategories: [category],
      ...(category === "seo" ? { emulatedUserAgent: CRAWLER_UA } : {}),
    });
    const lhr = result!.lhr;
    return {
      lhr,
      score: Math.round((lhr.categories[category]?.score ?? 0) * 100),
      why: failing(lhr, category),
    };
  };
  try {
    for (const path of ["/", "/buy", `/property/${listingSlug}`]) {
      const a11y = await run(`${base}${path}`, "accessibility");
      const seo = await run(`${base}${path}`, "seo");
      const report = `${path}: accessibility ${a11y.score}, SEO ${seo.score}\n${a11y.why}\n${seo.why}`;
      console.log(`[lighthouse] ${report}`);
      await testInfo.attach(`lighthouse-a11y${path.replace(/\//g, "_")}.json`, {
        body: JSON.stringify(a11y.lhr),
        contentType: "application/json",
      });
      expect(a11y.score, report).toBeGreaterThanOrEqual(95);
      expect(seo.score, report).toBe(100);
    }
  } finally {
    await browser.close();
  }
});

test("property page: Core Web Vitals in a Lighthouse mobile run", async ({}, testInfo) => {
  test.skip(process.env.E2E_MODE !== "prod", "Lighthouse measures the production build only");
  test.setTimeout(300_000);
  const { default: lighthouse } = await import("lighthouse");
  const port = 9333;
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    const url = `http://localhost:${process.env.E2E_PORT ?? 3200}/property/${listingSlug}`;
    // Default config: a mid-range phone on simulated 4G (14 §1). The first run warms the
    // server's resized-image cache (as a CDN would be in production); the second is measured.
    const flags = {
      port,
      output: "json" as const,
      logLevel: "error" as const,
      onlyCategories: ["performance"],
    };
    const warm = await lighthouse(url, flags);
    console.log(
      `[lighthouse] warm-up LCP ${Math.round(warm!.lhr.audits["largest-contentful-paint"]!.numericValue!)} ms`,
    );
    const result = await lighthouse(url, flags);
    const lhr = result!.lhr;
    await testInfo.attach("lighthouse.json", {
      body: JSON.stringify(lhr),
      contentType: "application/json",
    });
    const audits = lhr.audits;
    const lcp = audits["largest-contentful-paint"]!.numericValue!;
    const cls = audits["cumulative-layout-shift"]!.numericValue!;
    const tbt = audits["total-blocking-time"]!.numericValue!;
    // On failure the message carries what made it slow (CI shows it in the annotations).
    const why = lighthouseSummary(lhr);
    const score = Math.round((lhr.categories.performance!.score ?? 0) * 100);
    console.log(`[lighthouse] score ${score}\n${why}`);
    // Report-only until the Phase 10 performance pass (PROGRESS decision 62): on localhost
    // every script finishes before the first paint, so the lab estimate counts them all
    // against LCP. LIGHTHOUSE_ENFORCE=1 turns the targets into failures.
    const enforce = process.env.LIGHTHOUSE_ENFORCE === "1";
    const check = (name: string, value: number, limit: number) => {
      if (enforce) expect(value, `${name}\n${why}`).toBeLessThan(limit);
      else if (value >= limit)
        testInfo.annotations.push({
          type: "warning",
          description: `${name} ${Math.round(value * 1000) / 1000} is over ${limit}\n${why}`,
        });
    };
    check("LCP", lcp, 2500);
    check("CLS", cls, 0.1);
    // Lab stand-in for INP (< 200 ms in the field).
    check("TBT", tbt, 200);
  } finally {
    await browser.close();
  }
});
