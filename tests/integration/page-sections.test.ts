import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pages } from "@/db/schema/cms";
import { faqs, testimonials } from "@/db/schema/content";
import {
  leadEvents,
  leads,
  leadTasks,
  newsletterSubscribers,
  valuationRequests,
} from "@/db/schema/crm";
import { emailLog } from "@/db/schema/system";
import { runDueJobs } from "@/jobs/runner";
import { faqItems, filtersFromSearchLink, testimonialCards } from "@/features/cms/section-data";
import { sendPageForm } from "@/features/forms/actions";
import { patchSettings } from "@/features/settings/mutations";
import { newId } from "@/lib/ids";
import { setTurnstileVerifier } from "@/lib/turnstile";
import { testAdmin } from "../helpers/admin-context";
import { truncate } from "../helpers/db";

vi.mock("@/lib/auth/guards", () => import("../helpers/admin-guards-mock"));

const actor = { type: "admin" as const, id: testAdmin.id };
const answer = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text }] }],
});

describe("page builder sections: forms and content", () => {
  beforeEach(async () => {
    setTurnstileVerifier(async (token) => token === "good-token");
    await truncate(
      "pages",
      "testimonials",
      "faqs",
      "contacts",
      "leads",
      "lead_events",
      "lead_tasks",
      "valuation_requests",
      "listing_requests",
      "newsletter_subscribers",
      "message_templates",
      "email_log",
      "job_runs",
      "rate_limits",
      "settings",
    );
    const db = await getDb();
    await patchSettings(db, "market", { phoneCountryCode: "+971" }, actor);
    await patchSettings(
      db,
      "contact",
      { email: "hello@agency.example", leadNotifyEmails: [] },
      actor,
    );
  });
  afterEach(() => setTurnstileVerifier(null));

  const contact = {
    formType: "contact" as const,
    name: "Sam Visitor",
    email: "sam@example.com",
    message: "Do you manage rentals?",
    consent: true as const,
    captchaToken: "good-token",
  };

  it("every page form is a lead with its source, the owner's request and a task", async () => {
    const db = await getDb();
    const pageId = newId();
    await db.insert(pages).values({ id: pageId, title: "Sell with us", slug: "sell-with-us" });
    expect(await sendPageForm({ ...contact, pageId })).toEqual({ ok: true, data: { sent: true } });
    const owner = {
      name: "Rana Owner",
      phone: "050 123 4567",
      area: "Marina, Tower 3",
      beds: "2",
      consent: true as const,
      captchaToken: "good-token",
    };
    expect(await sendPageForm({ ...owner, formType: "valuation" })).toMatchObject({ ok: true });
    expect(
      await sendPageForm({
        formType: "valuation",
        name: "Omar Seller",
        email: "omar@example.com",
        area: "JVC",
        propertyType: "Villa",
        consent: true,
        captchaToken: "good-token",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await sendPageForm({
        formType: "callback",
        name: "Callie",
        phone: "050 999 8888",
        preferredTime: "after 6pm",
        consent: true,
        captchaToken: "good-token",
      }),
    ).toMatchObject({ ok: true });

    const all = await db.select().from(leads);
    expect(all.map((l) => [l.source, l.type, l.sourceDetail]).sort()).toEqual([
      ["callback", "buyer", "page form"],
      ["form", "buyer", "contact"],
      ["valuation", "seller", "page form"],
      ["valuation", "seller", "page form"],
    ]);
    const [created] = await db
      .select({ body: leadEvents.body, meta: leadEvents.meta })
      .from(leadEvents)
      .where(eq(leadEvents.type, "created"))
      .orderBy(leadEvents.createdAt)
      .limit(1);
    expect(created).toMatchObject({
      body: "Do you manage rentals?",
      meta: { details: { page: "Sell with us" } },
    });
    const valuations = await db.select().from(valuationRequests);
    expect(valuations.map((v) => [v.building, v.beds]).sort()).toEqual([
      ["JVC", null],
      ["Marina, Tower 3", 2],
    ]);
    expect(
      (await db.select({ title: leadTasks.title }).from(leadTasks)).map((x) => x.title).sort(),
    ).toEqual([
      "Call back (best time: after 6pm)",
      "Value the home in JVC",
      "Value the home in Marina, Tower 3",
    ]);

    // The agency hears through the lead pipeline, with what was asked and where from.
    for (let i = 0; i < 5; i++) if ((await runDueJobs()).ran === 0) break;
    const mails = await db.select().from(emailLog);
    expect(mails.filter((m) => m.template.startsWith("page-form"))).toEqual([]);
    const toAgency = mails.filter((m) => m.to === "hello@agency.example");
    // Owner requests get their own notice (features/valuation/notify.ts) instead of "lead.new".
    expect(toAgency.map((m) => m.template).sort()).toEqual([
      "lead.new",
      "lead.new",
      "valuation.new",
      "valuation.new",
    ]);
    expect(mails.filter((m) => m.to === "omar@example.com").map((m) => m.template)).toEqual([
      "valuation.received",
    ]);
    const message = toAgency.find((m) => (m.text ?? "").includes("Do you manage rentals?"))!;
    expect(message.text).toContain("Sent from: Sell with us");
  });

  it("the newsletter form signs the address up for confirmation", async () => {
    const db = await getDb();
    expect(
      await sendPageForm({
        formType: "newsletter",
        email: "News@Example.com",
        consent: true,
        captchaToken: "good-token",
      }),
    ).toEqual({ ok: true, data: { sent: true } });
    const [sub] = await db.select().from(newsletterSubscribers);
    expect(sub).toMatchObject({ email: "news@example.com", source: "page", confirmedAt: null });
    expect(await db.select().from(leads)).toEqual([]);
  });

  it("checks each form's fields, the honeypot, Turnstile and the rate limit", async () => {
    const db = await getDb();
    expect(await sendPageForm({ ...contact, message: "" })).toMatchObject({
      ok: false,
      fieldErrors: { message: ["Write your message"] },
    });
    expect(
      await sendPageForm({
        formType: "callback",
        name: "Sam",
        consent: true,
        captchaToken: "good-token",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { phone: ["Enter the number to call"] } });
    expect(
      await sendPageForm({ formType: "newsletter", consent: true, captchaToken: "good-token" }),
    ).toMatchObject({ ok: false, fieldErrors: { email: ["Enter your email address"] } });
    expect(await sendPageForm({ ...contact, consent: false as unknown as true })).toMatchObject({
      ok: false,
      fieldErrors: { consent: expect.any(Array) },
    });
    expect(await sendPageForm({ ...contact, captchaToken: "bad" })).toMatchObject({
      ok: false,
      code: "CAPTCHA",
    });
    expect(await sendPageForm({ ...contact, website: "https://spam.example" })).toEqual({
      ok: true,
      data: { sent: true },
    });
    expect(await db.select().from(emailLog)).toEqual([]);
    let last;
    for (let i = 0; i < 6; i++) last = await sendPageForm(contact);
    expect(last).toMatchObject({ ok: false, code: "RATE_LIMITED" });
  });

  it("keeps the lead even when there is nobody to email", async () => {
    await patchSettings(await getDb(), "contact", { email: "", leadNotifyEmails: [] }, actor);
    expect(await sendPageForm(contact)).toEqual({ ok: true, data: { sent: true } });
    expect(await (await getDb()).select().from(leads)).toHaveLength(1);
  });

  it("testimonials and FAQs: only published ones, latest or picked in order", async () => {
    const db = await getDb();
    const [a, b, hidden] = [newId(), newId(), newId()];
    await db.insert(testimonials).values([
      {
        id: a,
        name: "Amal",
        quote: "Smooth from start to finish.",
        rating: 5,
        isPublished: true,
        sortOrder: 1,
      },
      { id: b, name: "Ben", quote: "They knew the building.", isPublished: true, sortOrder: 2 },
      { id: hidden, name: "Draft", quote: "Not yet", isPublished: false, sortOrder: 0 },
    ]);
    expect(
      (await testimonialCards({ source: "latest", testimonialIds: [], count: 5 })).map(
        (t) => t.name,
      ),
    ).toEqual(["Amal", "Ben"]);
    expect(
      (await testimonialCards({ source: "manual", testimonialIds: [b, hidden, a], count: 3 })).map(
        (t) => t.name,
      ),
    ).toEqual(["Ben", "Amal"]);

    await db.insert(faqs).values([
      {
        question: "Can I buy off-plan?",
        answer: answer("Yes."),
        answerHtml: "<p>Yes.</p>",
        group: "off_plan",
        isPublished: true,
      },
      {
        question: "Fees?",
        answer: answer("2%."),
        answerHtml: "<p>2%.</p>",
        group: "buying",
        isPublished: true,
      },
      {
        question: "Hidden?",
        answer: answer("No."),
        answerHtml: "<p>No.</p>",
        group: "off_plan",
        isPublished: false,
      },
    ]);
    const items = await faqItems({ source: "group", group: "off_plan", faqIds: [], count: 8 });
    expect(items).toEqual([
      {
        id: expect.any(String),
        question: "Can I buy off-plan?",
        answerHtml: "<p>Yes.</p>",
        answerText: "Yes.",
      },
    ]);
  });

  it("reads a pasted search link the way the search pages do", () => {
    expect(filtersFromSearchLink("/buy/marina/villas?max=5000000")).toMatchObject({
      purpose: "sale",
      loc: ["marina"],
      type: ["villas"],
      max: 5_000_000,
    });
    expect(filtersFromSearchLink("https://agency.example/rent?beds=2")).toMatchObject({
      purpose: "rent",
      beds: [2],
    });
    expect(filtersFromSearchLink("/off-plan")).toMatchObject({ completion: "off_plan" });
    expect(filtersFromSearchLink("type=apartments&min=100000")).toMatchObject({
      purpose: "sale",
      type: ["apartments"],
      min: 100_000,
    });
  });
});
