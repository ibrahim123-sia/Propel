import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pages } from "@/db/schema/cms";
import { areaGuides, postCategories, posts } from "@/db/schema/content";
import { developers, locations, propertyTypes } from "@/db/schema/master-data";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { properties } from "@/db/schema/properties";
import { liveStatuses, searchableStatuses } from "@/features/properties/status";
import type { SeoSettings } from "@/features/settings/schema";
import { landingIndexable } from "./landing";

/** Sitemap index sections (08 §6), one file each (split past 50,000 addresses). */
export const sitemapSections = [
  "pages",
  "properties",
  "projects",
  "areas",
  "posts",
  "agents",
  "developers",
] as const;
export type SitemapSection = (typeof sitemapSections)[number];

export type SitemapUrl = { path: string; lastModified: string | null };

/** Public calculator pages, listed in the sitemap's pages section. */
export const toolPaths = ["/tools/mortgage", "/tools/rental-returns"] as const;

/** Google's limit per sitemap file. */
export const SITEMAP_CHUNK = 50_000;

export type SitemapRules = Pick<
  SeoSettings,
  "soldListingDropDays" | "thinPageMinListings" | "landingTypeMinListings"
>;

/**
 * True when an item's canonical points somewhere else (then only that other address belongs
 * in the sitemap). Accepts paths and absolute addresses on this site.
 */
