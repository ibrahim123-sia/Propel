import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { havenDune } from "@/db/seed/presets/haven-dune";
import { findPublicPage } from "@/features/cms/page-public";
import { getHomePage } from "@/features/cms/queries";
import { buildSiteMenus } from "@/features/menus/queries";
import { sectionInputSchema } from "@/features/cms/sections";
import { seedPreset, type SeedResult } from "@/db/seed/run";
import { getPriceTrends } from "@/features/price-trends/queries";
import { parseSearch } from "@/features/search/params";
import { searchListings } from "@/features/search/query";
import { loadSettings } from "@/features/settings/queries";
import { postDocSchema, postReferences, type PostDoc } from "@/lib/rich-text-post";
import { memoryStorage, setStorage } from "@/lib/storage";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const rows = async <T>(query: string) =>
  (await (await getDb()).execute(sql.raw(query))).rows as T[];

describe("demo seed: Haven & Dune", () => {
  let result: SeedResult;

  beforeAll(async () => {
    setStorage(memoryStorage());
    result = await seedPreset(await getDb(), havenDune, {
      reset: true,
      now: new Date("2026-10-20T08:00:00Z"),
    });
  }, 240_000);
  afterAll(async () => {
    setStorage(null);
    // The seed sets the market up (AED, sq ft, "HD" references): later files expect defaults.
    await truncate("settings");
  });

  it("seeds the header and footer menus (links to pages the preset lacks are left out)", async () => {
    const site = await buildSiteMenus(await getDb());
    const header = site.header.links;
    expect(header.map((l) => l.label)).toEqual(
      expect.arrayContaining(["Buy", "Rent", "Off-plan", "Agents"]),
    );
    expect(header.find((l) => l.label === "Buy")?.children.map((c) => c.href)).toContain(
      "/buy/dubai-marina",
    );
    expect(site.footer_1).toMatchObject({
      title: "Explore",
      links: expect.arrayContaining([
        expect.objectContaining({ label: "Homes for sale", href: "/buy" }),
      ]),
    });
    expect(site.footer_2.title).toBe("Areas");
    expect(result.counts.menus).toBe(4);
  });

  it("creates the 16 §1 mix of listings, projects, agents and places", async () => {
    expect(result.counts).toMatchObject({
      locations: 9,
      agents: 5,
      developers: 3,
      projects: 4,
      properties: 40,
      conversations: 4,
    });
    // The demo inbox: WhatsApp, web chat and email, quick replies and one draft to approve.
    expect(
      await rows<{ channel: string; n: number }>(
        "select channel, count(*)::int as n from conversations group by 1 order by 1",
      ),
    ).toEqual([
      { channel: "email", n: 1 },
      { channel: "web_chat", n: 1 },
      { channel: "whatsapp", n: 2 },
    ]);
    expect(
      await rows<{ n: number }>(
        "select count(*)::int as n from approval_queue where status = 'pending'",
      ),
    ).toEqual([{ n: 1 }]);
    expect(await rows<{ n: number }>("select count(*)::int as n from quick_replies")).toEqual([
      { n: 4 },
    ]);
    const mix = await rows<{ purpose: string; completion: string; n: number }>(
      "select purpose, completion, count(*)::int as n from properties group by 1, 2 order by 1, 2",
    );
    expect(mix).toEqual([
      { purpose: "rent", completion: "ready", n: 10 },
      { purpose: "sale", completion: "off_plan", n: 8 },
      { purpose: "sale", completion: "ready", n: 22 },
    ]);
    const types = await rows<{ slug: string; n: number }>(
      "select t.slug, count(*)::int as n from properties p join property_types t on t.id = p.property_type_id where t.slug in ('offices', 'shops', 'plots') group by 1 order by 1",
    );
    expect(types).toEqual([
      { slug: "offices", n: 2 },
      { slug: "plots", n: 2 },
      { slug: "shops", n: 1 },
    ]);
  });

  it("listings have photos, references, badges, verification and measured places", async () => {
    const [photos] = await rows<{ min: number; max: number }>(
      "select min(n)::int as min, max(n)::int as max from (select count(*) as n from property_media where kind = 'photo' group by property_id) x",
    );
    expect(photos!.min).toBeGreaterThanOrEqual(6);
    expect(photos!.max).toBeLessThanOrEqual(12);
    const refs = await rows<{ reference: string }>(
      "select reference from properties order by reference limit 1",
    );
    expect(refs[0]!.reference).toMatch(/^HD-\d+$/);
    const badges = await rows<{ name: string; n: number }>(
      "select b.name, count(*)::int as n from property_badges pb join badges b on b.id = pb.badge_id group by 1 order by 1",
    );
    const byName = Object.fromEntries(badges.map((b) => [b.name, b.n]));
    expect(byName["Off-plan"]).toBe(8);
    expect(byName["Price reduced"]).toBeGreaterThanOrEqual(3);
    expect(byName.New).toBeGreaterThanOrEqual(1);
    expect(byName.Verified).toBeGreaterThanOrEqual(10);
    const [stale] = await rows<{ n: number }>(
      "select count(*)::int as n from properties where last_verified_at < now() - interval '45 days'",
    );
    expect(stale!.n).toBeGreaterThanOrEqual(3);
    const [measured] = await rows<{ n: number }>(
      "select count(distinct property_id)::int as n from property_pois",
    );
    expect(measured!.n).toBe(40);
    const [projectPlaces] = await rows<{ n: number }>(
      "select count(distinct project_id)::int as n from project_pois",
    );
    expect(projectPlaces!.n).toBe(4);
  });

  it("publishes a home page whose sections all pass the strict section rules", async () => {
    const page = await getHomePage();
    expect(page?.sections.map((x) => x.type)).toEqual([
      "hero_search",
      "promise_strip",
      "featured_listings",
      "projects_showcase",
      "areas_grid",
      "testimonials",
      "blog_posts",
      "faq",
    ]);
    const [row] = await rows<{ sections: unknown[] }>("select sections from pages where is_home");
    const schema = sectionInputSchema();
    for (const section of row!.sections) expect(schema.safeParse(section).success).toBe(true);
  });

  it("publishes the seed pages (08 §1) and links the policies in Settings -> Legal", async () => {
    const list = await rows<{ slug: string; template: string; status: string; revisions: number }>(
      `select slug, template, status,
         (select count(*)::int from page_revisions r where r.page_id = p.id) as revisions
       from pages p where not is_home order by slug`,
    );
    expect(list.map((p) => [p.slug, p.template])).toEqual([
      ["about", "default"],
      ["contact", "default"],
      ["cookie-policy", "legal"],
      ["how-we-verify", "legal"],
      ["off-plan-guide", "default"],
      ["privacy-policy", "legal"],
      ["terms", "legal"],
    ]);
    expect(list.every((p) => p.status === "published" && p.revisions === 1)).toBe(true);
    const page = await findPublicPage("about");
    expect(page?.sections.map((x) => x.type)).toEqual([
      "hero_simple",
      "text_image",
      "stats",
      "team",
      "testimonials",
      "cta",
    ]);
    // Images point at pictures the seed drew.
    expect(page?.sections[1]?.props).toMatchObject({ imageId: expect.any(String) });
    const legal = await loadSettings("legal", await getDb());
    const ids = await rows<{ id: string; slug: string }>("select id, slug from pages");
    const slugOf = (id: string | null) => ids.find((r) => r.id === id)?.slug;
    expect(slugOf(legal.privacyPageId)).toBe("privacy-policy");
    expect(slugOf(legal.termsPageId)).toBe("terms");
    expect(slugOf(legal.cookiePageId)).toBe("cookie-policy");
    expect(slugOf(legal.howWeVerifyPageId)).toBe("how-we-verify");
  });

  it("sets the market up and the listings are searchable", async () => {
    const db = await getDb();
    const market = await loadSettings("market", db);
    expect(market).toMatchObject({ areaUnit: "sqft", rentPeriod: "year" });
    expect(market.baseCurrency.code).toBe("AED");
    expect(market.visitorCurrencies.map((c) => c.code)).toEqual(["USD", "EUR", "GBP"]);
    const marina = await searchListings(parseSearch({ loc: "dubai-marina" }));
    expect(marina.total).toBeGreaterThanOrEqual(5);
    const rent = await searchListings(parseSearch({ purpose: "rent" }));
    // Rented listings leave search.
    expect(rent.total).toBe(9);
    expect(result.admins.map((a) => [a.email, a.readOnly])).toEqual([
      ["admin@demo.propel", false],
      ["staff@demo.propel", false],
      ["viewer@demo.propel", true],
    ]);
  });

  it("writes the demo content: 6 posts, 4 area guides, 12 FAQs and 6 testimonials", async () => {
    expect(result.counts).toMatchObject({ posts: 6, area_guides: 4, testimonials: 6 });
    const shared = await rows<{ group: string; n: number }>(
      'select "group", count(*)::int as n from faqs where area_guide_id is null and is_published group by 1 order by 1',
    );
    expect(shared.reduce((n, g) => n + g.n, 0)).toBe(12);

    // Every body passed the post allowlist; listing cards point at live listings.
    const bodies = await rows<{ body: PostDoc; reading_minutes: number; status: string }>(
      "select body, reading_minutes, status from posts union all select body, 1, status from area_guides",
    );
    for (const b of bodies) {
      expect(postDocSchema.safeParse(b.body).success).toBe(true);
      expect(b.status).toBe("published");
    }
    const cards = bodies.flatMap((b) => postReferences(b.body).propertyIds);
    expect(cards.length).toBeGreaterThanOrEqual(3);
    const live = await rows<{ n: number }>(
      `select count(*)::int as n from properties where id in (${cards.map((c) => `'${c}'`).join(",")}) and status = 'available'`,
    );
    expect(live[0]!.n).toBe(new Set(cards).size);

    // Guide numbers say where they come from; each guide has its own questions.
    const guides = await rows<{ stats: Array<{ source: string }>; faqs: number }>(
      "select g.stats, (select count(*)::int from faqs f where f.area_guide_id = g.id) as faqs from area_guides g",
    );
    for (const g of guides) {
      expect(g.stats.every((s) => s.source.length > 0)).toBe(true);
      expect(g.faqs).toBeGreaterThan(0);
    }
    // Covers, photos and portraits are counted as used.
    const [unused] = await rows<{ n: number }>(
      "select count(*)::int as n from media where folder in ('insights', 'areas', 'testimonials') and used_count = 0",
    );
    expect(unused!.n).toBe(0);
  });

  it("adds demo leads from every kind of source, with touches, stages, timelines and scores", async () => {
    // 40 with leads, and the inbox's own few people.
    // 45 from the CRM seed, and the demo customers' 3 tours.
    expect(result.counts).toMatchObject({ leads: 48 });
    expect(result.counts.contacts).toBeGreaterThanOrEqual(40);
    const sources = await rows<{ source: string; n: number }>(
      "select source, count(*)::int as n from leads group by source order by source",
    );
    expect(sources.map((x) => x.source)).toEqual([
      "callback",
      "chat",
      "form",
      "listing_request",
      "manual",
      "portal",
      "social_form",
      "tour",
      "valuation",
      "whatsapp",
    ]);
    const [facts] = await rows<{
      unanswered: number;
      touched: number;
      scored: number;
      won: number;
      lost: number;
      owners: number;
      events: number;
      tasks: number;
      stages: number;
    }>(`select
      (select count(*)::int from leads where first_response_at is null) as unanswered,
      (select count(*)::int from leads where first_touch is not null) as touched,
      (select count(*)::int from leads where ai_score is not null) as scored,
      (select count(*)::int from leads where status = 'won') as won,
      (select count(*)::int from leads where status = 'lost' and lost_reason is not null) as lost,
      (select count(*)::int from leads where type in ('seller', 'landlord')) as owners,
      (select count(*)::int from lead_events) as events,
      (select count(*)::int from lead_tasks) as tasks,
      (select count(*)::int from lead_stages) as stages`);
    expect(facts).toMatchObject({ scored: 45, owners: 5, stages: 6, won: 4, lost: 4 });
    expect(facts!.unanswered).toBeGreaterThan(3);
    expect(facts!.touched).toBeGreaterThan(30);
    expect(facts!.events).toBeGreaterThan(100);
    expect(facts!.tasks).toBeGreaterThan(10);
  });

  it("turns the footer newsletter on, with subscribers in each state", async () => {
    expect(result.counts.newsletter_subscribers).toBe(7);
    const states = await rows<{ confirmed: number; pending: number; unsubscribed: number }>(
      `select
        (count(*) filter (where confirmed_at is not null and unsubscribed_at is null))::int as confirmed,
        (count(*) filter (where confirmed_at is null and unsubscribed_at is null))::int as pending,
        (count(*) filter (where unsubscribed_at is not null))::int as unsubscribed
      from newsletter_subscribers`,
    );
    expect(states[0]).toEqual({ confirmed: 5, pending: 1, unsubscribed: 1 });
    expect((await loadSettings("website", await getDb())).footer.newsletter).toBe(true);
  });

  it("adds viewings: done ones with feedback, a no-show, and confirmed ones coming up", async () => {
    const byStatus = await rows<{ status: string; n: number; rated: number; ahead: number }>(
      `select status, count(*)::int as n, count(feedback_rating)::int as rated,
         count(*) filter (where starts_at > '2026-10-20T08:00:00Z')::int as ahead
       from viewings group by status order by status`,
    );
    const of = (s: string) => byStatus.find((x) => x.status === s);
    expect(of("done")!.n).toBeGreaterThan(4);
    expect(of("done")!.rated).toBeGreaterThan(2);
    expect(of("done")!.ahead).toBe(0);
    expect(of("no_show")!.n).toBe(1);
    expect(of("confirmed")!.n).toBe(of("confirmed")!.ahead);
    expect(of("confirmed")!.n).toBeGreaterThan(2);
    const [linked] = await rows<{ n: number }>(
      "select count(*)::int as n from viewings v where v.manage_token_hash is null or v.lead_id is null",
    );
    expect(linked!.n).toBe(0);
  });

  it("adds 3 demo customers with saved homes, searches, a compare set and past tours", async () => {
    expect(result.customers.map((c) => c.email)).toEqual([
      "mina@demo.propel",
      "omar.customer@demo.propel",
      "lucy@demo.propel",
    ]);
    expect(result.counts.saved_searches).toBe(3);
    expect(result.counts.saved_homes).toBeGreaterThanOrEqual(9);
    const [facts] = await rows<{ tours: number; compare: number; lists: number }>(`select
      (select count(*)::int from viewings v join contacts c on c.id = v.contact_id
        where c.user_id is not null and v.status = 'done') as tours,
      (select count(*)::int from compare_sets where user_id is not null) as compare,
      (select count(*)::int from saved_lists where not is_default) as lists`);
    expect(facts).toMatchObject({ tours: 3, compare: 1, lists: 1 });
  });

  it("adds owner requests and price trends for the demo areas (11 §5-7, 16 §1)", async () => {
    expect(result.counts).toMatchObject({ valuation_requests: 2, listing_requests: 1 });
    const [facts] = await rows<{ entered: number; areas: number; agency: number; note: string }>(`
      select
        (select count(*)::int from area_price_stats where source = 'admin_entered') as entered,
        (select count(distinct location_id)::int from area_price_stats
          where source = 'admin_entered') as areas,
        (select count(*)::int from area_price_stats where source = 'agency_data') as agency,
        (select min(source_note) from area_price_stats where source = 'admin_entered') as note`);
    // 12 months for sale (and rent where the area has rentals) in each of the 8 demo areas.
    expect(facts!.areas).toBe(8);
    expect(facts!.entered % 12).toBe(0);
    expect(facts!.entered).toBeGreaterThanOrEqual(8 * 12);
    expect(facts!.agency).toBeGreaterThan(0);
    expect(facts!.note).toBe("Sample data for demo");
    const marina = await rows<{ id: string }>(
      "select id from locations where slug = 'dubai-marina'",
    );
    const trends = await getPriceTrends(marina[0]!.id);
    expect(trends?.sale.series.length).toBeGreaterThan(0);
    expect(trends?.sale.series.map((x) => x.source)).toContain("admin_entered");
  });
});
