"use server";

import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pageRevisions, pages } from "@/db/schema/cms";
import { media } from "@/db/schema/media";
import { properties } from "@/db/schema/properties";
import { auditLog } from "@/db/schema/system";
import { syncMediaUsage } from "@/features/media/usage";
import { redirectSlugChange } from "@/features/seo/redirects";
import { loadSettings } from "@/features/settings/queries";
import { ActionError, adminAction } from "@/lib/actions";
import { auditChange, writeAudit, type AuditActor } from "@/lib/audit";
import { signToken } from "@/lib/signed-token";
import { slugify } from "@/lib/slug";
import { siteUrl } from "@/features/site/url";
import {
  PREVIEW_LINK_DAYS,
  type ListingOption,
  newPageSchema,
  pageRefSchema,
  pageVersionedSchema,
  reservedSlugs,
  restoreRevisionSchema,
  saveDraftSchema,
  saveSettingsSchema,
  scheduleSchema,
} from "./page-schema";
import {
  checkDraft,
  clearRedirectFrom,
  hasBeenPublished,
  loadPageRow,
  pageForWrite,
  pageMediaIds,
  pageSlug,
  publishPageRecord,
  sectionsForPublish,
  slugTakenBy,
  stableJson,
  starterSections,
  workingSections,
  type PageRow,
} from "./page-store";
import { PREVIEW_PURPOSE } from "./page-public";
import { revalidatePage } from "./page-tags";
import { forEditor } from "./section-rules";

/** Admin -> Website -> Pages (08 §1). Every change is audited; the site's caches follow. */

const iso = (d: Date) => d.toISOString();

/** A slug for a new page: from the title, never one the site already uses. */
async function freshSlug(db: DbOrTx, title: string, exceptId: string | null) {
  const base = slugify(title);
  return pageSlug(db, reservedSlugs.has(base) ? `${base}-page` : base, exceptId);
}

/** "Legal pages" in Settings -> Legal point at pages: those can't go to the trash. */
async function legalUse(db: DbOrTx, id: string): Promise<string | null> {
  const legal = await loadSettings("legal", db);
  const uses: Array<[string | null, string]> = [
    [legal.privacyPageId, "privacy policy"],
    [legal.termsPageId, "terms of use"],
    [legal.cookiePageId, "cookie policy"],
    [legal.howWeVerifyPageId, "“How we verify listings” page"],
  ];
  return uses.find(([pageId]) => pageId === id)?.[1] ?? null;
}

const settingsOf = (r: PageRow) => ({
  title: r.title,
  slug: r.slug,
  template: r.template,
  seoTitle: r.seoTitle,
  seoDescription: r.seoDescription,
  ogImageId: r.ogImageId,
  canonicalUrl: r.canonicalUrl,
  noindex: r.noindex,
  hideChat: r.hideChat,
});

/** "New page": title and a starting layout; it opens in the editor next. */
export const createPage = adminAction(newPageSchema, { write: true }, async (input, ctx) => {
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const sections = starterSections(input.starter, input.title);
    const [created] = await tx
      .insert(pages)
      .values({
        title: input.title,
        slug: await freshSlug(tx, input.title, null),
        template:
          input.starter === "legal" ? "legal" : input.starter === "landing" ? "landing" : "default",
        status: "draft",
        sections: [],
        draftSections: sections,
        draftUpdatedAt: new Date(),
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      })
      .returning();
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.create",
      entityType: "page",
      entityId: created!.id,
      after: { title: created!.title, slug: created!.slug, template: created!.template },
    });
    return created!;
  });
  revalidatePage(row.id);
  return { id: row.id, slug: row.slug };
});

/** "Duplicate": a draft copy with the same sections and SEO text, under a new address. */
export const duplicatePage = adminAction(pageRefSchema, { write: true }, async ({ id }, ctx) => {
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const source = await pageForWrite(tx, id, null);
    const title = `${source.title} (copy)`.slice(0, 120);
    const [created] = await tx
      .insert(pages)
      .values({
        title,
        slug: await freshSlug(tx, title, null),
        template: source.template,
        status: "draft",
        sections: [],
        draftSections: workingSections(source),
        draftUpdatedAt: new Date(),
        seoTitle: source.seoTitle,
        seoDescription: source.seoDescription,
        ogImageId: source.ogImageId,
        noindex: source.noindex,
        hideChat: source.hideChat,
        createdBy: ctx.user.id,
        updatedBy: ctx.user.id,
      })
      .returning();
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.duplicate",
      entityType: "page",
      entityId: created!.id,
      after: { title: created!.title, slug: created!.slug, from: source.id },
    });
    await syncMediaUsage(tx, pageMediaIds(created!));
    return created!;
  });
  revalidatePage(row.id);
  return { id: row.id, slug: row.slug };
});

