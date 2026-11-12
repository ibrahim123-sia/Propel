import { describe, expect, it } from "vitest";
import { checkPageForm } from "@/features/forms/check";
import { pageFormSchema, type PageFormInput } from "@/features/forms/schema";

const valid: PageFormInput = {
  formType: "contact",
  pageId: null,
  name: "Sam Visitor",
  email: "sam@example.com",
  phone: "",
  message: "Do you manage rentals?",
  preferredTime: "",
  consent: true,
  website: "",
  captchaToken: null,
};

/** The server's first message per field, like the form shows them. */
function serverErrors(input: PageFormInput): Record<string, string> {
  const res = pageFormSchema.safeParse(input);
  if (res.success) return {};
  const out: Record<string, string> = {};
  for (const issue of res.error.issues) out[String(issue.path[0])] ??= issue.message;
  return out;
}

const cases: Array<[string, Partial<PageFormInput>]> = [
  ["a valid contact message", {}],
  ["no name", { name: " " }],
  ["a long name", { name: "x".repeat(81) }],
  ["a bad email", { email: "sam@" }],
  ["no way to reply", { email: "", phone: "" }],
  ["a phone instead of an email", { email: "", phone: "050 123 4567" }],
  ["no message on the contact form", { message: "" }],
  ["a long message", { message: "x".repeat(2001) }],
  ["no consent", { consent: false as unknown as true }],
  ["a callback without a phone", { formType: "callback", phone: "" }],
  ["a callback with a phone", { formType: "callback", phone: "050 123 4567", email: "" }],
  ["a newsletter without an email", { formType: "newsletter", name: "", email: "" }],
  ["a newsletter signup", { formType: "newsletter", name: "" }],
];

describe("page builder form checks in the browser match the server", () => {
  it.each(cases)("%s", (_, patch) => {
    const input = { ...valid, ...patch } as PageFormInput;
    expect(checkPageForm(input)).toEqual(serverErrors(input));
  });
});
