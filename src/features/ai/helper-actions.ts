"use server";

import { z } from "zod";
import { getDb } from "@/db/client";
import { ActionError, adminAction } from "@/lib/actions";
import { insertListingDraft, insertPostDraft } from "./assistant/admin-write-tools";
import {
  draftBlog,
  listingFromText,
  suggestAltText,
  suggestSeo,
  suggestTitles,
  editDescription,
  writeDescription,
  type HelperResult,
} from "./helpers";

/**
 * The editors' AI buttons (10 §5). Suggestions come back to the editor, which the admin keeps
 * or drops; the two that create something (a blog draft, a listing draft) create drafts only.
 */

function value<T>(res: HelperResult<T>): T {
  if (!res.ok) throw new ActionError(res.message, "AI_UNAVAILABLE");
  return res.value;
}

export const aiWriteDescription = adminAction(
  z.object({ propertyId: z.uuid() }),
  {},
  async ({ propertyId }) => ({ text: value(await writeDescription(await getDb(), propertyId)) }),
);

/** 07 §3.7: "Improve" and "Shorten" work on the text in the editor (saved or not). */
export const aiEditDescription = adminAction(
  z.object({
    propertyId: z.uuid(),
    current: z.string().max(20_000),
    edit: z.enum(["improve", "shorten"]),
  }),
  {},
  async ({ propertyId, current, edit }) => ({
    text: value(await editDescription(await getDb(), propertyId, current, edit)),
  }),
);

export const aiSuggestTitles = adminAction(
  z.object({ propertyId: z.uuid() }),
  {},
  async ({ propertyId }) => ({ titles: value(await suggestTitles(await getDb(), propertyId)) }),
);

export const aiSuggestSeo = adminAction(
  z.object({
    kind: z.string().trim().min(2).max(30),
    title: z.string().trim().max(200),
    text: z.string().max(20_000),
  }),
  {},
  async (page) => ({ options: value(await suggestSeo(await getDb(), page)) }),
);

export const aiSuggestAltText = adminAction(
  z.object({ mediaId: z.uuid(), propertyId: z.uuid().nullable().default(null) }),
  {},
  async (input) => ({ alt: value(await suggestAltText(await getDb(), input)) }),
);

/** A blog draft from a brief: saved as a draft post marked AI-drafted; the editor opens it. */
export const aiDraftBlogPost = adminAction(
  z.object({
    brief: z.string().trim().min(10, "Describe the post in a sentence or two").max(4000),
  }),
  { write: true },
  async ({ brief }, ctx) => {
    const db = await getDb();
    const draft = value(await draftBlog(db, brief));
    const body = draft.sections
      .map((s) => [`## ${s.heading}`, ...s.paragraphs].join("\n\n"))
      .join("\n\n");
    const id = await db.transaction((tx) =>
      insertPostDraft(
        tx,
        { title: draft.title, excerpt: draft.excerpt, body },
        {
          actor: ctx.actor,
          userId: ctx.user.id,
        },
      ),
    );
    return { id };
  },
);

/** A listing draft from pasted text (a portal ad, an owner's message); the editor opens it. */
export const aiListingFromText = adminAction(
  z.object({ text: z.string().trim().min(20, "Paste the listing text").max(8000) }),
  { write: true },
  async ({ text }, ctx) => {
    const db = await getDb();
    const parsed = value(await listingFromText(db, text));
    if (!parsed.propertyType)
      throw new ActionError(
        "The text does not say what kind of property it is. Add it and try again.",
        "VALIDATION",
      );
    const row = await db.transaction((tx) =>
      insertListingDraft(
        tx,
        {
          title: parsed.title,
          purpose: parsed.purpose,
          type: parsed.propertyType!,
          area: parsed.location,
          beds: parsed.beds,
          baths: parsed.baths,
          size: parsed.size,
          price: parsed.price,
          description: parsed.description,
          highlights: parsed.highlights,
        },
        { actor: ctx.actor, userId: ctx.user.id },
      ),
    );
    return { id: row.id, reference: row.reference, missing: parsed.unknown ?? [] };
  },
);