/** "Move to trash": off the site at once; restore or delete it for good from the trash. */
export const trashPage = adminAction(pageRefSchema, { write: true }, async ({ id }, ctx) => {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const row = await pageForWrite(tx, id, null);
    if (row.isHome)
      throw new ActionError("This is the home page. Set another page as home first.", "IN_USE");
    const legal = await legalUse(tx, id);
    if (legal)
      throw new ActionError(
        `This page is the ${legal} in Settings -> Legal. Choose another page there first.`,
        "IN_USE",
      );
    await tx
      .update(pages)
      .set({ deletedAt: new Date(), publishAt: null, updatedBy: ctx.user.id })
      .where(eq(pages.id, id));
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.trash",
      entityType: "page",
      entityId: id,
      before: { title: row.title, slug: row.slug, status: row.status },
    });
    await syncMediaUsage(tx, pageMediaIds(row));
  });
  revalidatePage(id);
  return { id };
});

/** Back from the trash as a draft: publishing it again is a separate, deliberate step. */
export const restorePage = adminAction(pageRefSchema, { write: true }, async ({ id }, ctx) => {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const row = await loadPageRow(tx, id);
    if (!row || !row.deletedAt)
      throw new ActionError("This page is not in the trash.", "NOT_FOUND");
    await tx
      .update(pages)
      .set({ deletedAt: null, status: "draft", publishAt: null, updatedBy: ctx.user.id })
      .where(eq(pages.id, id));
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.restore",
      entityType: "page",
      entityId: id,
      after: { title: row.title, slug: row.slug, status: "draft" },
    });
    await syncMediaUsage(tx, pageMediaIds(row));
  });
  revalidatePage(id);
  return { id };
});

/** Delete for good (only from the trash): the page and its revisions are gone. */
export const deletePage = adminAction(pageRefSchema, { write: true }, async ({ id }, ctx) => {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const row = await loadPageRow(tx, id);
    if (!row) throw new ActionError("This page no longer exists.", "NOT_FOUND");
    if (!row.deletedAt) throw new ActionError("Move the page to the trash first.", "NOT_IN_TRASH");
    await tx.delete(pages).where(eq(pages.id, id));
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.delete",
      entityType: "page",
      entityId: id,
      before: settingsOf(row),
    });
    await syncMediaUsage(tx, pageMediaIds(row));
  });
  revalidatePage(id);
  return { id };
});

/** "Set as home" (08 §1): one home page; it must be published so "/" never goes blank. */
export const setHomePage = adminAction(pageRefSchema, { write: true }, async ({ id }, ctx) => {
  const db = await getDb();
  const previous = await db.transaction(async (tx) => {
    const row = await pageForWrite(tx, id, null);
    if (row.isHome) return { old: null, updatedAt: row.updatedAt };
    if (row.status !== "published")
      throw new ActionError("Publish this page before making it the home page.", "NOT_PUBLISHED");
    const [old] = await tx
      .update(pages)
      .set({ isHome: false, updatedBy: ctx.user.id })
      .where(
        and(eq(pages.agencyId, currentAgencyId()), eq(pages.isHome, true), isNull(pages.deletedAt)),
      )
      .returning({ id: pages.id, title: pages.title });
    const [after] = await tx
      .update(pages)
      .set({ isHome: true, template: "default", updatedBy: ctx.user.id })
      .where(eq(pages.id, id))
      .returning({ updatedAt: pages.updatedAt });
    await writeAudit(tx, {
      actor: ctx.actor,
      action: "page.set_home",
      entityType: "page",
      entityId: id,
      before: { home: old ? { id: old.id, title: old.title } : null },
      after: { home: { id, title: row.title } },
    });
    return { old: old?.id ?? null, updatedAt: after!.updatedAt };
  });
  revalidatePage(id);
  if (previous?.old) revalidatePage(previous.old);
  return { id, updatedAt: iso(previous.updatedAt) };
});

