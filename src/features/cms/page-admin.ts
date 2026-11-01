import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { users } from "@/db/schema/auth";
import { pageRevisions, pages, pageTemplates } from "@/db/schema/cms";
import { faqs, postCategories, testimonials } from "@/db/schema/content";
import { developers, locations } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { agents } from "@/db/schema/people";
import { projects } from "@/db/schema/projects";
import { toMediaItem, type MediaItem } from "@/features/media/queries";
import { loadSettings } from "@/features/settings/queries";
import type { TableParams } from "@/lib/table-params";
import type { PageStatus, PageTemplate } from "./page-schema";
import { pageMediaIds } from "./page-store";
import { forEditor, type EditorSection } from "./section-rules";

/** Admin -> Website -> Pages: the list (08 §1 "Page list") and the editor's data. */

export const pageSortable = ["updated", "title"] as const;
export type PageSort = (typeof pageSortable)[number];

export type PageListRow = {
  id: string;
  title: string;
  slug: string;
  status: PageStatus;
  template: PageTemplate;
  isHome: boolean;
  publishAt: string | null;
  hasDraft: boolean;
  version: number;
  updatedAt: string;
  updatedByName: string | null;
  inTrash: boolean;
};

function filters(params: Pick<TableParams<string>, "q" | "get">): SQL[] {
  const where: SQL[] = [eq(pages.agencyId, currentAgencyId())];
  where.push(params.get("trash") === "1" ? isNotNull(pages.deletedAt) : isNull(pages.deletedAt));
  const status = params.get("status");
  if (status === "draft" || status === "published" || status === "scheduled")
    where.push(eq(pages.status, status));
  const template = params.get("template");
  if (template && (pageTemplates as readonly string[]).includes(template))
    where.push(eq(pages.template, template as PageTemplate));
  if (params.q) {
    const like = `%${params.q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push(or(ilike(pages.title, like), ilike(pages.slug, like))!);
  }
  return where;
}

export async function listPages(
  params: TableParams<PageSort>,
  db?: DbOrTx,
): Promise<{ rows: PageListRow[]; total: number; trashCount: number }> {
  const conn = db ?? (await getDb());
  const where = and(...filters(params));
  const order =
    params.sort.id === "title"
      ? [params.sort.desc ? desc(pages.title) : asc(pages.title)]
      : [params.sort.desc ? desc(pages.updatedAt) : asc(pages.updatedAt)];
  const rows = await conn
    .select({
      id: pages.id,
      title: pages.title,
      slug: pages.slug,
      status: pages.status,
      template: pages.template,
      isHome: pages.isHome,
      publishAt: pages.publishAt,
      hasDraft: sql<boolean>`${pages.draftSections} is not null`,
      version: pages.version,
      updatedAt: pages.updatedAt,
      updatedByName: users.name,
      deletedAt: pages.deletedAt,
    })
    .from(pages)
    .leftJoin(users, eq(users.id, pages.updatedBy))
    .where(where)
    .orderBy(desc(pages.isHome), ...order, desc(pages.id))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize);
  const [count] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(where);
  const [trash] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.agencyId, currentAgencyId()), isNotNull(pages.deletedAt)));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      status: r.status,
      template: r.template,
      isHome: r.isHome,
      publishAt: r.publishAt?.toISOString() ?? null,
      hasDraft: r.hasDraft,
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
      updatedByName: r.updatedByName,
      inTrash: r.deletedAt !== null,
    })),
    total: count?.n ?? 0,
    trashCount: trash?.n ?? 0,
  };
}

export type PageRevisionItem = {
  id: string;
  createdAt: string;
  byName: string | null;
  title: string;
  sections: number;
};

export type Option = { id: string; name: string; detail?: string };

/** Everything the pickers in section settings choose from (listings are searched instead). */
export type SectionOptions = {
  projects: Option[];
  locations: Array<Option & { level: string; parentId: string | null }>;
  agents: Option[];
  developers: Option[];
  testimonials: Option[];
  faqs: Array<Option & { group: string }>;
  postCategories: Option[];
};

export type PageEditorData = {
  page: {
    id: string;
    title: string;
    slug: string;
    status: PageStatus;
    template: PageTemplate;
    isHome: boolean;
    publishAt: string | null;
    version: number;
    seoTitle: string | null;
    seoDescription: string | null;
    ogImageId: string | null;
    canonicalUrl: string | null;
    noindex: boolean;
    hideChat: boolean;
    updatedAt: string;
    draftUpdatedAt: string | null;
  };
  /** The draft when there is one, else what the site shows. */
  sections: EditorSection[];
  hasDraft: boolean;
  hasBeenPublished: boolean;
  revisions: PageRevisionItem[];
  media: Record<string, MediaItem>;
  options: SectionOptions;
  /** Which policy this page is in Settings -> Legal, if any. */
  legalRole: string | null;
  allowScripts: boolean;
};

export async function loadSectionOptions(db: DbOrTx): Promise<SectionOptions> {
  const agency = currentAgencyId();
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, isPublished: projects.isPublished })
    .from(projects)
    .where(and(eq(projects.agencyId, agency), isNull(projects.deletedAt)))
    .orderBy(asc(projects.name))
    .limit(500);
  const locationRows = await db
    .select({
      id: locations.id,
      name: locations.name,
      level: locations.level,
      parentId: locations.parentId,
    })
    .from(locations)
    .where(eq(locations.agencyId, agency))
    .orderBy(asc(locations.sortOrder), asc(locations.name))
    .limit(2000);
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, title: agents.title, isActive: agents.isActive })
    .from(agents)
    .where(eq(agents.agencyId, agency))
    .orderBy(asc(agents.sortOrder), asc(agents.name))
    .limit(500);
  const developerRows = await db
    .select({ id: developers.id, name: developers.name })
    .from(developers)
    .where(and(eq(developers.agencyId, agency), isNull(developers.deletedAt)))
    .orderBy(asc(developers.name))
    .limit(500);
  const testimonialRows = await db
    .select({
      id: testimonials.id,
      name: testimonials.name,
      quote: testimonials.quote,
      isPublished: testimonials.isPublished,
    })
    .from(testimonials)
    .where(eq(testimonials.agencyId, agency))
    .orderBy(asc(testimonials.sortOrder), desc(testimonials.createdAt))
    .limit(500);
  const faqRows = await db
    .select({
      id: faqs.id,
      question: faqs.question,
      group: faqs.group,
      isPublished: faqs.isPublished,
    })
    .from(faqs)
    .where(and(eq(faqs.agencyId, agency), isNull(faqs.areaGuideId)))
    .orderBy(asc(faqs.group), asc(faqs.sortOrder))
    .limit(1000);
  const categoryRows = await db
    .select({ id: postCategories.id, name: postCategories.name })
    .from(postCategories)
    .where(eq(postCategories.agencyId, agency))
    .orderBy(asc(postCategories.sortOrder), asc(postCategories.name))
    .limit(200);
  const hidden = (shown: boolean) => (shown ? undefined : "Not published");
  return {
    projects: projectRows.map((p) => ({ id: p.id, name: p.name, detail: hidden(p.isPublished) })),
    locations: locationRows,
    agents: agentRows.map((a) => ({
      id: a.id,
      name: a.name,
      detail: a.isActive ? (a.title ?? undefined) : "Turned off",
    })),
    developers: developerRows,
    testimonials: testimonialRows.map((t) => ({
      id: t.id,
      name: t.name,
      detail: t.isPublished ? t.quote.slice(0, 80) : "Not published",
    })),
    faqs: faqRows.map((f) => ({
      id: f.id,
      name: f.question,
      group: f.group,
      detail: hidden(f.isPublished),
    })),
    postCategories: categoryRows,
  };
}

export async function loadPageEditorData(db: DbOrTx, id: string): Promise<PageEditorData | null> {
  const [row] = await db
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), eq(pages.agencyId, currentAgencyId()), isNull(pages.deletedAt)));
  if (!row) return null;
  const revisionRows = await db
    .select({
      id: pageRevisions.id,
      createdAt: pageRevisions.createdAt,
      byName: users.name,
      seo: pageRevisions.seo,
      sections: sql<number>`jsonb_array_length(${pageRevisions.sections})::int`,
    })
    .from(pageRevisions)
    .leftJoin(users, eq(users.id, pageRevisions.createdBy))
    .where(eq(pageRevisions.pageId, id))
    .orderBy(desc(pageRevisions.createdAt), desc(pageRevisions.id))
    .limit(20);
  const ids = [...new Set(pageMediaIds(row))];
  const files = ids.length
    ? await db
        .select()
        .from(media)
        .where(and(inArray(media.id, ids), eq(media.agencyId, currentAgencyId())))
    : [];
  const options = await loadSectionOptions(db);
  const legal = await loadSettings("legal", db);
  const security = await loadSettings("security", db);
  const legalRoles: Array<[string | null, string]> = [
    [legal.privacyPageId, "Privacy policy"],
    [legal.termsPageId, "Terms of use"],
    [legal.cookiePageId, "Cookie policy"],
    [legal.howWeVerifyPageId, "How we verify listings"],
  ];
  return {
    page: {
      id: row.id,
      title: row.title,
      slug: row.slug,
      status: row.status,
      template: row.template,
      isHome: row.isHome,
      publishAt: row.publishAt?.toISOString() ?? null,
      version: row.version,
      seoTitle: row.seoTitle,
      seoDescription: row.seoDescription,
      ogImageId: row.ogImageId,
      canonicalUrl: row.canonicalUrl,
      noindex: row.noindex,
      hideChat: row.hideChat,
      updatedAt: row.updatedAt.toISOString(),
      draftUpdatedAt: row.draftUpdatedAt?.toISOString() ?? null,
    },
    sections: forEditor(row.draftSections ?? row.sections),
    hasDraft: row.draftSections !== null,
    hasBeenPublished: revisionRows.length > 0,
    revisions: revisionRows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      byName: r.byName,
      title: typeof r.seo.title === "string" ? r.seo.title : row.title,
      sections: r.sections,
    })),
    media: Object.fromEntries(files.map((f) => [f.id, toMediaItem(f)])),
    options,
    legalRole: legalRoles.find(([pageId]) => pageId === row.id)?.[1] ?? null,
    allowScripts: security.allowCustomHtmlScripts,
  };
}
