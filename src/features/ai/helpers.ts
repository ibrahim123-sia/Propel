import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { facilities, locations, propertyTypes } from "@/db/schema/master-data";
import { media } from "@/db/schema/media";
import { projects } from "@/db/schema/projects";
import { properties, propertyFacilities } from "@/db/schema/properties";
import { loadSettings } from "@/features/settings/queries";
import { siteUrl } from "@/features/site/url";
import { areaFromSqm, areaUnitLabels } from "@/lib/units";
import { registerHelperMockRules } from "./helpers-mock";
import { prompt } from "./prompts";
import { parseJsonReply, runAgent, type RunAgentResult } from "./runner";
import type { AiProvider } from "./types";

/**
 * AI helpers in the admin editors (10 §5): descriptions, titles, SEO texts, alt text, blog
 * drafts and listing drafts from pasted text. Each returns suggestions only; the admin keeps,
 * edits or drops them in the editor, so nothing reaches the site without a person. When AI is
 * off or over budget the helper says so and the editor works as before.
 */

export type HelperResult<T> = { ok: true; value: T } | { ok: false; message: string };

const toneText = {
  friendly: "warm and inviting",
  formal: "polite and professional",
  short: "concise",
};

async function run(
  feature: Parameters<typeof runAgent>[0]["feature"],
  system: string,
  user: string | Array<{ type: "text"; text: string } | { type: "image"; url: string }>,
  options: { db?: DbOrTx; provider?: AiProvider; maxTokens?: number } = {},
): Promise<RunAgentResult> {
  registerHelperMockRules();
  return runAgent({
    feature,
    tier: "fast",
    system,
    messages: [
      { role: "user", content: typeof user === "string" ? [{ type: "text", text: user }] : user },
    ],
    context: { actor: { type: "visitor", visitorId: null } },
    maxSteps: 1,
    maxTokens: options.maxTokens ?? 1500,
    effort: "low",
    db: options.db,
    provider: options.provider,
  });
}

function failed(run: RunAgentResult): { ok: false; message: string } {
  if (run.status === "unavailable")
    return { ok: false, message: run.unavailable?.message ?? "AI is not available." };
  return { ok: false, message: "The AI did not give a usable answer. Please try again." };
}

/** Data for the model: escaped so nothing inside can close the tag around it. */
const data = (tag: string, value: unknown) =>
  `<${tag}>\n${JSON.stringify(value, null, 1).replace(/</g, "\\u003c")}\n</${tag}>`;

/* Listing facts ------------------------------------------------------------------------- */

/** What the listing's editor holds (saved), as facts in the market's units. */
export async function listingFacts(db: DbOrTx, id: string) {
  const [row] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, id), eq(properties.agencyId, currentAgencyId())));
  if (!row) return null;
  const market = await loadSettings("market", db);
  const unit = areaUnitLabels[market.areaUnit];
  const size = (sqm: number | null) =>
    sqm ? `${Math.round(areaFromSqm(sqm, market.areaUnit))} ${unit}` : undefined;
  const [type] = row.propertyTypeId
    ? await db
        .select({ name: propertyTypes.name })
        .from(propertyTypes)
        .where(eq(propertyTypes.id, row.propertyTypeId))
    : [];
  const places = row.locationId
    ? (
        await db.execute<{ name: string; level: string }>(sql`
          with recursive up as (
            select id, parent_id, name, level, 0 as depth from locations where id = ${row.locationId}::uuid
            union all
            select l.id, l.parent_id, l.name, l.level, up.depth + 1 from locations l join up on l.id = up.parent_id
          ) select name, level from up where level <> 'country' order by depth`)
      ).rows.map((r) => r.name)
    : [];
  const facilityNames = (
    await db
      .select({ name: facilities.name })
      .from(propertyFacilities)
      .innerJoin(facilities, eq(facilities.id, propertyFacilities.facilityId))
      .where(eq(propertyFacilities.propertyId, id))
  ).map((f) => f.name);
  const [project] = row.projectId
    ? await db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId))
    : [];
  const facts = Object.fromEntries(
    Object.entries({
      title: row.title || undefined,
      purpose: row.purpose === "sale" ? "for sale" : "for rent",
      type: type?.name,
      completion: row.completion === "off_plan" ? "off-plan" : "ready",
      handover: row.handoverText ?? undefined,
      project: project?.name,
      location: places.length ? places.join(", ") : undefined,
      building: row.buildingName ?? undefined,
      bedrooms: row.beds === 0 ? "studio" : (row.beds ?? undefined),
      bathrooms: row.baths ?? undefined,
      size: size(row.size),
      plotSize: size(row.plotSize),
      floor: row.floor ?? undefined,
      view: row.view.length ? row.view : undefined,
      furnishing: row.furnishing ?? undefined,
      parkingSpaces: row.parkingSpaces ?? undefined,
      maidRoom: row.maidRoom || undefined,
      study: row.study || undefined,
      yearBuilt: row.yearBuilt ?? undefined,
      tenanted: row.isTenanted || undefined,
      facilities: facilityNames.length ? facilityNames : undefined,
      highlights: row.highlights.length ? row.highlights : undefined,
    }).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );
  return { row, facts, areaUnit: unit };
}