/** Title, address, template and SEO (08 §1 top bar, 08 §6 SEO panel). Applies at once. */
export const savePageSettings = adminAction(
  saveSettingsSchema,
  { write: true },
  async ({ id, expectedUpdatedAt, data }, ctx) => {
    const db = await getDb();
    const res = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      const taken = await slugTakenBy(tx, data.slug, id);
      if (taken)
        throw new ActionError("Please check the highlighted fields.", "VALIDATION", {
          slug: [
            taken.deletedAt
              ? "A page in the trash uses this address. Delete it for good first, or choose another."
              : `The page "${taken.title}" already uses this address.`,
          ],
        });
      if (data.ogImageId) {
        const [file] = await tx
          .select({ id: media.id, status: media.status })
          .from(media)
          .where(and(eq(media.id, data.ogImageId), eq(media.agencyId, currentAgencyId())));
        if (!file || file.status === "failed")
          throw new ActionError("Please check the highlighted fields.", "VALIDATION", {
            ogImageId: ["This image was removed from the library."],
          });
      }
      const [after] = await tx
        .update(pages)
        .set({
          title: data.title,
          slug: data.slug,
          // The home page lives at "/" with the site's header and footer.
          template: row.isHome ? "default" : data.template,
          seoTitle: data.seoTitle || null,
          seoDescription: data.seoDescription || null,
          ogImageId: data.ogImageId,
          canonicalUrl: data.canonicalUrl || null,
          noindex: data.noindex,
          hideChat: data.hideChat,
          updatedBy: ctx.user.id,
        })
        .where(eq(pages.id, id))
        .returning();
      // A slug change on a page people may have found adds a 301 from the old address.
      const redirected =
        row.slug !== after!.slug &&
        (row.status === "published" || (await hasBeenPublished(tx, id)));
      if (redirected)
        await redirectSlugChange(tx, {
          entity: "page",
          entityId: id,
          oldSlug: row.slug,
          newSlug: after!.slug,
          actorId: ctx.user.id,
        });
      if (row.slug !== after!.slug && after!.status === "published")
        await clearRedirectFrom(tx, after!.slug);
      await auditChange(tx, {
        actor: ctx.actor,
        action: "page.update",
        entityType: "page",
        entityId: id,
        before: settingsOf(row),
        after: settingsOf(after!),
      });
      if (row.ogImageId !== after!.ogImageId)
        await syncMediaUsage(tx, [row.ogImageId, after!.ogImageId]);
      return { row: after!, redirected };
    });
    revalidatePage(id, { redirects: res.redirected });
    return {
      updatedAt: iso(res.row.updatedAt),
      slug: res.row.slug,
      template: res.row.template,
      redirected: res.redirected,
    };
  },
);

/** Audit draft saves without flooding the log: one entry per admin per page per 10 minutes. */
async function auditDraft(
  db: DbOrTx,
  args: { actor: AuditActor; pageId: string; sections: number },
) {
  const [last] = await db
    .select({ action: auditLog.action, actorId: auditLog.actorId, at: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "page"), eq(auditLog.entityId, args.pageId)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (
    last &&
    last.action === "page.draft" &&
    last.actorId === args.actor.id &&
    Date.now() - last.at.getTime() < 10 * 60_000
  )
    return;
  await writeAudit(db, {
    actor: args.actor,
    action: "page.draft",
    entityType: "page",
    entityId: args.pageId,
    after: { sections: args.sections },
  });
}

/**
 * The editor's autosave: the working copy of the sections (08 §1). The site keeps showing the
 * published version until Publish. Unfinished sections are saved and reported, not refused.
 */
export const savePageDraft = adminAction(
  saveDraftSchema,
  { write: true },
  async ({ id, expectedUpdatedAt, sections: raw }, ctx) => {
    const db = await getDb();
    const res = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      const { sections, problems } = checkDraft(raw);
      const sameAsLive = stableJson(sections) === stableJson(row.sections);
      const [after] = await tx
        .update(pages)
        .set({
          draftSections: sameAsLive ? null : sections,
          draftUpdatedAt: sameAsLive ? null : new Date(),
          updatedBy: ctx.user.id,
        })
        .where(eq(pages.id, id))
        .returning();
      await auditDraft(tx, {
        actor: ctx.actor,
        pageId: id,
        sections: sections.length,
      });
      await syncMediaUsage(tx, [...pageMediaIds(row), ...pageMediaIds(after!)]);
      return { row: after!, problems };
    });
    // Only the preview shows drafts; the public page is unchanged.
    revalidatePage(id, { draftOnly: true });
    return {
      updatedAt: iso(res.row.updatedAt),
      hasDraft: res.row.draftSections !== null,
      problems: res.problems,
    };
  },
);

