import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, type Db, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { contacts, conversations, leads } from "@/db/schema/crm";
import { propertyTypes } from "@/db/schema/master-data";
import { guideForLocation, liveCounts } from "@/features/area-guides/public";
import { handleBrochureRequest } from "@/features/brochure/request";
import { compareItems } from "@/features/compare/load";
import { captureLead } from "@/features/leads/capture";
import { loadListingCards } from "@/features/listings/cards";
import { getPublicListing } from "@/features/listings/public";
import { getPublicProject } from "@/features/projects/public";
import { loadSettings } from "@/features/settings/queries";
import { siteUrl } from "@/features/site/url";
import { mortgage, rentalReturns, roundTo } from "@/features/tools/math";
import { availableSlots } from "@/features/viewings/availability";
import { bookingTarget, bookViewing } from "@/features/viewings/book";
import { zonedDate } from "@/features/viewings/slots";
import { ActionError } from "@/lib/actions";
import { toMinor } from "@/lib/money";
import { areaFromSqm, formatDistance, formatDuration, perAreaFromSqm } from "@/lib/units";
import { hybridSearch, searchKnowledge, type HybridFilters } from "../retrieval/hybrid";
import { defineTool, type AiToolContext, type AnyAiTool } from "../tools/registry";
import { handOver } from "./handover";
import {
  findLocations,
  findTypeSlugs,
  listingFacts,
  liveListingByReference,
  liveListingIds,
  marketFormats,
  publishedProject,
  visitorKeyOf,
} from "./lookup";

/**
 * The customer assistant's tools (10 §2 "Tools (customer side)"). All are `read` tools: they
 * run at once, with the visitor's own data only. Booking, saving contact details and sending a
 * brochure act for the visitor, so the prompt has them confirm first and the inputs say so.
 * Every price, status and fact the model may state comes from here, loaded live.
 */

async function dbOf(ctx: AiToolContext): Promise<Db> {
  // Tools that write (leads, viewings) open their own transactions: they need the pool.
  return (ctx.db as Db | undefined) ?? (await getDb());
}

const leadSource = (ctx: AiToolContext) => (ctx.feature === "whatsapp" ? "whatsapp" : "chat");

/** Links the conversation to the lead the visitor just became (an earlier link stays). */
async function linkConversation(db: DbOrTx, ctx: AiToolContext, leadId: string) {
  if (!ctx.conversationRef) return;
  const [lead] = await db
    .select({ contactId: leads.contactId })
    .from(leads)
    .where(eq(leads.id, leadId));
  if (!lead) return;
  await db
    .update(conversations)
    .set({ leadId })
    .where(and(eq(conversations.id, ctx.conversationRef), isNull(conversations.leadId)));
  await db
    .update(conversations)
    .set({ contactId: lead.contactId })
    .where(and(eq(conversations.id, ctx.conversationRef), isNull(conversations.contactId)));
}

/** The contact the conversation already belongs to (from the chat's start or an earlier tool). */
async function conversationContact(db: DbOrTx, ctx: AiToolContext) {
  if (!ctx.conversationRef) return null;
  const [row] = await db
    .select({ name: contacts.name, email: contacts.email, phone: contacts.phone })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, ctx.conversationRef));
  return row ?? null;
}

const notFound = (what: string) => ({
  found: false,
  note: `${what} is not among the agency's live listings. Do not describe it; say you could not find it and offer to search or to ask the team.`,
});

const reference = z.string().trim().min(2).max(40).describe("The listing reference, e.g. HD-1001");

/* search_listings ------------------------------------------------------------------------ */

