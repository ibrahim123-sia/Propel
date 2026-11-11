import "server-only";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { pages } from "@/db/schema/cms";
import { valuationRequests, type Requirements } from "@/db/schema/crm";
import { locations, propertyTypes } from "@/db/schema/master-data";
import { captureLead, type LeadCapture } from "@/features/leads/capture";
import { subscribeNewsletter } from "@/features/newsletter/subscribe";
import { loadSettings } from "@/features/settings/queries";
import { OWNER_REQUEST_NOTIFY_JOB } from "@/features/valuation/notify";
import { enqueue } from "@/jobs/enqueue";
import type { PageForm } from "./schema";

type FormInput = Omit<PageForm, "consent" | "website" | "captchaToken">;

/** "Studio" is 0 bedrooms; anything else needs a number. */
export function parseBeds(text: string): number | null {
  if (/studio/i.test(text)) return 0;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 && n < 100 ? n : null;
}

/** The location or property type a visitor typed, when it names one we know. */
async function matchMasterData(db: Db, area: string, type: string) {
  const agency = currentAgencyId();
  const [location] = area
    ? await db
        .select({ id: locations.id })
        .from(locations)
        .where(
          and(
            eq(locations.agencyId, agency),
            or(
              sql`lintel_normalize(${locations.name}) = lintel_normalize(${area})`,
              eq(locations.slug, area.toLowerCase()),
            ),
          ),
        )
        .limit(1)
    : [];
  const [propertyType] = type
    ? await db
        .select({ id: propertyTypes.id })
        .from(propertyTypes)
        .where(
          and(
            eq(propertyTypes.agencyId, agency),
            or(
              sql`lintel_normalize(${propertyTypes.name}) = lintel_normalize(${type})`,
              eq(propertyTypes.slug, type.toLowerCase()),
            ),
          ),
        )
        .limit(1)
    : [];
  return { locationId: location?.id ?? null, propertyTypeId: propertyType?.id ?? null };
}

const sources = {
  contact: "form",
  callback: "callback",
  valuation: "valuation",
} as const;

/**
 * A page form submit (06 §10, 09 §1): contact, callback, valuation and "list your property"
 * become leads (or a new entry on the person's open lead) with the visitor's attribution;
 * owners also get a valuation or listing request and a task. The agency hears about it from
 * the lead pipeline. A newsletter form signs the address up (double opt-in).
 */
export async function handlePageForm(
  db: Db,
  input: FormInput,
  visitorKey: string | null = null,
): Promise<{ kind: "lead" | "subscriber"; leadId?: string }> {
  const [page] = input.pageId
    ? await db
        .select({ title: pages.title, slug: pages.slug })
        .from(pages)
        .where(
          and(
            eq(pages.id, input.pageId),
            eq(pages.agencyId, currentAgencyId()),
            isNull(pages.deletedAt),
          ),
        )
    : [];

  if (input.formType === "newsletter") {
    await subscribeNewsletter(db, {
      email: input.email,
      source: page ? `page:${page.slug}` : "page",
    });
    return { kind: "subscriber" };
  }

  const owner = input.formType === "valuation";
  const { locationId, propertyTypeId } = owner
    ? await matchMasterData(db, input.area, input.propertyType)
    : { locationId: null, propertyTypeId: null };
  const beds = owner ? parseBeds(input.beds) : null;
  const purpose = input.purpose ?? "sale";
  const requirements: Requirements = owner
    ? {
        purpose,
        ...(locationId ? { locationIds: [locationId] } : {}),
        ...(propertyTypeId ? { propertyTypeIds: [propertyTypeId] } : {}),
        ...(beds !== null ? { bedsMin: beds } : {}),
      }
    : {};
  const when = input.preferredTime;
  const where = input.area || "their property";
  const task: LeadCapture["task"] =
    input.formType === "callback"
      ? { title: when ? `Call back (best time: ${when})` : "Call back", dueAt: new Date() }
      : input.formType === "valuation"
        ? { title: `Value the home in ${where}`, dueAt: new Date() }
        : null;

  const lead = await captureLead(db, {
    source: sources[input.formType],
    sourceDetail: input.formType === "contact" ? "contact" : "page form",
    contact: {
      name: input.name,
      email: input.email || null,
      phone: input.phone || null,
      preferredContact: input.formType === "callback" ? "call" : null,
    },
    message: input.message || null,
    requirements,
    details: Object.fromEntries(
      Object.entries({
        page: page?.title ?? "",
        preferredTime: when,
        purpose: owner ? (purpose === "rent" ? "Rent" : "Sale") : "",
        area: input.area,
        propertyType: input.propertyType,
        beds: input.beds,
        expectedPrice: input.expectedPrice,
      }).filter(([, v]) => v !== ""),
    ),
    visitorKey,
    task,
  });

  if (owner) {
    const notes = [
      input.message,
      input.expectedPrice ? `Expected price: ${input.expectedPrice}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const row = {
      contactId: lead.contactId,
      leadId: lead.leadId,
      purpose: purpose === "rent" ? ("rent" as const) : ("sell" as const),
      propertyTypeId,
      locationId,
      building: input.area || null,
      beds,
      notes: notes || null,
    };
    const market = await loadSettings("market", db);
    const kind = "valuation" as const;
    const [saved] = await db
      .insert(valuationRequests)
      .values({ ...row, currency: market.baseCurrency.code })
      .returning({ id: valuationRequests.id });
    // The owner's confirmation and the team's notice (features/valuation/notify.ts).
    await enqueue(
      OWNER_REQUEST_NOTIFY_JOB,
      { kind, requestId: saved!.id },
      { db, dedupeKey: `${OWNER_REQUEST_NOTIFY_JOB}:${saved!.id}` },
    );
  }
  return { kind: "lead", leadId: lead.leadId };
}
