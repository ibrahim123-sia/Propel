import type { PageFormInput } from "./schema";

/**
 * The page builder forms' checks in the browser, with the server schema's wording
 * (schema.ts), so Zod is not shipped with every page that has a form. The server checks
 * everything again. Client-safe.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const limits: Partial<Record<keyof PageFormInput, number>> = {
  name: 80,
  phone: 30,
  message: 2000,
  preferredTime: 120,
  area: 120,
  propertyType: 60,
  beds: 10,
  expectedPrice: 40,
};

export function checkPageForm(v: PageFormInput): Partial<Record<keyof PageFormInput, string>> {
  const errors: Partial<Record<keyof PageFormInput, string>> = {};
  const value = (k: keyof PageFormInput) => String(v[k] ?? "").trim();
  for (const [key, max] of Object.entries(limits) as Array<[keyof PageFormInput, number]>)
    if (value(key).length > max) errors[key] = `Use at most ${max} characters`;
  const email = value("email");
  if (email && (!EMAIL.test(email) || email.length > 160))
    errors.email = "Enter a valid email address";
  if (v.consent !== true) errors.consent = "Please agree so we can contact you.";

  const need = (ok: boolean, key: keyof PageFormInput, message: string) => {
    if (!ok) errors[key] ??= message;
  };
  if (v.formType === "newsletter") {
    need(email !== "", "email", "Enter your email address");
    return errors;
  }
  need(value("name").length >= 2, "name", "Enter your name");
  if (v.formType === "callback") {
    need(value("phone") !== "", "phone", "Enter the number to call");
    return errors;
  }
  need(
    email !== "" || value("phone") !== "",
    "email",
    "Enter an email address or a phone number so we can reply",
  );
  if (v.formType === "contact") need(value("message") !== "", "message", "Write your message");
  if (v.formType === "valuation" || v.formType === "list_property")
    need(value("area") !== "", "area", "Say where the property is");
  if (v.formType === "list_property") need(v.purpose != null, "purpose", "Choose sale or rent");
  return errors;
}
