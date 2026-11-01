import "server-only";
import { and, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pageRevisions, pages, type StoredSection } from "@/db/schema/cms";
import { seoRedirects } from "@/db/schema/seo";
import { findRedirect } from "@/features/seo/redirects";
import { loadSettings } from "@/features/settings/queries";
import { tags } from "@/lib/cache-tags";
import { verifyToken } from "@/lib/signed-token";
import { isValidSlug } from "@/lib/slug";
import type { PageTemplate } from "./page-schema";
import { parseSection, type Section } from "./sections";

/** A page as the site renders it (06 §1 "any /[slug]", the home page, the preview). */
export type PublicPage = {
  id: string;
  title: string;
  slug: string;
  template: PageTemplate;
  isHome: boolean;
  sections: Section[];
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  hideChat: boolean;
  /** When the live version was published (the legal template's "Last updated"). */
  publishedAt: string | null;
};

type Row = typeof pages.$inferSelect;

/** Visible, valid sections: hidden ones and anything that no longer validates are left out. */
export function visibleSections(raw: StoredSection[]): Section[] {
  return raw.map(parseSection).filter((s): s is Section => s !== null && !s.hidden);
}

export function toPublicPage(row: Row, sections: StoredSection[], publishedAt: Date | null) {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    template: row.template,
    isHome: row.isHome,
    sections: visibleSections(sections),
    seoTitle: row.seoTitle,
    seoDescription: row.seoDescription,
    ogImageId: row.ogImageId,
    canonicalUrl: row.canonicalUrl,
    noindex: row.noindex,
    hideChat: row.hideChat,
    publishedAt: publishedAt?.toISOString() ?? null,
  } satisfies PublicPage;
}

export async function lastPublishedAt(db: DbOrTx, pageId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(pageRevisions.createdAt) })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, pageId));
  return row?.at ?? null;
}

/** A published page by its address, or null (unknown, draft, scheduled or in the trash). */
export async function getPublicPage(slug: string): Promise<PublicPage | null> {
  "use cache";
  cacheLife("max");
  cacheTag(tags.pages);
  if (!isValidSlug(slug)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(pages)
    .where(
      and(
        eq(pages.agencyId, currentAgencyId()),
        eq(pages.slug, slug),
        eq(pages.status, "published"),
        isNull(pages.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  cacheTag(tags.page(row.id));
  return toPublicPage(row, row.sections, await lastPublishedAt(db, row.id));
}

/**
 * Where an old page address moved to (an automatic 301 from a slug change, or one added in
 * the redirects manager). Counts the hit.
 */
export async function pageRedirect(
  slug: string,
): Promise<{ to: string; permanent: boolean } | null> {
  if (!isValidSlug(slug)) return null;
  const db = await getDb();
  const row = await findRedirect(db, `/${slug}`);
  if (!row) return null;
  await db
    .update(seoRedirects)
    .set({ hits: sql`${seoRedirects.hits} + 1`, lastHitAt: new Date() })
    .where(eq(seoRedirects.id, row.id));
  return { to: row.toPath, permanent: row.type !== 302 };
}

export const PREVIEW_PURPOSE = "page-preview";

/**
 * The page behind a preview link (08 §1): its draft (or its sections when there is no draft),
 * whatever its status. Never cached: the editor's preview refreshes after every autosave.
 */
export async function getPreviewPage(
  token: string,
): Promise<(PublicPage & { expiresAt: string }) | null> {
  const payload = await verifyToken<{ p?: unknown; exp: number }>(PREVIEW_PURPOSE, token);
  if (!payload || typeof payload.p !== "string") return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(pages)
    .where(
      and(eq(pages.id, payload.p), eq(pages.agencyId, currentAgencyId()), isNull(pages.deletedAt)),
    )
    .limit(1);
  if (!row) return null;
  return {
    ...toPublicPage(row, row.draftSections ?? row.sections, await lastPublishedAt(db, row.id)),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

/** The addresses of all published pages (one cache entry, so unknown slugs cost nothing). */
export async function publishedPageSlugs(): Promise<string[]> {
  "use cache";
  cacheLife("max");
  cacheTag(tags.pages);
  const db = await getDb();
  const rows = await db
    .select({ slug: pages.slug })
    .from(pages)
    .where(
      and(
        eq(pages.agencyId, currentAgencyId()),
        eq(pages.status, "published"),
        isNull(pages.deletedAt),
      ),
    );
  return rows.map((r) => r.slug);
}

/** The published page at /[slug], or null. Unknown addresses never reach the per-page cache. */
export async function findPublicPage(slug: string): Promise<PublicPage | null> {
  if (!isValidSlug(slug)) return null;
  if (!(await publishedPageSlugs()).includes(slug)) return null;
  return getPublicPage(slug);
}

export type PageLink = { label: string; href: string };

/** The policy pages chosen in Settings -> Legal that are published, for footers and banners. */
export async function legalPageLinks(): Promise<{
  privacy: PageLink | null;
  terms: PageLink | null;
  cookies: PageLink | null;
}> {
  "use cache";
  cacheLife("max");
  cacheTag(tags.pages, tags.settings("legal"));
  const db = await getDb();
  const legal = await loadSettings("legal", db);
  const ids = [legal.privacyPageId, legal.termsPageId, legal.cookiePageId].filter(
    (x): x is string => !!x,
  );
  const rows = ids.length
    ? await db
        .select({ id: pages.id, title: pages.title, slug: pages.slug, isHome: pages.isHome })
        .from(pages)
        .where(
          and(
            eq(pages.agencyId, currentAgencyId()),
            inArray(pages.id, ids),
            eq(pages.status, "published"),
            isNull(pages.deletedAt),
          ),
        )
    : [];
  const link = (id: string | null) => {
    const row = rows.find((r) => r.id === id);
    return row ? { label: row.title, href: row.isHome ? "/" : `/${row.slug}` } : null;
  };
  return {
    privacy: link(legal.privacyPageId),
    terms: link(legal.termsPageId),
    cookies: link(legal.cookiePageId),
  };
}