/** "Discard changes": back to the published sections. */
export const discardPageDraft = adminAction(
  pageVersionedSchema,
  { write: true },
  async ({ id, expectedUpdatedAt }, ctx) => {
    const db = await getDb();
    const after = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      if (row.draftSections === null) return row;
      const [updated] = await tx
        .update(pages)
        .set({
          draftSections: null,
          draftUpdatedAt: null,
          // Scheduled changes to a live page go with the draft.
          ...(row.status === "published" ? { publishAt: null } : {}),
          updatedBy: ctx.user.id,
        })
        .where(eq(pages.id, id))
        .returning();
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "page.discard_draft",
        entityType: "page",
        entityId: id,
        before: { draftSections: row.draftSections.length },
      });
      await syncMediaUsage(tx, pageMediaIds(row));
      return updated!;
    });
    revalidatePage(id, { draftOnly: true });
    return { updatedAt: iso(after.updatedAt), sections: forEditor(after.sections) };
  },
);

/** Publish (08 §1): the draft goes live, a revision is kept and the version goes up. */
export const publishPage = adminAction(
  pageVersionedSchema,
  { write: true },
  async ({ id, expectedUpdatedAt }, ctx) => {
    const db = await getDb();
    const res = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      const firstPublish = !(await hasBeenPublished(tx, id));
      const after = await publishPageRecord(tx, row, { actor: ctx.actor, userId: ctx.user.id });
      await clearRedirectFrom(tx, after.slug);
      return { after, firstPublish };
    });
    revalidatePage(id, { redirects: true });
    return {
      updatedAt: iso(res.after.updatedAt),
      version: res.after.version,
      firstPublish: res.firstPublish,
      sections: forEditor(res.after.sections),
    };
  },
);

/** Take a page off the site (it stays in the list as a draft, its content kept). */
export const unpublishPage = adminAction(
  pageVersionedSchema,
  { write: true },
  async ({ id, expectedUpdatedAt }, ctx) => {
    const db = await getDb();
    const after = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      if (row.isHome)
        throw new ActionError(
          "This is the home page. Set another page as home before unpublishing it.",
          "IN_USE",
        );
      if (row.status === "draft") return row;
      const [updated] = await tx
        .update(pages)
        .set({ status: "draft", publishAt: null, updatedBy: ctx.user.id })
        .where(eq(pages.id, id))
        .returning();
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "page.unpublish",
        entityType: "page",
        entityId: id,
        before: { status: row.status, publishAt: row.publishAt },
        after: { status: "draft" },
      });
      return updated!;
    });
    revalidatePage(id);
    return { updatedAt: iso(after.updatedAt), status: after.status };
  },
);

/**
 * Schedule (08 §1): a draft page goes live at the time; on a published page, the unpublished
 * changes go live then. Null cancels. The cron publishes due pages every minute.
 */
export const schedulePage = adminAction(
  scheduleSchema,
  { write: true },
  async ({ id, expectedUpdatedAt, publishAt }, ctx) => {
    const db = await getDb();
    const after = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, id, expectedUpdatedAt);
      let status = row.status;
      let at: Date | null = null;
      if (publishAt === null) {
        if (row.status === "scheduled") status = "draft";
      } else {
        at = new Date(publishAt);
        const now = Date.now();
        if (at.getTime() < now + 60_000)
          throw new ActionError("Choose a time at least a minute from now.", "VALIDATION", {
            publishAt: ["Choose a time in the future."],
          });
        if (at.getTime() > now + 366 * 86_400_000)
          throw new ActionError("Choose a time within the next year.", "VALIDATION", {
            publishAt: ["Choose a time within the next year."],
          });
        if (row.status === "published" && row.draftSections === null)
          throw new ActionError(
            "There are no unpublished changes to schedule. The page is already live.",
            "NOTHING_TO_SCHEDULE",
          );
        // Problems surface now, not at 3 a.m. when the schedule runs.
        sectionsForPublish(workingSections(row));
        if (row.status === "draft") status = "scheduled";
      }
      const [updated] = await tx
        .update(pages)
        .set({ status, publishAt: at, updatedBy: ctx.user.id })
        .where(eq(pages.id, id))
        .returning();
      await auditChange(tx, {
        actor: ctx.actor,
        action: at ? "page.schedule" : "page.unschedule",
        entityType: "page",
        entityId: id,
        before: { status: row.status, publishAt: row.publishAt },
        after: { status: updated!.status, publishAt: updated!.publishAt },
      });
      return updated!;
    });
    revalidatePage(id);
    return {
      updatedAt: iso(after.updatedAt),
      status: after.status,
      publishAt: after.publishAt ? iso(after.publishAt) : null,
    };
  },
);