export const searchListingsTool = defineTool({
  kind: "read",
  name: "search_listings",
  description:
    "Search the agency's live listings. Use for any question about what is available. Returns up to 6 listings with live prices and a confidence; with low or no confidence, say you don't know rather than guess.",
  input: z.object({
    text: z
      .string()
      .max(300)
      .optional()
      .describe("What the visitor asked for in their words (views, features, style)"),
    purpose: z.enum(["sale", "rent"]).optional(),
    areas: z.array(z.string().max(80)).max(5).optional().describe("Area or building names"),
    types: z
      .array(z.string().max(40))
      .max(4)
      .optional()
      .describe("Property types, e.g. apartment, villa"),
    minPrice: z.number().min(0).optional().describe("In the agency's base currency, whole units"),
    maxPrice: z.number().min(0).optional().describe("In the agency's base currency, whole units"),
    beds: z.array(z.number().int().min(0).max(5)).max(6).optional().describe("0 is a studio"),
    completion: z.enum(["ready", "off_plan"]).optional(),
    polygon: z
      .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
      .min(3)
      .max(50)
      .optional()
      .describe("A drawn area as [lng, lat] points"),
  }),
  async run(input, ctx) {
    const db = await dbOf(ctx);
    const market = await loadSettings("market", db);
    const filters: HybridFilters = {};
    if (input.purpose) filters.purpose = input.purpose;
    if (input.completion) filters.completion = input.completion;
    if (input.minPrice !== undefined) filters.min = input.minPrice;
    if (input.maxPrice !== undefined) filters.max = input.maxPrice;
    if (input.beds?.length) filters.beds = input.beds;
    if (input.polygon) filters.poly = input.polygon;
    const unknownAreas: string[] = [];
    if (input.areas?.length) {
      const found = await findLocations(db, input.areas);
      filters.loc = found.map((l) => l.slug);
      unknownAreas.push(
        ...input.areas.filter(
          (a) => !found.some((l) => l.name.toLowerCase().includes(a.trim().toLowerCase())),
        ),
      );
      // Every area unknown: searching everywhere would answer a different question.
      if (!found.length)
        return {
          confidence: "none",
          listings: [],
          advice: `The agency has no area called ${input.areas.join(", ")}. Say so and ask where else they would like to look.`,
        };
    }
    if (input.types?.length) {
      const slugs = await findTypeSlugs(db, input.types);
      if (slugs.length) filters.type = slugs;
    }
    const res = await hybridSearch({ text: input.text ?? null, filters, limit: 6 }, { db });
    const f = marketFormats(market);
    return {
      confidence: res.confidence,
      advice: res.advice,
      matching: res.candidates,
      ...(unknownAreas.length ? { unknownAreas } : {}),
      listings: res.listings.map((card) => ({ id: card.id, ...listingFacts(card, f) })),
    };
  },
});

/* get_listing ---------------------------------------------------------------------------- */

export const getListingTool = defineTool({
  kind: "read",
  name: "get_listing",
  description:
    "Live details of one listing by its reference: price, status, sizes, fees, facilities, payment plan, agent. Call it before stating a price or status.",
  input: z.object({ reference }),
  async run({ reference: ref }, ctx) {
    const db = await dbOf(ctx);
    const row = await liveListingByReference(db, ref);
    if (!row) return notFound(`Listing ${ref}`);
    const [listing, [card], market] = await Promise.all([
      getPublicListing(row.slug),
      loadListingCards(db, [row.id]),
      loadSettings("market", db),
    ]);
    if (!listing || !card) return notFound(`Listing ${ref}`);
    const f = marketFormats(market);
    return {
      found: true,
      id: row.id,
      // Price and status from the live row (the card), never from cached text.
      ...listingFacts(card, f),
      building: listing.buildingName,
      plotSize: listing.plotSize ? f.area(listing.plotSize) : null,
      yearBuilt: listing.yearBuilt,
      floor: listing.floor,
      view: listing.view,
      parking: listing.parkingSpaces,
      furnishing: listing.furnishing,
      ownership: listing.ownership,
      serviceCharge:
        listing.serviceChargePerArea !== null
          ? `${f.money(perAreaFromSqm(listing.serviceChargePerArea, market.areaUnit))} per ${market.areaUnit === "sqft" ? "sq ft" : "m²"} a year`
          : null,
      rentPayments: listing.purpose === "rent" ? listing.rentPaymentOptions : undefined,
      deposit: listing.depositAmount !== null ? f.money(listing.depositAmount) : null,
      agencyFee: listing.agencyFeeText,
      expectedRent:
        listing.expectedRentYearly !== null
          ? `${f.money(listing.expectedRentYearly)} a year`
          : null,
      tenanted: listing.isTenanted || undefined,
      highlights: listing.highlights,
      description: listing.descriptionText.slice(0, 1500),
      facilities: listing.facilities.map((x) => x.name),
      paymentPlan: listing.plan
        ? {
            label: listing.plan.summaryLabel,
            steps: listing.plan.steps.map((s) => `${s.percent}% ${s.label}`),
          }
        : null,
      constructionProgress: listing.constructionProgress,
      verified: listing.verifiedAt,
      agent: listing.agent
        ? { name: listing.agent.name, languages: listing.agent.languages }
        : null,
      priceReduced: listing.priceHistory.some(
        (h) => h.oldPrice !== null && h.newPrice !== null && h.newPrice < h.oldPrice,
      ),
    };
  },
});