/* Description ---------------------------------------------------------------------------- */

export async function writeDescription(
  db: DbOrTx,
  propertyId: string,
  options: { provider?: AiProvider; words?: number } = {},
): Promise<HelperResult<string>> {
  const loaded = await listingFacts(db, propertyId);
  if (!loaded) return { ok: false, message: "This listing no longer exists." };
  const [general, ai] = [await loadSettings("general", db), await loadSettings("ai", db)];
  const res = await run(
    "description",
    prompt("description-writer", {
      agencyName: general.agencyName,
      tone: toneText[ai.tone],
      areaUnit: loaded.areaUnit,
      wordTarget: options.words ?? 150,
    }),
    data("facts", loaded.facts),
    { db, provider: options.provider },
  );
  const text = res.text.replace(/\r/g, "").trim();
  return res.status === "done" && text.length > 40 ? { ok: true, value: text } : failed(res);
}

/** 07 §3.7: the editor's "Improve" and "Shorten" on the text the admin has now. */
export type DescriptionEdit = "improve" | "shorten";

const editTask: Record<DescriptionEdit, (words: number) => string> = {
  improve: () =>
    "Improve the current description: clearer sentences, a better order (what stands out first, then the layout, then the building or area), no repetition, correct grammar. Keep about the same length.",
  shorten: (words) =>
    `Shorten the current description to about ${words} words, keeping what matters most to a buyer or tenant.`,
};

export async function editDescription(
  db: DbOrTx,
  propertyId: string,
  current: string,
  edit: DescriptionEdit,
  options: { provider?: AiProvider } = {},
): Promise<HelperResult<string>> {
  const text = current.trim();
  if (text.length < 40) return { ok: false, message: "Write a few sentences first." };
  const loaded = await listingFacts(db, propertyId);
  if (!loaded) return { ok: false, message: "This listing no longer exists." };
  const [general, ai] = [await loadSettings("general", db), await loadSettings("ai", db)];
  const words = text.split(/\s+/).length;
  const res = await run(
    "description",
    prompt("description-editor", {
      agencyName: general.agencyName,
      tone: toneText[ai.tone],
      areaUnit: loaded.areaUnit,
      task: editTask[edit](Math.max(40, Math.round(words * 0.6))),
    }),
    `${data("facts", loaded.facts)}\n\n${data("current", text)}`,
    { db, provider: options.provider },
  );
  const out = res.text.replace(/\r/g, "").trim();
  return res.status === "done" && out.length > 20 ? { ok: true, value: out } : failed(res);
}

/* Titles --------------------------------------------------------------------------------- */

export const TITLE_MAX = 80;

export async function suggestTitles(
  db: DbOrTx,
  propertyId: string,
  options: { provider?: AiProvider } = {},
): Promise<HelperResult<string[]>> {
  const loaded = await listingFacts(db, propertyId);
  if (!loaded) return { ok: false, message: "This listing no longer exists." };
  // Ideas from the facts, not a rewording of the current title.
  const facts = Object.fromEntries(Object.entries(loaded.facts).filter(([k]) => k !== "title"));
  const res = await run(
    "description",
    prompt("titles", { maxLength: TITLE_MAX }),
    data("facts", facts),
    {
      db,
      provider: options.provider,
      maxTokens: 400,
    },
  );
  const parsed = z
    .object({ titles: z.array(z.string()).min(1) })
    .safeParse(parseJsonReply(res.text));
  if (res.status !== "done" || !parsed.success) return failed(res);
  const titles = parsed.data.titles
    .map((t) => t.trim())
    .filter((t) => t.length >= 5 && t.length <= TITLE_MAX)
    .slice(0, 3);
  return titles.length ? { ok: true, value: titles } : failed(res);
}

/* SEO ------------------------------------------------------------------------------------ */

export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 155;

export type SeoOption = { title: string; description: string };

/** For any SEO panel: the page's own title and text (as the editor holds it). */
export async function suggestSeo(
  db: DbOrTx,
  page: { kind: string; title: string; text: string },
  options: { provider?: AiProvider } = {},
): Promise<HelperResult<SeoOption[]>> {
  const general = await loadSettings("general", db);
  const res = await run(
    "seo",
    prompt("seo", {
      agencyName: general.agencyName,
      titleMax: SEO_TITLE_MAX,
      descriptionMax: SEO_DESCRIPTION_MAX,
    }),
    data("page", { kind: page.kind, title: page.title, content: page.text.slice(0, 6000) }),
    { db, provider: options.provider, maxTokens: 800 },
  );
  const parsed = z
    .object({ options: z.array(z.object({ title: z.string(), description: z.string() })) })
    .safeParse(parseJsonReply(res.text));
  if (res.status !== "done" || !parsed.success) return failed(res);
  const list = parsed.data.options
    .map((o) => ({ title: o.title.trim(), description: o.description.trim() }))
    .filter(
      (o) =>
        o.title.length >= 10 &&
        o.title.length <= SEO_TITLE_MAX &&
        o.description.length >= 50 &&
        o.description.length <= SEO_DESCRIPTION_MAX,
    )
    .slice(0, 3);
  return list.length ? { ok: true, value: list } : failed(res);
}

