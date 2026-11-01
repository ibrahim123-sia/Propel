import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { posts } from "@/db/schema/content";
import { properties } from "@/db/schema/properties";
import { auditLog } from "@/db/schema/system";
import {
  aiDraftBlogPost,
  aiEditDescription,
  aiListingFromText,
  aiSuggestSeo,
  aiSuggestTitles,
  aiWriteDescription,
} from "@/features/ai/helper-actions";
import {
  listingFacts,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  suggestAltText,
} from "@/features/ai/helpers";
import { mockCalls, resetMock, scriptMockReplies } from "@/features/ai/providers/mock";
import { patchSettings } from "@/features/settings/mutations";
import { defaultsFor } from "@/features/settings/schema";
import { evalWorldTables, seedEvalWorld, type EvalWorld } from "../ai/fixtures";
import { adminState, testAdmin } from "../helpers/admin-context";
import { ensureTestAdminUser, truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
let world: EvalWorld;

async function enableAi(enabled = true) {
  await patchSettings(
    await getDb(),
    "integrations",
    { ai: { ...defaultsFor("integrations").ai, enabled, provider: "mock" } },
    actor,
  );
}

describe("AI helpers in the editors (10 §5)", () => {
  beforeEach(async () => {
    resetMock();
    adminState.user = testAdmin;
    await truncate(...evalWorldTables, "posts", "audit_log", "ai_usage");
    await ensureTestAdminUser();
    world = await seedEvalWorld(await getDb());
    await enableAi();
  });

  it("describes a listing from its own facts only, and suggests titles", async () => {
    const db = await getDb();
    const facts = await listingFacts(db, world.listings.marinaSeaView.id);
    expect(facts?.facts).toMatchObject({
      type: "Apartment",
      bedrooms: 2,
      size: "120 m²",
      view: ["sea"],
      facilities: expect.arrayContaining(["Swimming pool", "Gym"]),
    });

    const res = await aiWriteDescription({ propertyId: world.listings.marinaSeaView.id });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.text).toContain("2-bedroom apartment in Dubai Marina");
    // The model saw the facts as data, with the prompt's rules.
    const call = mockCalls().at(-1)!;
    expect(call.system).toContain("Use only the facts given");
    expect(JSON.stringify(call.messages)).toContain("<facts>");

    const titles = await aiSuggestTitles({ propertyId: world.listings.marinaSeaView.id });
    expect(titles.ok && titles.data.titles.length).toBeGreaterThan(0);
    if (titles.ok) for (const t of titles.data.titles) expect(t.length).toBeLessThanOrEqual(80);
  });

  it("improves and shortens the text in the editor, with the facts beside it", async () => {
    const propertyId = world.listings.marinaSeaView.id;
    const current =
      "This bright apartment  looks over the sea. It has two bedrooms and a big terrace. The building has a pool and a gym. Parking is included. [add detail: the floor]";
    const improved = await aiEditDescription({ propertyId, current, edit: "improve" });
    expect(improved).toMatchObject({ ok: true });
    if (improved.ok) expect(improved.data.text).toContain("looks over the sea");
    const call = mockCalls().at(-1)!;
    expect(call.system).toContain('Keep every "[add detail]" mark');
    expect(JSON.stringify(call.messages)).toContain("<current>");
    expect(JSON.stringify(call.messages)).toContain("<facts>");

    const shorter = await aiEditDescription({ propertyId, current, edit: "shorten" });
    expect(shorter.ok && shorter.data.text.length).toBeLessThan(current.length);
    expect(mockCalls().at(-1)!.system).toMatch(
      /Shorten the current description to about \d+ words/,
    );

    // Nothing to work on yet.
    expect(
      await aiEditDescription({ propertyId, current: "Nice.", edit: "improve" }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("keeps SEO suggestions within the limits and drops the rest", async () => {
    scriptMockReplies({
      text: JSON.stringify({
        options: [
          {
            title: "Sea view apartment in Dubai Marina",
            description:
              "A two-bed apartment with a full sea view, a balcony and a pool in the building.",
          },
          { title: "x".repeat(SEO_TITLE_MAX + 1), description: "d".repeat(80) },
          { title: "Fine title here", description: "d".repeat(SEO_DESCRIPTION_MAX + 1) },
        ],
      }),
    });
    const res = await aiSuggestSeo({
      kind: "listing",
      title: "Sea view",
      text: "Two beds, sea view",
    });
    expect(res.ok && res.data.options).toEqual([
      expect.objectContaining({ title: "Sea view apartment in Dubai Marina" }),
    ]);
  });

  it("alt text: photos only, with the image sent by address", async () => {
    const db = await getDb();
    expect(await suggestAltText(db, { mediaId: "01a17b00-0000-7000-8000-000000000000" })).toEqual({
      ok: false,
      message: "Alt text suggestions work for photos only.",
    });
  });

  it("drafts a blog post and a listing as drafts, audited", async () => {
    const db = await getDb();
    const blog = await aiDraftBlogPost({
      brief: "Moving to Dubai Hills with children. Schools and parks.",
    });
    expect(blog.ok).toBe(true);
    const [post] = await db.select().from(posts);
    expect(post).toMatchObject({ status: "draft", isAiDrafted: true });
    expect(post!.bodyHtml).toContain("<h2>What to know</h2>");

    const listing = await aiListingFromText({
      text: "Bright 3 bedroom villa for sale in Dubai Hills, 4 baths, 3,200 sq ft, asking AED 4,500,000. Private garden.",
    });
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const [row] = await db.select().from(properties).where(eq(properties.id, listing.data.id));
    expect(row).toMatchObject({
      status: "draft",
      purpose: "sale",
      beds: 3,
      baths: 4,
      price: 450_000_000,
      locationId: world.locations.hills,
    });
    expect(listing.data.missing.length).toBeGreaterThan(0);
    const audits = await db.select({ action: auditLog.action }).from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["post.create", "property.create"]),
    );
  });

  it("says so when AI is off, and nothing is created", async () => {
    await enableAi(false);
    const res = await aiWriteDescription({ propertyId: world.listings.hillsVilla.id });
    expect(res).toMatchObject({ ok: false, error: "AI features are turned off." });
    expect((await aiDraftBlogPost({ brief: "A post about schools in the area" })).ok).toBe(false);
    expect(await (await getDb()).select().from(posts)).toHaveLength(0);
  });
});