/* get_project ---------------------------------------------------------------------------- */

export const getProjectTool = defineTool({
  kind: "read",
  name: "get_project",
  description:
    "Facts about a published off-plan or new project by name or slug: developer, handover, progress, unit types with prices, payment plan.",
  input: z.object({ project: z.string().trim().min(2).max(120) }),
  async run({ project: name }, ctx) {
    const db = await dbOf(ctx);
    const row = await publishedProject(db, name);
    const project = row ? await getPublicProject(row.slug) : null;
    if (!project)
      return {
        found: false,
        note: `There is no published project called "${name}". Say you could not find it.`,
      };
    const market = await loadSettings("market", db);
    const f = marketFormats(market);
    return {
      found: true,
      name: project.name,
      url: siteUrl(`/projects/${project.slug}`),
      status: project.status.replace(/_/g, " "),
      developer: project.developer?.name ?? null,
      area: project.locationPath.map((l) => l.name).join(", "),
      handover: project.handover,
      progress: project.progress,
      startingPrice:
        project.startingPrice !== null ? f.money(project.startingPrice, project.currency) : null,
      totalUnits: project.totalUnits,
      unitTypes: project.unitTypes.map((u) => ({
        name: u.name,
        beds: u.beds,
        size:
          u.sizeMin !== null
            ? u.sizeMax && u.sizeMax !== u.sizeMin
              ? `${f.area(u.sizeMin)} to ${f.area(u.sizeMax)}`
              : f.area(u.sizeMin)
            : null,
        priceFrom: u.priceFrom !== null ? f.money(u.priceFrom, project.currency) : null,
        available: u.availableCount,
      })),
      paymentPlan: project.plan
        ? {
            label: project.plan.summaryLabel,
            steps: project.plan.steps.map((s) => `${s.percent}% ${s.label}`),
          }
        : null,
      facilities: project.facilities.map((x) => x.name),
      highlights: project.highlights,
    };
  },
});

/* nearby --------------------------------------------------------------------------------- */

export const nearbyTool = defineTool({
  kind: "read",
  name: "nearby",
  description:
    "Measured distances from a listing to nearby places (schools, metro, malls, beaches...). Only these distances may be quoted.",
  input: z.object({
    reference,
    placeType: z
      .string()
      .max(60)
      .optional()
      .describe("e.g. school, metro, mall, beach; leave out for all"),
  }),
  async run({ reference: ref, placeType }, ctx) {
    const db = await dbOf(ctx);
    const row = await liveListingByReference(db, ref);
    const listing = row ? await getPublicListing(row.slug) : null;
    if (!listing) return notFound(`Listing ${ref}`);
    const market = await loadSettings("market", db);
    const want = placeType?.trim().toLowerCase().replace(/s$/, "");
    const places = listing.nearby
      .filter(
        (p) =>
          !want ||
          p.typeName.toLowerCase().includes(want) ||
          p.category.toLowerCase().includes(want) ||
          p.name.toLowerCase().includes(want),
      )
      .slice(0, 8)
      .map((p) => {
        const seconds = p.mode === "walk" ? p.walkSeconds : p.driveSeconds;
        return {
          name: p.name,
          type: p.typeName,
          distance: p.overrideText ?? formatDistance(p.distanceM, market.distanceUnit),
          time: seconds
            ? `${formatDuration(seconds)} ${p.mode === "walk" ? "walk" : "drive"}`
            : null,
        };
      });
    return {
      reference: listing.reference,
      places,
      note: places.length
        ? "Distances are measured from the listing's area; times are estimates."
        : "No measured places of that kind for this listing. Say you don't have that distance.",
    };
  },
});