/* Alt text ------------------------------------------------------------------------------- */

export const ALT_MAX = 125;

/** From the image (its public address) and, when given, the listing it belongs to. */
export async function suggestAltText(
  db: DbOrTx,
  input: { mediaId: string; propertyId?: string | null },
  options: { provider?: AiProvider } = {},
): Promise<HelperResult<string>> {
  const [file] = await db
    .select({ key: media.r2Key, mime: media.mime, caption: media.caption, name: media.fileName })
    .from(media)
    .where(and(eq(media.id, input.mediaId), eq(media.agencyId, currentAgencyId())));
  if (!file || !file.mime.startsWith("image/") || file.mime === "image/svg+xml")
    return { ok: false, message: "Alt text suggestions work for photos only." };
  const listing = input.propertyId ? await listingFacts(db, input.propertyId) : null;
  const context = {
    ...(listing
      ? {
          listing: listing.facts.title,
          type: listing.facts.type,
          location: listing.facts.location,
        }
      : {}),
    caption: file.caption ?? undefined,
    fileName: file.name ?? undefined,
  };
  const res = await run(
    "alt_text",
    prompt("alt-text", { maxLength: ALT_MAX }),
    [
      { type: "image", url: siteUrl(`/media/${file.key}?w=1024`) },
      { type: "text", text: data("context", context) },
    ],
    { db, provider: options.provider, maxTokens: 200 },
  );
  const text = res.text.replace(/^["']|["']$/g, "").trim();
  return res.status === "done" && text.length >= 5 && text.length <= ALT_MAX
    ? { ok: true, value: text }
    : failed(res);
}

/* Blog draft ----------------------------------------------------------------------------- */

const blogSchema = z.object({
  title: z.string().min(5).max(140),
  excerpt: z.string().max(400).default(""),
  sections: z
    .array(z.object({ heading: z.string().max(140), paragraphs: z.array(z.string()).min(1) }))
    .min(1),
});
export type BlogDraft = z.infer<typeof blogSchema>;

export async function draftBlog(
  db: DbOrTx,
  brief: string,
  options: { provider?: AiProvider; words?: number } = {},
): Promise<HelperResult<BlogDraft>> {
  const [general, ai] = [await loadSettings("general", db), await loadSettings("ai", db)];
  const res = await run(
    "blog",
    prompt("blog-draft", {
      agencyName: general.agencyName,
      tone: toneText[ai.tone],
      wordTarget: options.words ?? 700,
    }),
    data("brief", brief),
    { db, provider: options.provider, maxTokens: 4000 },
  );
  const parsed = blogSchema.safeParse(parseJsonReply(res.text));
  return res.status === "done" && parsed.success ? { ok: true, value: parsed.data } : failed(res);
}

/* Listing from pasted text --------------------------------------------------------------- */

const listingSchema = z.object({
  title: z.string().min(5).max(120),
  purpose: z.enum(["sale", "rent"]).catch("sale"),
  propertyType: z.string().max(40).optional().catch(undefined),
  location: z.string().max(80).optional().catch(undefined),
  price: z.number().positive().optional().catch(undefined),
  beds: z.number().int().min(0).max(20).optional().catch(undefined),
  baths: z.number().int().min(0).max(20).optional().catch(undefined),
  size: z.number().positive().optional().catch(undefined),
  furnishing: z.string().max(40).optional().catch(undefined),
  highlights: z.array(z.string().max(120)).max(8).optional().catch(undefined),
  description: z.string().max(6000).optional().catch(undefined),
  unknown: z.array(z.string().max(120)).max(12).optional().catch(undefined),
});
export type ListingFromText = z.infer<typeof listingSchema>;

export async function listingFromText(
  db: DbOrTx,
  text: string,
  options: { provider?: AiProvider } = {},
): Promise<HelperResult<ListingFromText>> {
  const market = await loadSettings("market", db);
  const types = await db
    .select({ name: propertyTypes.name })
    .from(propertyTypes)
    .where(eq(propertyTypes.agencyId, currentAgencyId()));
  const res = await run(
    "listing_from_text",
    prompt("listing-from-text", {
      currency: market.baseCurrency.code,
      areaUnit: areaUnitLabels[market.areaUnit],
      propertyTypes: types.map((t) => t.name),
      purposes: ["sale", "rent"],
    }),
    `<text>\n${text.slice(0, 8000).replace(/</g, "‹")}\n</text>`,
    { db, provider: options.provider, maxTokens: 2500 },
  );
  const parsed = listingSchema.safeParse(parseJsonReply(res.text));
  return res.status === "done" && parsed.success ? { ok: true, value: parsed.data } : failed(res);
}

/** Location names of the agency, to check a parsed location (tests and the draft). */
export async function locationIdByName(db: DbOrTx, name: string): Promise<string | null> {
  const [row] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.agencyId, currentAgencyId()),
        inArray(sql`lower(${locations.name})`, [name.trim().toLowerCase()]),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