/** One revision's sections and SEO, for "compare" in the Revisions panel. */
export const getPageRevision = adminAction(
  z.object({ id: z.uuid() }).strict(),
  {},
  async ({ id }) => {
    const db = await getDb();
    const [rev] = await db
      .select()
      .from(pageRevisions)
      .where(and(eq(pageRevisions.id, id), eq(pageRevisions.agencyId, currentAgencyId())));
    if (!rev) throw new ActionError("This version no longer exists.", "NOT_FOUND");
    return {
      id: rev.id,
      createdAt: iso(rev.createdAt),
      sections: forEditor(rev.sections),
      seo: rev.seo,
    };
  },
);

/** "Restore": a revision's sections become the draft; Publish makes them live again. */
export const restorePageRevision = adminAction(
  restoreRevisionSchema,
  { write: true },
  async ({ pageId, revisionId, expectedUpdatedAt }, ctx) => {
    const db = await getDb();
    const res = await db.transaction(async (tx) => {
      const row = await pageForWrite(tx, pageId, expectedUpdatedAt);
      const [rev] = await tx
        .select()
        .from(pageRevisions)
        .where(and(eq(pageRevisions.id, revisionId), eq(pageRevisions.pageId, pageId)));
      if (!rev) throw new ActionError("This version no longer exists.", "NOT_FOUND");
      const { sections, problems } = checkDraft(rev.sections);
      const [after] = await tx
        .update(pages)
        .set({ draftSections: sections, draftUpdatedAt: new Date(), updatedBy: ctx.user.id })
        .where(eq(pages.id, pageId))
        .returning();
      await writeAudit(tx, {
        actor: ctx.actor,
        action: "page.revision_restore",
        entityType: "page",
        entityId: pageId,
        after: { revisionId, revisionDate: rev.createdAt, sections: sections.length },
      });
      await syncMediaUsage(tx, [...pageMediaIds(row), ...pageMediaIds(after!)]);
      return { after: after!, problems };
    });
    revalidatePage(pageId, { draftOnly: true });
    return {
      updatedAt: iso(res.after.updatedAt),
      sections: forEditor(res.after.draftSections ?? []),
      problems: res.problems,
    };
  },
);

/** A shareable preview link of the draft that works for 7 days (08 §1), no sign-in needed. */
export const createPagePreviewLink = adminAction(
  pageRefSchema,
  { write: true },
  async ({ id }, ctx) => {
    const db = await getDb();
    const row = await pageForWrite(db, id, null);
    const seconds = PREVIEW_LINK_DAYS * 86_400;
    const token = await signToken(PREVIEW_PURPOSE, { p: row.id }, seconds);
    const expiresAt = new Date(Date.now() + seconds * 1000);
    await writeAudit(db, {
      actor: ctx.actor,
      action: "page.preview_link",
      entityType: "page",
      entityId: row.id,
      after: { expiresAt },
    });
    return { url: siteUrl(`/preview/${token}`), expiresAt: iso(expiresAt) };
  },
);

/** Listings for the "pick listings" field: by reference or title, or the ones already chosen. */
export const findListingOptions = adminAction(
  z.object({
    q: z.string().trim().max(100).default(""),
    ids: z.array(z.uuid()).max(12).default([]),
  }),
  {},
  async ({ q, ids }): Promise<ListingOption[]> => {
    const db = await getDb();
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = await db
      .select({
        id: properties.id,
        reference: properties.reference,
        title: properties.title,
        status: properties.status,
        purpose: properties.purpose,
      })
      .from(properties)
      .where(
        and(
          eq(properties.agencyId, currentAgencyId()),
          isNull(properties.deletedAt),
          ids.length
            ? inArray(properties.id, ids)
            : q
              ? or(ilike(properties.reference, like), ilike(properties.title, like))
              : sql`true`,
        ),
      )
      .orderBy(desc(properties.updatedAt))
      .limit(ids.length ? 12 : 20);
    return rows.map((r) => ({
      id: r.id,
      label: `${r.reference} · ${r.title}`,
      detail: `${r.purpose === "rent" ? "Rent" : "Sale"} · ${r.status.replace(/_/g, " ")}`,
    }));
  },
);
