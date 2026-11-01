import { z } from "zod";
import { formatMoney, toMinor, type CurrencyFormat } from "@/lib/money";
import {
  isTemplateKey,
  templateDefaults,
  unknownVariables,
  type TemplateDefault,
  type TemplateKey,
} from "./defaults";

/** The templates editor's input (Settings -> Message templates). Client-safe. */

const keySchema = z
  .string()
  .refine(isTemplateKey, "Unknown template")
  .transform((k) => k as TemplateKey);

const builtIn = (key: string) => (templateDefaults as Record<string, TemplateDefault>)[key];

export const templateSaveSchema = z
  .object({
    key: keySchema,
    channel: z.enum(["email", "whatsapp"]),
    subject: z.string().trim().max(200, "Use at most 200 characters").default(""),
    body: z.string().trim().min(1, "Write the message").max(5000, "Use at most 5,000 characters"),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    const def = builtIn(v.key);
    if (!def?.[v.channel]) {
      ctx.addIssue({
        code: "custom",
        path: ["channel"],
        message: "This message has no such channel",
      });
      return;
    }
    if (v.channel === "email" && !v.subject)
      ctx.addIssue({ code: "custom", path: ["subject"], message: "Write the subject" });
    for (const field of ["subject", "body"] as const) {
      const unknown = unknownVariables(v[field], def.variables);
      if (unknown.length)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `Unknown ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use: ${def.variables.map((x) => `{{${x}}}`).join(" ")}`,
        });
    }
  });
export type TemplateSaveInput = z.input<typeof templateSaveSchema>;

export const templateKeySchema = z.object({
  key: keySchema,
  channel: z.enum(["email", "whatsapp"]),
});

/** The approved WhatsApp template used outside the 24-hour window (13 §1). */
export const whatsappMappingSchema = z
  .object({
    key: keySchema,
    /** Empty removes the mapping. */
    name: z
      .string()
      .trim()
      .max(100)
      .regex(/^$|^[a-z0-9_]+$/, "Use the template's name at Meta: lower case, digits and _"),
    language: z
      .string()
      .trim()
      .max(10)
      .regex(/^$|^[a-z]{2,3}(_[A-Z]{2})?$/, "Like en or en_US"),
    /** Which variables fill {{1}}, {{2}}, … in the approved template, in order. */
    variables: z.array(z.string()).max(10),
  })
  .superRefine((v, ctx) => {
    const unknown = v.variables.filter((x) => !builtIn(v.key)?.variables.includes(x));
    if (unknown.length)
      ctx.addIssue({
        code: "custom",
        path: ["variables"],
        message: `Not a variable of this message: ${unknown.join(", ")}`,
      });
  });
export type WhatsappMappingInput = z.input<typeof whatsappMappingSchema>;

/** Example values for the editor's preview, market-neutral (sampleValuesFor fills the market). */
export const sampleValues: Record<string, string> = {
  name: "Sam",
  agent: "Alex",
  channel: "website chat",
  reason: "Asked about lowering the price",
  agency: "Your agency",
  reference: "REF-2041",
  url: "https://example.com/property/two-bed-apartment",
  phone: "+1 555 0100",
  email: "sam@example.com",
  source: "Website form",
  interest: "REF-2041 · Two bed with a garden view",
  details: "Preferred time: Saturday 10am",
  message: "Is it still available?",
  minutes: "12",
  what: "REF-2041 · Two bed with a garden view",
  when: "Saturday 24 October at 10:00",
  agencyTime: "",
  how: "In person",
  notes: "Parking?",
  change: "moved",
  manageUrl: "https://example.com/viewings/…",
  bookUrl: "https://example.com/property/two-bed-apartment",
  feedbackUrl: "https://example.com/viewings/…/feedback",
  homes: "3 homes",
  list: "Two bed with a marina view\nGarden villa with a pool",
  confirmUrl: "https://example.com/newsletter/confirm/…",
  unsubscribeUrl: "https://example.com/newsletter/unsubscribe?…",
  search: "2 beds in the city centre",
  count: "3",
  period: "this week",
  title: "Two bed with a garden view",
  price: "2,350,000",
  drop: "100,000",
  status: "reserved",
  summary:
    "Gross yield 7% · Net yield 4.7% · Net cash flow AED 98,000 a year · IRR 4.4% over 10 years",
  days: "30",
  area: "Dubai Marina",
  home: "2-bed apartment, 1,280 sq ft, Marina Gate, Dubai Marina",
  estimate:
    "Our first estimate is AED 2,350,000 – AED 2,600,000, based on 6 similar homes in Dubai Marina. It comes from homes we have listed and is not a formal valuation.",
  purpose: "sell",
  integration: "Email (Resend)",
  error: "Resend answered 401: API key is invalid",
  updated: "1 September 2026",
  currencies: "USD, EUR, GBP",
};

/**
 * The preview's example values in the agency's own market: its name, reference prefix,
 * currency and phone format (04 §3), so a US agency sees "$" and a Dubai one "AED".
 */
export function sampleValuesFor(ctx: {
  agency: string;
  referencePrefix: string;
  currency: CurrencyFormat;
  phoneExample: string | null;
}): Record<string, string> {
  const ref = `${ctx.referencePrefix}-2041`;
  const swap = (v: string) => v.replaceAll("REF-2041", ref);
  return {
    ...Object.fromEntries(Object.entries(sampleValues).map(([k, v]) => [k, swap(v)])),
    agency: ctx.agency || sampleValues.agency!,
    reference: ref,
    ...(ctx.phoneExample ? { phone: ctx.phoneExample } : {}),
    price: formatMoney(toMinor(2_350_000, ctx.currency.decimals), ctx.currency),
    drop: formatMoney(toMinor(100_000, ctx.currency.decimals), ctx.currency),
  };
}