/* area_info ------------------------------------------------------------------------------ */

export const areaInfoTool = defineTool({
  kind: "read",
  name: "area_info",
  description:
    "An area's guide summary (from the agency's area guide) and how many homes are live there now for sale and for rent.",
  input: z.object({ area: z.string().trim().min(2).max(80) }),
  async run({ area }, ctx) {
    const db = await dbOf(ctx);
    const [loc] = await findLocations(db, [area]);
    if (!loc) return { found: false, note: `The agency has no area called "${area}". Say so.` };
    const [guide, counts] = await Promise.all([guideForLocation(loc.id), liveCounts(db, loc.id)]);
    return {
      found: true,
      name: loc.name,
      liveListings: { forSale: counts.sale, forRent: counts.rent },
      guide: guide
        ? {
            url: siteUrl(`/areas/${guide.slug}`),
            intro: guide.intro?.slice(0, 1200) ?? null,
            questions: guide.faqs.slice(0, 6).map((q) => q.question),
          }
        : null,
      searchUrl: siteUrl(`/buy/${loc.slug}`),
    };
  },
});

/* answer_faq ----------------------------------------------------------------------------- */

export const answerFaqTool = defineTool({
  kind: "read",
  name: "answer_faq",
  description:
    "Search the agency's FAQs, pages, blog posts and guides for an answer (fees, process, buying rules, the agency itself). Use only what it returns.",
  input: z.object({ question: z.string().trim().min(3).max(300) }),
  async run({ question }, ctx) {
    const db = await dbOf(ctx);
    const res = await searchKnowledge({ text: question, limit: 3 }, { db });
    return {
      confidence: res.confidence,
      advice: res.advice,
      answers: res.hits.map((h) => ({ from: h.entityType, text: h.content.slice(0, 1500) })),
    };
  },
});

/* mortgage_estimate ---------------------------------------------------------------------- */

export const mortgageEstimateTool = defineTool({
  kind: "read",
  name: "mortgage_estimate",
  description:
    "Monthly mortgage payment and upfront cash, with the same maths as the site's calculator. Give a listing reference or a price. Always call the result an estimate.",
  input: z.object({
    reference: reference.optional(),
    price: z.number().positive().optional().describe("Whole units of the base currency"),
    downPaymentPct: z.number().min(0).max(100).optional(),
    years: z.number().int().min(1).max(40).optional(),
    ratePct: z.number().min(0).max(30).optional(),
  }),
  async run(input, ctx) {
    const db = await dbOf(ctx);
    const market = await loadSettings("market", db);
    const f = marketFormats(market);
    let priceMinor: number | null = null;
    if (input.reference) {
      const row = await liveListingByReference(db, input.reference);
      const [card] = row ? await loadListingCards(db, [row.id]) : [];
      if (!card) return notFound(`Listing ${input.reference}`);
      if (card.purpose !== "sale" || card.price === null || card.priceOnRequest)
        return { error: "This listing has no sale price to work from." };
      priceMinor = card.price;
    } else if (input.price) priceMinor = toMinor(input.price, f.decimals);
    if (priceMinor === null) return { error: "Give a listing reference or a price." };

    const m = market.mortgage;
    const downPct = Math.max(input.downPaymentPct ?? m.downPaymentPct, 100 - m.maxLtvPct);
    const result = mortgage({
      price: priceMinor,
      downPayment: Math.round((priceMinor * downPct) / 100),
      years: Math.min(input.years ?? m.years, m.maxYears),
      ratePct: input.ratePct ?? m.interestRatePct,
      registrationFeePct: m.registrationFeePct,
      agencyFeePct: m.agencyFeePct,
      arrangementFeePct: m.arrangementFeePct,
    });
    return {
      estimate: true,
      price: f.money(result.price),
      downPayment: `${f.money(result.downPayment)} (${roundTo(downPct, 1)}%)`,
      loan: f.money(result.loan),
      years: result.months / 12,
      ratePct: input.ratePct ?? m.interestRatePct,
      monthlyPayment: f.money(Math.round(result.monthlyPayment)),
      fees: f.money(result.fees.total),
      upfrontCash: f.money(result.upfrontCash),
      totalInterest: f.money(Math.round(result.totalInterest)),
      calculatorUrl: siteUrl("/tools/mortgage"),
      note: `Most lenders lend up to ${m.maxLtvPct}% of the price. This is an estimate, not a mortgage offer.`,
    };
  },
});

