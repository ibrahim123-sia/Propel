import { z } from "zod";
import { pageFormTypes, type PageFormType } from "@/features/cms/sections";

/**
 * The page builder's forms (08 §1 "Form" and "Contact block", 06 §10): contact, callback,
 * valuation, list your property and newsletter. Checked in the browser and again on the server.
 */
export type { PageFormType };

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);

export const pageFormSchema = z
  .object({
    formType: z.enum(pageFormTypes),
    /** The page it was sent from, for the email ("Sent from: About us"). */
    pageId: z.uuid().nullable().default(null),
    name: text(80).default(""),
    email: z.union([z.email("Enter a valid email address").max(160), z.literal("")]).default(""),
    phone: text(30).default(""),
    message: text(2000).default(""),
    preferredTime: text(120).default(""),
    purpose: z.enum(["sale", "rent"]).nullable().default(null),
    area: text(120).default(""),
    propertyType: text(60).default(""),
    beds: text(10).default(""),
    expectedPrice: text(40).default(""),
    consent: z.literal(true, { error: "Please agree so we can contact you." }),
    /** Honeypot: hidden from people, filled in by bots. */
    website: z.string().max(200).default(""),
    captchaToken: z.string().max(4000).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    if (v.formType === "newsletter") {
      need(v.email !== "", "email", "Enter your email address");
      return;
    }
    need(v.name.length >= 2, "name", "Enter your name");
    if (v.formType === "callback") {
      need(v.phone !== "", "phone", "Enter the number to call");
      return;
    }
    need(
      v.email !== "" || v.phone !== "",
      "email",
      "Enter an email address or a phone number so we can reply",
    );
    if (v.formType === "contact") need(v.message !== "", "message", "Write your message");
    if (v.formType === "valuation") need(v.area !== "", "area", "Say where the property is");
  });

export type PageFormInput = z.input<typeof pageFormSchema>;
export type PageForm = z.output<typeof pageFormSchema>;