export function canonicalElsewhere(
  canonical: string | null,
  path: string,
  origin: string,
): boolean {
  if (!canonical) return false;
  let target = canonical.trim();
  if (target.startsWith(origin)) target = target.slice(origin.length) || "/";
  else if (/^https?:\/\//i.test(target)) return true;
  const clean = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return clean(target) !== clean(path);
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function latestModified(dates: Array<string | null>): string | null {
  return dates.reduce<string | null>((max, d) => (d && (!max || d > max) ? d : max), null);
}

type Seoish = { slug: string; noindex: boolean; canonicalUrl: string | null; updatedAt: Date };

function indexable<T extends Seoish>(
  rows: T[],
  toPath: (r: T) => string,
  origin: string,
): SitemapUrl[] {
  return rows
    .filter((r) => !r.noindex)
    .map((r) => ({ row: r, path: toPath(r) }))
    .filter(({ row, path }) => !canonicalElsewhere(row.canonicalUrl, path, origin))
    .map(({ row, path }) => ({ path, lastModified: iso(row.updatedAt) }));
}

export type LandingCount = {
  locationId: string | null;
  purpose: "sale" | "rent";
  completion: "off_plan" | null;
  typeSlug: string | null;
  n: number;
  lastModified: string | null;
};

/**
 * Listings a search can show, counted for the search hubs, per area (with everything inside
 * it) and per area and type: what the landing pages would list.
 */
export async function landingCounts(db: DbOrTx): Promise<LandingCount[]> {
  const agency = currentAgencyId();
  const res = await db.execute<{
    location_id: string | null;
    purpose: "sale" | "rent";
    completion: "off_plan" | null;
    type_slug: string | null;
    n: number;
    lastmod: Date | string | null;
  }>(sql`
    with recursive closure as (
      select id as ancestor, id as descendant from locations where agency_id = ${agency}
      union all
      select c.ancestor, l.id from closure c join locations l on l.parent_id = c.descendant
    ), live as (
      select p.id, p.location_id, p.purpose, p.completion, p.updated_at, pt.slug as type_slug
      from properties p left join property_types pt on pt.id = p.property_type_id
      where p.agency_id = ${agency} and p.deleted_at is null and p.published_at is not null
        and p.status in ${[...searchableStatuses]}
    )
    select null::uuid as location_id, purpose, null::text as completion, null::text as type_slug,
      count(*)::int as n, max(updated_at) as lastmod
      from live group by purpose
    union all
    select null::uuid, 'sale', 'off_plan', null::text, count(*)::int, max(updated_at)
      from live where purpose = 'sale' and completion = 'off_plan'
    union all
    select c.ancestor, l.purpose, null::text, null::text, count(*)::int, max(l.updated_at)
      from live l join closure c on c.descendant = l.location_id group by c.ancestor, l.purpose
    union all
    select c.ancestor, l.purpose, null::text, l.type_slug, count(*)::int, max(l.updated_at)
      from live l join closure c on c.descendant = l.location_id
      where l.type_slug is not null group by c.ancestor, l.purpose, l.type_slug`);
  return res.rows.map((r) => ({
    locationId: r.location_id,
    purpose: r.purpose,
    completion: r.completion,
    typeSlug: r.type_slug,
    n: Number(r.n),
    lastModified: r.lastmod ? new Date(r.lastmod).toISOString() : null,
  }));
}

async function pageUrls(db: DbOrTx, rules: SitemapRules, origin: string): Promise<SitemapUrl[]> {
  const agency = currentAgencyId();
  const rows = await db
    .select({
      slug: pages.slug,
      isHome: pages.isHome,
      noindex: pages.noindex,
      canonicalUrl: pages.canonicalUrl,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(and(eq(pages.agencyId, agency), eq(pages.status, "published"), isNull(pages.deletedAt)));
  const own = indexable(rows, (r) => (r.isHome ? "/" : `/${r.slug}`), origin);

  const counts = await landingCounts(db);
  const hub = (purpose: "sale" | "rent", completion: "off_plan" | null) =>
    counts.find(
      (c) => !c.locationId && !c.typeSlug && c.purpose === purpose && c.completion === completion,
    );
  const hubs: SitemapUrl[] = [];
  for (const [path, row] of [
    ["/buy", hub("sale", null)],
    ["/rent", hub("rent", null)],
    ["/off-plan", hub("sale", "off_plan")],
  ] as const) {
    if (row && landingIndexable("hub", row.n, rules))
      hubs.push({ path, lastModified: row.lastModified });
  }
  const res = await db.execute<{ projects: boolean; developers: boolean; agents: boolean }>(
    sql`select
      exists (select 1 from projects where agency_id = ${agency} and is_published and deleted_at is null) as projects,
      exists (select 1 from developers where agency_id = ${agency} and deleted_at is null) as developers,
      exists (select 1 from agents where agency_id = ${agency} and is_active) as agents`,
  );
  const any = res.rows[0];
  if (any?.projects) hubs.push({ path: "/projects", lastModified: null });
  if (any?.developers) hubs.push({ path: "/developers", lastModified: null });
  if (any?.agents) hubs.push({ path: "/agents", lastModified: null });
  // The buyer and investor tools (11 §1, §2) are always there.
  for (const path of toolPaths) hubs.push({ path, lastModified: null });

  // The home page is always listed, with its own date when it is a builder page.
  const home = own.find((u) => u.path === "/");
  const seen = new Set<string>();
  return [home ?? { path: "/", lastModified: null }, ...own, ...hubs].filter((u) => {
    if (seen.has(u.path)) return false;
    seen.add(u.path);
    return true;
  });
}

async function propertyUrls(
  db: DbOrTx,
  rules: SitemapRules,
  origin: string,
  now: Date,
): Promise<SitemapUrl[]> {
  const dropBefore = new Date(now.getTime() - rules.soldListingDropDays * 86_400_000);
  const rows = await db
    .select({
      slug: properties.slug,
      noindex: properties.noindex,
      canonicalUrl: properties.canonicalUrl,
      updatedAt: properties.updatedAt,
    })
    .from(properties)
    .where(
      and(
        eq(properties.agencyId, currentAgencyId()),
        isNull(properties.deletedAt),
        inArray(properties.status, [...liveStatuses]),
        // Sold and rented homes stay for the drop period after their last status change.
        sql`(${properties.status} not in ('sold', 'rented') or coalesce(
          (select max(a.created_at) from audit_log a where a.entity_type = 'property'
            and a.entity_id = ${properties.id}::text and a.action = 'property.status'),
          ${properties.updatedAt}) >= ${dropBefore.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(properties.publishedAt);
  return indexable(rows, (r) => `/property/${r.slug}`, origin);
}

async function areaUrls(db: DbOrTx, rules: SitemapRules, origin: string): Promise<SitemapUrl[]> {
  const agency = currentAgencyId();
  const locs = await db
    .select({
      id: locations.id,
      slug: locations.slug,
      noindex: locations.noindex,
      canonicalUrl: locations.canonicalUrl,
    })
    .from(locations)
    .where(eq(locations.agencyId, agency));
  const typeRows = await db
    .select({ slug: propertyTypes.slug })
    .from(propertyTypes)
    .where(eq(propertyTypes.agencyId, agency));
  const types = new Set(typeRows.map((t) => t.slug));
  const byId = new Map(locs.map((l) => [l.id, l]));
  const out: SitemapUrl[] = [];
  for (const c of await landingCounts(db)) {
    const loc = c.locationId ? byId.get(c.locationId) : undefined;
    if (!loc || loc.noindex) continue;
    const root = c.purpose === "rent" ? "/rent" : "/buy";
    if (c.typeSlug) {
      if (!types.has(c.typeSlug) || !landingIndexable("type", c.n, rules)) continue;
      out.push({ path: `${root}/${loc.slug}/${c.typeSlug}`, lastModified: c.lastModified });
    } else {
      const path = `${root}/${loc.slug}`;
      if (!landingIndexable("area", c.n, rules)) continue;
      if (canonicalElsewhere(loc.canonicalUrl, path, origin)) continue;
      out.push({ path, lastModified: c.lastModified });
    }
  }
  const guides = await db
    .select({
      slug: areaGuides.slug,
      noindex: areaGuides.noindex,
      canonicalUrl: areaGuides.canonicalUrl,
      updatedAt: areaGuides.updatedAt,
    })
    .from(areaGuides)
    .where(
      and(
        eq(areaGuides.agencyId, agency),
        eq(areaGuides.status, "published"),
        isNull(areaGuides.deletedAt),
      ),
    );
  const guideUrls = indexable(guides, (r) => `/areas/${r.slug}`, origin);
  if (guideUrls.length)
    out.push({
      path: "/areas",
      lastModified: latestModified(guideUrls.map((u) => u.lastModified)),
    });
  return [...out, ...guideUrls].sort((a, b) => a.path.localeCompare(b.path));
}

async function postUrls(db: DbOrTx, origin: string): Promise<SitemapUrl[]> {
  const agency = currentAgencyId();
  const rows = await db
    .select({
      slug: posts.slug,
      noindex: posts.noindex,
      canonicalUrl: posts.canonicalUrl,
      updatedAt: posts.updatedAt,
      categoryId: posts.categoryId,
    })
    .from(posts)
    .where(and(eq(posts.agencyId, agency), eq(posts.status, "published"), isNull(posts.deletedAt)));
  const live = indexable(rows, (r) => `/insights/${r.slug}`, origin);
  if (live.length === 0) return [];
  const used = [
    ...new Set(rows.map((r) => r.categoryId).filter((id): id is string => Boolean(id))),
  ];
  const cats = used.length
    ? await db
        .select({
          slug: postCategories.slug,
          noindex: postCategories.noindex,
          canonicalUrl: postCategories.canonicalUrl,
          updatedAt: postCategories.updatedAt,
        })
        .from(postCategories)
        .where(and(eq(postCategories.agencyId, agency), inArray(postCategories.id, used)))
    : [];
  return [
    { path: "/insights", lastModified: latestModified(live.map((u) => u.lastModified)) },
    ...indexable(cats, (r) => `/insights/category/${r.slug}`, origin),
    ...live,
  ];
}

/** Every address in one section, for its sitemap file. */
export async function sitemapUrls(
  db: DbOrTx,
  section: SitemapSection,
  rules: SitemapRules,
  origin: string,
  now = new Date(),
): Promise<SitemapUrl[]> {
  const agency = currentAgencyId();
  switch (section) {
    case "pages":
      return pageUrls(db, rules, origin);
    case "properties":
      return propertyUrls(db, rules, origin, now);
    case "areas":
      return areaUrls(db, rules, origin);
    case "posts":
      return postUrls(db, origin);
    case "projects": {
      const rows = await db
        .select({
          slug: projects.slug,
          noindex: projects.noindex,
          canonicalUrl: projects.canonicalUrl,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(
          and(
            eq(projects.agencyId, agency),
            eq(projects.isPublished, true),
            isNull(projects.deletedAt),
          ),
        );
      return indexable(rows, (r) => `/projects/${r.slug}`, origin);
    }
    case "agents": {
      const rows = await db
        .select({
          slug: agents.slug,
          noindex: agents.noindex,
          canonicalUrl: agents.canonicalUrl,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(eq(agents.agencyId, agency), eq(agents.isActive, true)));
      return indexable(rows, (r) => `/agents/${r.slug}`, origin);
    }
    case "developers": {
      const rows = await db
        .select({
          slug: developers.slug,
          noindex: developers.noindex,
          canonicalUrl: developers.canonicalUrl,
          updatedAt: developers.updatedAt,
        })
        .from(developers)
        .where(and(eq(developers.agencyId, agency), isNull(developers.deletedAt)));
      return indexable(rows, (r) => `/developers/${r.slug}`, origin);
    }
  }
}

/** File names for one section: "properties.xml", then "properties-2.xml" and so on. */
export function sectionFiles(section: SitemapSection, count: number): string[] {
  const chunks = Math.max(1, Math.ceil(count / SITEMAP_CHUNK));
  return Array.from({ length: chunks }, (_, i) =>
    i === 0 ? `${section}.xml` : `${section}-${i + 1}.xml`,
  );
}

/** "properties-2.xml" -> { section: "properties", chunk: 2 }; null for anything else. */
export function parseSitemapFile(file: string): { section: SitemapSection; chunk: number } | null {
  const m = /^([a-z]+)(?:-(\d{1,3}))?\.xml$/.exec(file);
  if (!m) return null;
  const section = sitemapSections.find((s) => s === m[1]);
  if (!section) return null;
  if (m[2] === undefined) return { section, chunk: 1 };
  const chunk = Number(m[2]);
  return chunk >= 2 ? { section, chunk } : null;
}

const escapeXml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function urlsetXml(urls: SitemapUrl[], origin: string): string {
  const body = urls
    .map((u) => {
      const loc = escapeXml(new URL(u.path, `${origin}/`).toString());
      return `<url><loc>${loc}</loc>${u.lastModified ? `<lastmod>${u.lastModified}</lastmod>` : ""}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

export function sitemapIndexXml(
  files: Array<{ file: string; lastModified: string | null }>,
  origin: string,
): string {
  const body = files
    .map((f) => {
      const loc = escapeXml(`${origin}/sitemaps/${f.file}`);
      return `<sitemap><loc>${loc}</loc>${f.lastModified ? `<lastmod>${f.lastModified}</lastmod>` : ""}</sitemap>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}