/* rental_return -------------------------------------------------------------------------- */

export const rentalReturnTool = defineTool({
  kind: "read",
  name: "rental_return",
  description:
    "Rental yield and cash flow for a home let long-term, with the same maths as the site's rental return simulator. Give a listing reference or a price and the yearly rent. Never promise returns.",
  input: z.object({
    reference: reference.optional(),
    price: z.number().positive().optional().describe("Whole units of the base currency"),
    rentYearly: z.number().positive().optional().describe("Whole units of the base currency"),
  }),
  async run(input, ctx) {
    const db = await dbOf(ctx);
    const market = await loadSettings("market", db);
    const f = marketFormats(market);
    const roi = market.roi;
    let price = input.price ? toMinor(input.price, f.decimals) : null;
    let rent = input.rentYearly ? toMinor(input.rentYearly, f.decimals) : null;
    let size = 0;
    let serviceCharge = roi.serviceChargePerArea;
    if (input.reference) {
      const row = await liveListingByReference(db, input.reference);
      const listing = row ? await getPublicListing(row.slug) : null;
      const [card] = row ? await loadListingCards(db, [row.id]) : [];
      if (!listing || !card) return notFound(`Listing ${input.reference}`);
      if (card.purpose === "sale" && card.price !== null && !card.priceOnRequest)
        price = card.price;
      rent ??= listing.expectedRentYearly;
      size = listing.size ? areaFromSqm(listing.size, market.areaUnit) : 0;
      if (listing.serviceChargePerArea !== null)
        serviceCharge = perAreaFromSqm(listing.serviceChargePerArea, market.areaUnit);
    }
    if (price === null) return { error: "Give a listing reference with a sale price, or a price." };
    if (rent === null)
      return { error: "Ask the visitor what yearly rent they expect; there is no expected rent." };
    const r = rentalReturns({
      price,
      purchaseCostsPct: roi.purchaseCostsPct,
      mode: "long",
      rentYearly: rent,
      nightlyHigh: 0,
      nightlyLow: 0,
      highSeasonMonths: 0,
      occupancyPct: roi.occupancyPct,
      managementFeePct: roi.managementFeePct,
      serviceChargePerArea: serviceCharge,
      size,
      maintenancePct: roi.maintenancePct,
      vacancyPct: roi.vacancyPct,
      mortgage: null,
      rentGrowthPct: roi.rentGrowthPct,
      priceGrowthPct: roi.priceGrowthPct,
    });
    return {
      estimate: true,
      price: f.money(price),
      rentYearly: f.money(rent),
      grossYieldPct: roundTo(r.grossYieldPct, 1),
      netYieldPct: roundTo(r.netYieldPct, 1),
      netCashFlowYear1: f.money(Math.round(r.netCashFlowYear1)),
      assumptions: `Bought with cash; ${roi.vacancyPct}% vacancy, ${roi.maintenancePct}% maintenance a year, ${roi.purchaseCostsPct}% purchase costs.`,
      simulatorUrl: siteUrl("/tools/rental-returns"),
      note: "An estimate from the agency's assumptions, not a promise of returns.",
    };
  },
});

/* compare -------------------------------------------------------------------------------- */

