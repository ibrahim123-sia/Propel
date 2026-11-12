import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { pages } from "@/db/schema/cms";
import { areaGuides, postCategories, posts } from "@/db/schema/content";
import { developers, locations, propertyTypes } from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { properties } from "@/db/schema/properties";
import { auditLog } from "@/db/schema/system";
import { sitemapUrls, type SitemapSection } from "@/features/seo/sitemap";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { newId } from "@/lib/ids";
import { GET as sitemapIndex } from "@/app/sitemap.xml/route";
import { GET as sitemapFile } from "@/app/sitemaps/[file]/route";
import robots from "@/app/robots";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

const origin = "http://localhost:3000";
const rules = { soldListingDropDays: 90, thinPageMinListings: 3, landingTypeMinListings: 5 };
const now = new Date("2026-10-21T12:00:00.000Z");
let n = 0;

async function listing(values: Partial<typeof properties.$inferInsert>) {
  const db = await getDb();
  const id = newId();
  n++;
  await db.insert(properties).values({
    id,
    reference: `LT-${8000 + n}`,
    title: `Listing ${n}`,
    slug: `listing-${n}`,
    purpose: "sale",
    status: "available",
    publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    currency: "AED",
    ...values,
  });
  return id;
}

const paths = async (section: SitemapSection) =>
  (await sitemapUrls(await getDb(), section, rules, origin, now)).map((u) => u.path);

describe("sitemap and robots", () => {
  let ids: Record<string, string>;
  beforeEach(async () => {
    n = 0;
    await truncate(
      "properties",
      "projects",
      "developers",
      "agents",
      "locations",
      "property_types",
      "pages",
      "posts",
      "post_categories",
      "area_guides",
      "settings",
      "audit_log",
    );
    const db = await getDb();
    ids = { city: newId(), harbour: newId(), hills: newId(), villa: newId(), apt: newId() };
    await db.insert(locations).values([
      { id: ids.city!, level: "city", name: "Coastal City", slug: "coastal-city" },
      {
        id: ids.harbour!,
        parentId: ids.city,
        level: "area",
        name: "Old Harbour",
        slug: "old-harbour",
      },
      {
        id: ids.hills!,
        parentId: ids.city,
        level: "area",
        name: "Quiet Hills",
        slug: "quiet-hills",
      },
    ]);
    await db.insert(propertyTypes).values([
      { id: ids.villa!, name: "Villa", slug: "villas" },
      { id: ids.apt!, name: "Apartment", slug: "apartments" },
    ]);
  });

  it("lists live listings, keeps sold ones for the drop period, skips noindex and canonicals", async () => {
    await listing({ slug: "live-one" });
    await listing({ slug: "hidden", noindex: true });
    await listing({ slug: "copy", canonicalUrl: "/property/live-one" });
    await listing({ slug: "draft", status: "draft", publishedAt: null });
    const recent = await listing({ slug: "sold-recently", status: "sold" });
    const old = await listing({ slug: "sold-long-ago", status: "sold" });
    const db = await getDb();
    await db.insert(auditLog).values([
      {
        actorType: "admin",
        actorId: testAdmin.id,
        action: "property.status",
        entityType: "property",
        entityId: recent,
        createdAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      {
        actorType: "admin",
        actorId: testAdmin.id,
        action: "property.status",
        entityType: "property",
        entityId: old,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    ]);
    expect((await paths("properties")).sort()).toEqual([
      "/property/live-one",
      "/property/sold-recently",
    ]);
  });

  it("lists area landings with enough homes, and type landings above their own minimum", async () => {
    for (let i = 0; i < 5; i++)
      await listing({ locationId: ids.harbour, propertyTypeId: ids.villa });
    await listing({ locationId: ids.hills, propertyTypeId: ids.apt });
    await listing({ locationId: ids.hills, propertyTypeId: ids.apt, purpose: "rent" });
    const db = await getDb();
    await db.insert(areaGuides).values({
      locationId: ids.harbour!,
      title: "Living in Old Harbour",
      slug: "old-harbour",
      status: "published",
    });
    expect(await paths("areas")).toEqual([
      "/areas",
      "/areas/old-harbour",
      "/buy/coastal-city",
      "/buy/coastal-city/villas",
      "/buy/old-harbour",
      "/buy/old-harbour/villas",
    ]);
    // The hubs follow the same thin-page rule: 6 for sale, 1 to rent.
    const pageList = await paths("pages");
    expect(pageList).toContain("/buy");
    expect(pageList).not.toContain("/rent");
  });

  it("lists published pages, projects, posts, agents and developers", async () => {
    const db = await getDb();
    await db.insert(pages).values([
      { title: "Home", slug: "home", status: "published", isHome: true },
      { title: "About", slug: "about", status: "published" },
      { title: "Draft", slug: "draft", status: "draft" },
      { title: "Hidden", slug: "hidden", status: "published", noindex: true },
    ]);
    const dev = newId();
    await db.insert(developers).values({ id: dev, name: "Dune Homes", slug: "dune-homes" });
    await db.insert(projects).values([
      { name: "Pier Seven", slug: "pier-seven", isPublished: true, developerId: dev },
      { name: "Secret", slug: "secret", isPublished: false },
    ]);
    const cat = newId();
    await db.insert(postCategories).values({ id: cat, name: "Guides", slug: "guides" });
    await db.insert(posts).values([
      { title: "How to buy", slug: "how-to-buy", status: "published", categoryId: cat },
      { title: "Soon", slug: "soon", status: "draft" },
    ]);
    await db.insert(agents).values([
      { name: "Sara Khan", slug: "sara-khan", email: "sara@agency.example" },
      { name: "Left", slug: "left", email: "left@agency.example", isActive: false },
    ]);
    expect(await paths("pages")).toEqual([
      "/",
      "/about",
      "/projects",
      "/developers",
      "/agents",
      "/tools/mortgage",
      "/tools/rental-returns",
    ]);
    expect(await paths("projects")).toEqual(["/projects/pier-seven"]);
    expect(await paths("posts")).toEqual([
      "/insights",
      "/insights/category/guides",
      "/insights/how-to-buy",
    ]);
    expect(await paths("agents")).toEqual(["/agents/sara-khan"]);
    expect(await paths("developers")).toEqual(["/developers/dune-homes"]);

    // The routes: the index lists the non-empty files; each file is a urlset.
    const index = await (await sitemapIndex()).text();
    expect(index).toContain("<loc>http://localhost:3000/sitemaps/pages.xml</loc>");
    expect(index).toContain("/sitemaps/posts.xml");
    expect(index).not.toContain("/sitemaps/properties.xml");
    const file = await sitemapFile(new Request(`${origin}/sitemaps/projects.xml`), {
      params: Promise.resolve({ file: "projects.xml" }),
    });
    expect(file.headers.get("content-type")).toContain("application/xml");
    expect(await file.text()).toContain("<loc>http://localhost:3000/projects/pier-seven</loc>");
    const missing = await sitemapFile(new Request(`${origin}/sitemaps/x.xml`), {
      params: Promise.resolve({ file: "secrets.xml" }),
    });
    expect(missing.status).toBe(404);
  });

  it("robots.txt follows Settings -> SEO", async () => {
    expect(await robots()).toMatchObject({
      rules: { userAgent: "*", allow: "/" },
      sitemap: "http://localhost:3000/sitemap.xml",
    });
    await patchSettings(
      await getDb(),
      "seo",
      { ...defaultsFor("seo"), allowIndexing: false },
      { type: "admin", id: testAdmin.id },
    );
    expect(await robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});
