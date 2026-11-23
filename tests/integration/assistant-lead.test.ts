import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { contacts, leads } from "@/db/schema/crm";
import { saveContactTool } from "@/features/ai/assistant/customer-tools";
import { importWorld } from "../helpers/listings";
import { truncate } from "../helpers/db";

describe("the assistant turns what it learned into a lead (save_contact)", () => {
  beforeEach(async () => {
    await truncate("leads", "contacts", "property_types", "locations", "agents", "facilities");
  });

  it("stores buy or rent, the kind of home, area, budget and bedrooms on the lead", async () => {
    const { ids } = await importWorld();
    const db = await getDb();
    const ctx = {
      db,
      actor: { type: "visitor" as const, visitorId: null },
      feature: "customer_chat" as const,
    };

    expect(
      await saveContactTool.run(
        { name: "Omar", email: "", phone: "", requirements: {} } as never,
        ctx as never,
      ),
    ).toMatchObject({ saved: false });

    const out = await saveContactTool.run(
      {
        name: "Omar Haddad",
        email: "omar@example.com",
        phone: "",
        requirements: {
          purpose: "rent",
          propertyTypes: ["apartments"],
          areas: ["Dubai Marina"],
          budgetMax: 120_000,
          bedsMin: 2,
          timeline: "1_3_months",
        },
      } as never,
      ctx as never,
    );
    expect(out).toMatchObject({ saved: true });

    const [contact] = await db
      .select()
      .from(contacts)
      .where(eq(contacts.email, "omar@example.com"));
    const [lead] = await db.select().from(leads).where(eq(leads.contactId, contact!.id));
    expect(lead!.requirements).toMatchObject({
      purpose: "rent",
      propertyTypeIds: [ids.apt],
      locationIds: [ids.marina],
      budgetMax: 12_000_000, // minor units (AED fils)
      bedsMin: 2,
      timeline: "1_3_months",
    });
  });
});