export const compareTool = defineTool({
  kind: "read",
  name: "compare",
  description: "Side-by-side facts of 2 to 4 listings by reference.",
  input: z.object({ references: z.array(reference).min(2).max(4) }),
  async run({ references }, ctx) {
    const db = await dbOf(ctx);
    const ids = await liveListingIds(db, references);
    if (ids.length < 2)
      return { error: "Fewer than two of these are live listings.", found: ids.length };
    const [items, market] = await Promise.all([compareItems(ids), loadSettings("market", db)]);
    const f = marketFormats(market);
    return {
      compareUrl: siteUrl(`/tools/compare?ids=${ids.join(",")}`),
      listings: items.map((i) => ({
        title: i.title,
        url: siteUrl(i.href),
        price: i.price !== null ? f.money(i.price, i.currency) : "Price on request",
        type: i.typeName,
        area: i.areaName,
        beds: i.beds,
        baths: i.baths,
        size: i.sizeMin !== null ? f.area(i.sizeMin) : null,
        completion: i.completion === "off_plan" ? "off-plan" : "ready",
        handover: i.handover,
        paymentPlan: i.planLabel,
        grossYieldPct: i.expectedYield !== null ? roundTo(i.expectedYield, 1) : null,
        nearestSchool: i.nearest.school
          ? `${i.nearest.school.name}, ${formatDistance(i.nearest.school.distanceM, market.distanceUnit)}`
          : null,
        nearestTransport: i.nearest.transport
          ? `${i.nearest.transport.name}, ${formatDistance(i.nearest.transport.distanceM, market.distanceUnit)}`
          : null,
        facilities: i.facilities.slice(0, 12),
      })),
    };
  },
});

/* available_slots ------------------------------------------------------------------------ */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const slotLabel = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

export const availableSlotsTool = defineTool({
  kind: "read",
  name: "available_slots",
  description:
    "Free viewing times for a listing (in the agency's time zone). Offer only times from this list.",
  input: z.object({
    reference,
    type: z.enum(["in_person", "video"]).default("in_person"),
    from: dateOnly.optional().describe("First day, YYYY-MM-DD (agency time)"),
    to: dateOnly.optional().describe("Last day, YYYY-MM-DD (agency time)"),
  }),
  async run({ reference: ref, type, from, to }, ctx) {
    const db = await dbOf(ctx);
    const row = await liveListingByReference(db, ref);
    if (!row) return notFound(`Listing ${ref}`);
    const target = await bookingTarget(db, { propertyId: row.id });
    const { rules, slots } = await availableSlots(db, target.agentId);
    const inRange = slots.filter((s) => {
      const day = zonedDate(s.start, rules.timeZone);
      return (!from || day >= from) && (!to || day <= to);
    });
    const picked = inRange.slice(0, 12);
    return {
      reference: row.reference,
      type,
      timeZone: rules.timeZone,
      lengthMinutes: rules.lengthMin,
      slots: picked.map((s) => ({
        start: s.start.toISOString(),
        label: slotLabel(s.start, rules.timeZone),
      })),
      more: inRange.length > picked.length,
      note: picked.length
        ? "Offer a few of these. Pass the chosen `start` exactly to book_viewing."
        : "No free times in that range. Offer other days or the team.",
    };
  },
});

/* book_viewing --------------------------------------------------------------------------- */

