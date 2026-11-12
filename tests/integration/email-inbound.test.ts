import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { contacts, conversations, leadEvents, leads, messages } from "@/db/schema/crm";
import { properties } from "@/db/schema/properties";
import { captureLead } from "@/features/leads/capture";
import { importPortalCsv, previewPortalCsv } from "@/features/portals/actions";
import { patchSettings } from "@/features/settings/mutations";
import { setSecret } from "@/features/settings/secrets";
import { bytesToBase64 } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { adminState, testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const keyBytes = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${bytesToBase64(keyBytes)}`;

async function signed(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body);
  const id = `msg_${newId()}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
  const sig = secret === SECRET ? bytesToBase64(new Uint8Array(mac)) : "bad";
  const { POST } = await import("@/app/api/webhooks/resend/route");
  return POST(
    new Request("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
      body: raw,
    }),
  );
}

const received = (data: Record<string, unknown>) => ({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: { email_id: newId(), ...data },
});

describe("inbound email and portals (13 §1)", () => {
  beforeEach(async () => {
    adminState.user = testAdmin;
    await truncate(
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "conversations",
      "messages",
      "properties",
      "settings",
      "secrets",
      "job_runs",
      "email_log",
      "message_templates",
      "audit_log",
    );
    const db = await getDb();
    await setSecret(db, "resend_webhook_secret", SECRET, actor);
    await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
    await patchSettings(
      db,
      "integrations",
      {
        resend: {
          inboundDomain: "in.havendune.example",
        },
      },
      actor,
    );
    await patchSettings(
      db,
      "leads",
      { portalInboxes: [{ portal: "Property Finder", address: "pf-leads@in.havendune.example" }] },
      actor,
    );
  });

  it("refuses calls without a valid signature", async () => {
    expect(
      (await signed(received({ from: "a@b.example", to: ["x@in.havendune.example"] }), "bad"))
        .status,
    ).toBe(401);
  });

  it("a reply to lead+<id> lands in the lead's email conversation and timeline, once", async () => {
    const db = await getDb();
    const lead = await captureLead(db, {
      source: "form",
      contact: { name: "Sam", email: "sam@example.com" },
    });
    const body = received({
      from: "Sam Visitor <sam@example.com>",
      to: [`lead+${lead.leadId}@in.havendune.example`],
      subject: "Re: Thanks, Sam",
      text: "Saturday at 10 works for me.\n\nOn Mon, Layla wrote:\n> When would suit you?",
      message_id: "<abc@mail.example>",
    });
    const res = await signed(body);
    expect(await res.json()).toMatchObject({ result: "lead_reply" });
    await signed(body);
    const [conv] = await db.select().from(conversations);
    expect(conv).toMatchObject({ channel: "email", leadId: lead.leadId, unreadCount: 1 });
    const all = await db.select().from(messages);
    expect(all.map((m) => m.body)).toEqual(["Saturday at 10 works for me."]);
    const events = await db.select().from(leadEvents).where(eq(leadEvents.type, "email_received"));
    expect(events.map((e) => e.body)).toEqual(["Saturday at 10 works for me."]);
  });

  it("portal emails become portal leads with the listing; other mail opens a conversation", async () => {
    const db = await getDb();
    const listing = newId();
    await db.insert(properties).values({
      id: listing,
      reference: "HD-2041",
      title: "Two bed",
      slug: "two-bed",
      purpose: "sale",
      status: "available",
      publishedAt: new Date(),
    });
    const res = await signed(
      received({
        from: "Property Finder <leads@propertyfinder.example>",
        to: ["pf-leads@in.havendune.example"],
        subject: "New lead for HD-2041",
        html: "<p>Name: Rania Saleh<br>Email: rania@example.com<br>Phone: 050 777 8888<br>Reference: hd-2041<br>Message: Is it vacant?</p>",
      }),
    );
    expect(await res.json()).toMatchObject({ result: "portal" });
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({
      source: "portal",
      sourceDetail: "Property Finder",
      propertyIds: [listing],
    });
    expect(lead!.firstTouch).toMatchObject({ channel: "portal", utm_source: "Property Finder" });
    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({
      name: "Rania Saleh",
      email: "rania@example.com",
      phone: "+971507778888",
    });

    // Someone writing to the agency directly: an email conversation, no lead invented.
    const other = await signed(
      received({
        from: "Omar <omar@example.com>",
        to: ["hello@in.havendune.example"],
        subject: "Question",
        text: "Do you manage rentals?",
      }),
    );
    expect(await other.json()).toMatchObject({ result: "conversation" });
    const convs = await db.select().from(conversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel: "email", subject: "Question", leadId: null });
    expect(await db.select().from(leads)).toHaveLength(1);
  });

  it("portal CSV: preview with guessed columns, then import with dedupe", async () => {
    const db = await getDb();
    const csv =
      "Lead Name,Email,Mobile,Listing Ref,Comments\nSam,sam@example.com,0501234567,HD-1,Hi\nSam again,sam@example.com,,HD-1,Second\nNo contact,,,,\n";
    const preview = await previewPortalCsv({ csv });
    expect(preview).toMatchObject({
      ok: true,
      data: { total: 3, mapping: { name: 0, email: 1, phone: 2, reference: 3, message: 4 } },
    });
    const res = await importPortalCsv({
      portal: "Bayut",
      csv,
      mapping: { name: 0, email: 1, phone: 2, reference: 3, message: 4 },
    });
    expect(res).toEqual({ ok: true, data: { created: 1, joined: 1, skipped: 1 } });
    const [lead] = await db.select().from(leads);
    expect(lead).toMatchObject({ source: "portal", sourceDetail: "Bayut" });
    expect(
      await importPortalCsv({
        portal: "Bayut",
        csv,
        mapping: { name: 0, email: null, phone: null, reference: null, message: null },
      }),
    ).toMatchObject({ ok: false, code: "VALIDATION" });
  });
});