export const bookViewingTool = defineTool({
  kind: "read",
  name: "book_viewing",
  description:
    "Book a viewing at a free time from available_slots. First read the time and the visitor's details back to them; call this only after they confirm.",
  input: z.object({
    reference,
    start: z.iso.datetime({ offset: true }).describe("The `start` of a slot from available_slots"),
    type: z.enum(["in_person", "video"]).default("in_person"),
    name: z.string().trim().max(80).default(""),
    phone: z.string().trim().max(30).default(""),
    email: z.union([z.email().max(160), z.literal("")]).default(""),
    notes: z.string().trim().max(500).default(""),
    visitorConfirmed: z
      .literal(true)
      .describe("true only after the visitor confirmed the time and their details"),
  }),
  async run(input, ctx) {
    const db = await dbOf(ctx);
    const { requiredBeforeBooking: need } = await loadSettings("ai", db);
    // What the visitor already told us in this conversation fills the gaps, so the booking
    // joins their lead instead of starting a second one.
    const known = await conversationContact(db, ctx);
    const details = {
      name: input.name || known?.name || "",
      phone: input.phone || known?.phone || "",
      email: input.email || known?.email || "",
    };
    const missing = [
      need.name && details.name.length < 2 ? "name" : null,
      need.phone && !details.phone ? "phone number" : null,
      need.email && !details.email ? "email" : null,
      !details.phone && !details.email ? "a phone number or email" : null,
    ].filter(Boolean);
    if (missing.length)
      return { booked: false, ask: `Ask the visitor for their ${missing.join(" and ")} first.` };
    const row = await liveListingByReference(db, input.reference);
    if (!row) return notFound(`Listing ${input.reference}`);
    const visitorKey =
      ctx.actor.type === "visitor" ? await visitorKeyOf(db, ctx.actor.visitorId) : null;
    try {
      const booked = await bookViewing(db, {
        propertyId: row.id,
        type: input.type,
        start: new Date(input.start),
        ...details,
        notes: input.notes,
        timeZone: null,
        visitorKey,
        source: leadSource(ctx),
      });
      await linkConversation(db, ctx, booked.leadId);
      const tz = (await loadSettings("general", db)).timeZone;
      return {
        booked: true,
        reference: row.reference,
        when: slotLabel(new Date(input.start), tz),
        timeZone: tz,
        manageUrl: siteUrl(`/viewings/${booked.manageToken}`),
        note: "Booked and confirmed. A confirmation with a link to move or cancel is sent to the visitor.",
      };
    } catch (err) {
      if (err instanceof ActionError && err.code === "SLOT_TAKEN")
        return { booked: false, note: "That time was just taken. Check available_slots again." };
      throw err;
    }
  },
});

/* save_contact --------------------------------------------------------------------------- */

/** The agency's property types named by the visitor ("villa", "Apartments"), by name or slug. */
async function findPropertyTypeIds(db: DbOrTx, words: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: propertyTypes.id, name: propertyTypes.name, slug: propertyTypes.slug })
    .from(propertyTypes)
    .where(eq(propertyTypes.agencyId, currentAgencyId()));
  const norm = (v: string) => v.trim().toLowerCase().replace(/s$/, "");
  const wanted = new Set(words.map(norm));
  return rows.filter((t) => wanted.has(norm(t.name)) || wanted.has(norm(t.slug))).map((t) => t.id);
}

const timelines = ["now", "1_3_months", "3_6_months", "6_12_months", "later", "browsing"] as const;

export const saveContactTool = defineTool({
  kind: "read",
  name: "save_contact",
  description:
    "Save the visitor's contact details and everything you learned about what they want (buy or rent, property type, areas, budget, bedrooms, timeline), so the team can follow up. This creates the lead. Use as soon as they share a name with a phone or email.",
  input: z.object({
    name: z.string().trim().min(1).max(80),
    email: z.union([z.email().max(160), z.literal("")]).default(""),
    phone: z.string().trim().max(30).default(""),
    reference: reference.optional().describe("A listing they are interested in"),
    requirements: z
      .object({
        purpose: z.enum(["sale", "rent"]).optional(),
        propertyTypes: z
          .array(z.string().max(40))
          .max(5)
          .optional()
          .describe("Kinds of home, e.g. apartment, villa, townhouse"),
        budgetMax: z.number().positive().optional().describe("Whole units of the base currency"),
        budgetMin: z.number().positive().optional(),
        areas: z.array(z.string().max(80)).max(5).optional(),
        bedsMin: z.number().int().min(0).max(10).optional(),
        timeline: z.enum(timelines).optional(),
        finance: z.enum(["cash", "mortgage", "unknown"]).optional(),
      })
      .default({}),
    note: z.string().trim().max(500).optional(),
  }),
  async run(input, ctx) {
    if (!input.email && !input.phone)
      return { saved: false, ask: "Ask for a phone number or an email first." };
    const db = await dbOf(ctx);
    const market = await loadSettings("market", db);
    const r = input.requirements;
    const locationIds = r.areas?.length ? (await findLocations(db, r.areas)).map((l) => l.id) : [];
    const listing = input.reference ? await liveListingByReference(db, input.reference) : null;
    const typeIds = r.propertyTypes?.length ? await findPropertyTypeIds(db, r.propertyTypes) : [];
    const decimals = market.baseCurrency.decimals;
    const lead = await captureLead(db, {
      source: leadSource(ctx),
      sourceDetail: ctx.feature === "whatsapp" ? "WhatsApp assistant" : "website assistant",
      contact: { name: input.name, email: input.email || null, phone: input.phone || null },
      propertyId: listing?.id ?? null,
      message: input.note ?? null,
      requirements: {
        ...(r.purpose ? { purpose: r.purpose } : {}),
        ...(r.budgetMin ? { budgetMin: toMinor(r.budgetMin, decimals) } : {}),
        ...(r.budgetMax ? { budgetMax: toMinor(r.budgetMax, decimals) } : {}),
        ...(r.budgetMin || r.budgetMax
          ? { currency: market.baseCurrency.code, budgetFrom: "lead" as const }
          : {}),
        ...(locationIds.length ? { locationIds } : {}),
        ...(typeIds.length ? { propertyTypeIds: typeIds } : {}),
        ...(r.bedsMin !== undefined ? { bedsMin: r.bedsMin } : {}),
        ...(r.timeline ? { timeline: r.timeline } : {}),
        ...(r.finance ? { finance: r.finance } : {}),
      },
      visitorKey: ctx.actor.type === "visitor" ? await visitorKeyOf(db, ctx.actor.visitorId) : null,
      actor: { type: "ai" },
      eventType: "chat",
    });
    await linkConversation(db, ctx, lead.leadId);
    return { saved: true, note: "Saved. The team can now follow up; keep helping the visitor." };
  },
});

/* request_human -------------------------------------------------------------------------- */

export const requestHumanTool = defineTool({
  kind: "read",
  name: "request_human",
  description:
    "Hand the conversation to a person: price negotiation, legal or tax questions, complaints, the agency's human-only topics, or when the visitor asks for a person.",
  input: z.object({ reason: z.string().trim().min(3).max(300) }),
  async run({ reason }, ctx) {
    const db = await dbOf(ctx);
    const result = ctx.conversationRef
      ? await handOver(db, { conversationId: ctx.conversationRef, reason })
      : { agentName: null, alreadyWaiting: false };
    const who = result.agentName ?? "our team";
    return {
      handedOver: true,
      agent: who,
      say: `Good question for our team. I've asked ${who} to reply to you.`,
      note: "A person will answer here. Stop answering questions about this topic.",
    };
  },
});

/* send_brochure -------------------------------------------------------------------------- */

export const sendBrochureTool = defineTool({
  kind: "read",
  name: "send_brochure",
  description:
    "Email a listing's PDF brochure to the visitor (they also become a lead). Confirm the email address first.",
  input: z.object({
    reference,
    email: z.email().max(160),
    name: z.string().trim().min(1).max(80),
  }),
  async run(input, ctx) {
    const db = await dbOf(ctx);
    const row = await liveListingByReference(db, input.reference);
    if (!row) return notFound(`Listing ${input.reference}`);
    const res = await handleBrochureRequest(db, {
      kind: "property",
      id: row.id,
      name: input.name,
      email: input.email,
      visitorKey: ctx.actor.type === "visitor" ? await visitorKeyOf(db, ctx.actor.visitorId) : null,
    });
    await linkConversation(db, ctx, res.leadId);
    return { sent: true, to: input.email, downloadUrl: siteUrl(res.downloadPath) };
  },
});

/** Every tool of the website and WhatsApp assistant, in the order the model sees them. */
export const customerTools: AnyAiTool[] = [
  searchListingsTool,
  getListingTool,
  getProjectTool,
  nearbyTool,
  areaInfoTool,
  answerFaqTool,
  mortgageEstimateTool,
  rentalReturnTool,
  compareTool,
  availableSlotsTool,
  bookViewingTool,
  saveContactTool,
  requestHumanTool,
  sendBrochureTool,
];
