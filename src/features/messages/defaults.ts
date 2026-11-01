/**
 * Email and WhatsApp message templates (13 §1, §3) with their built-in wording. An agency can
 * change any of them (message_templates rows override these by channel and key). Variables
 * are written {{name}}; unknown ones render empty. Client-safe (the editor shows them).
 */
export type TemplateChannel = "email" | "whatsapp";

export type TemplateDefault = {
  /** Who receives it. */
  audience: "customer" | "internal";
  /** What it is for, in the templates editor. */
  label: string;
  variables: string[];
  email?: { subject: string; body: string; button?: string };
  /** Sent as a session message inside the 24-hour window; outside it, an approved template. */
  whatsapp?: { body: string };
};

export const templateDefaults = {
  "lead.auto_reply": {
    audience: "customer",
    label: "Auto-reply to a new lead",
    variables: ["name", "agent", "agency", "reference", "url"],
    email: {
      subject: "Thanks, {{name}}. We have your message",
      body: "Hello {{name}},\n\nThank you for getting in touch with {{agency}}. {{agent}} will reach out shortly.\n\nWould you like to see the home in person? Reply to this email with a day and time that suit you.",
      button: "See the home again",
    },
    whatsapp: {
      body: "Thanks, {{name}}. {{agent}} from {{agency}} will reach out shortly. Want to book a viewing?",
    },
  },
  "lead.new": {
    audience: "internal",
    label: "New lead (to the agent and the lead inbox)",
    variables: [
      "name",
      "phone",
      "email",
      "source",
      "reference",
      "interest",
      "details",
      "message",
      "agent",
      "url",
    ],
    email: {
      subject: "New lead: {{name}} · {{reference}} · {{source}}",
      body: "{{name}} · {{phone}} · {{email}}\nInterested in: {{interest}}\nAssigned to: {{agent}}\n{{details}}\n\n{{message}}",
      button: "Open the lead",
    },
    whatsapp: { body: "New lead: {{name}} ({{source}}) about {{interest}}. {{url}}" },
  },
  "lead.new_message": {
    audience: "internal",
    label: "A lead got in touch again",
    variables: [
      "name",
      "phone",
      "email",
      "source",
      "reference",
      "interest",
      "details",
      "message",
      "url",
    ],
    email: {
      subject: "{{name}} got in touch again · {{reference}} · {{source}}",
      body: "{{name}} · {{phone}} · {{email}}\nAbout: {{interest}}\n{{details}}\n\n{{message}}",
      button: "Open the lead",
    },
  },
  "chat.handover": {
    audience: "internal",
    label: "A chat visitor asked for a person (the assistant handed over)",
    variables: ["name", "channel", "reason", "agent", "url"],
    email: {
      subject: "{{name}} would like a person to reply · {{channel}}",
      body: "The assistant handed this conversation over to the team.\n\nVisitor: {{name}}\nWhy: {{reason}}\nAgent: {{agent}}",
      button: "Open the conversation",
    },
    whatsapp: {
      body: "{{name}} would like a person to reply in the {{channel}}: {{reason}}. {{url}}",
    },
  },
  "lead.not_answered": {
    audience: "internal",
    label: "Lead not answered in time",
    variables: ["name", "minutes", "agent", "source", "url"],
    email: {
      subject: "Not answered for {{minutes}} minutes: {{name}}",
      body: "{{name}} ({{source}}) has been waiting {{minutes}} minutes for a reply.\nAssigned to: {{agent}}",
      button: "Reply now",
    },
    whatsapp: { body: "{{name}} has been waiting {{minutes}} minutes for a reply. {{url}}" },
  },
  "valuation.received": {
    audience: "customer",
    label: "Valuation request received, with the estimate (to the owner)",
    variables: ["name", "agency", "agent", "area", "home", "estimate", "url"],
    email: {
      subject: "Your valuation request for {{area}}",
      body: "Hello {{name}},\n\nThank you for asking {{agency}} to value your home: {{home}}.\n\n{{estimate}}\n\n{{agent}} will be in touch within 24 hours to go through it with you.",
      button: "See homes in your area",
    },
  },
  "valuation.new": {
    audience: "internal",
    label: "New valuation request (to the agent and the lead inbox)",
    variables: ["name", "phone", "email", "area", "home", "details", "message", "agent", "url"],
    email: {
      subject: "Valuation request: {{name}} · {{area}}",
      body: "{{name}} · {{phone}} · {{email}}\nHome: {{home}}\nAssigned to: {{agent}}\n{{details}}\n\n{{message}}",
      button: "Open the lead",
    },
    whatsapp: { body: "Valuation request from {{name}}: {{home}}. {{url}}" },
  },
  "listing_request.received": {
    audience: "customer",
    label: "List your property request received (to the owner)",
    variables: ["name", "agency", "agent", "area", "home", "purpose", "url"],
    email: {
      subject: "We have your property in {{area}}",
      body: "Hello {{name}},\n\nThank you for choosing {{agency}} to {{purpose}} your home: {{home}}.\n\n{{agent}} will call you within one working day to arrange photos and the listing details.",
      button: "See homes in your area",
    },
  },
  "listing_request.new": {
    audience: "internal",
    label: "New list your property request (to the agent and the lead inbox)",
    variables: [
      "name",
      "phone",
      "email",
      "area",
      "home",
      "purpose",
      "details",
      "message",
      "agent",
      "url",
    ],
    email: {
      subject: "List your property: {{name}} · {{area}}",
      body: "{{name}} · {{phone}} · {{email}}\nWants to {{purpose}}: {{home}}\nAssigned to: {{agent}}\n{{details}}\n\n{{message}}",
      button: "Open the lead",
    },
    whatsapp: { body: "{{name}} wants to {{purpose}} {{home}}. {{url}}" },
  },
  "viewing.confirmed": {
    audience: "customer",
    label: "Viewing booked (to the visitor)",
    variables: ["name", "what", "when", "agencyTime", "how", "agent", "agency", "manageUrl"],
    email: {
      subject: "Your viewing is booked: {{when}}",
      body: "Hello {{name}},\n\nYou are booked to see {{what}} on {{when}}{{agencyTime}}.\n{{how}}\n{{agent}} from {{agency}} will be with you.\n\nNeed another time? Change or cancel here: {{manageUrl}}",
      button: "Add to my calendar",
    },
    whatsapp: {
      body: "Your viewing of {{what}} is booked for {{when}}. {{agent}} will be with you. Change or cancel: {{manageUrl}}",
    },
  },
  "viewing.booked": {
    audience: "internal",
    label: "New viewing (to the agent and the lead inbox)",
    variables: ["name", "phone", "email", "what", "when", "how", "notes", "url"],
    email: {
      subject: "New viewing: {{name}} · {{what}} · {{when}}",
      body: "{{name}} · {{phone}} · {{email}}\n{{what}}\n{{when}}\n{{how}}\n\n{{notes}}",
      button: "Open the lead",
    },
    whatsapp: { body: "New viewing: {{name}}, {{what}}, {{when}}. {{url}}" },
  },
  "viewing.rescheduled": {
    audience: "customer",
    label: "Viewing moved (to the visitor)",
    variables: ["name", "what", "when", "agencyTime", "manageUrl"],
    email: {
      subject: "Your viewing has moved to {{when}}",
      body: "Hello {{name}},\n\nYour viewing of {{what}} is now on {{when}}{{agencyTime}}.\n\nChange or cancel here: {{manageUrl}}",
      button: "Add to my calendar",
    },
    whatsapp: { body: "Your viewing of {{what}} has moved to {{when}}. {{manageUrl}}" },
  },
  "viewing.cancelled": {
    audience: "customer",
    label: "Viewing cancelled (to the visitor)",
    variables: ["name", "what", "when", "bookUrl"],
    email: {
      subject: "Your viewing on {{when}} is cancelled",
      body: "Hello {{name}},\n\nYour viewing of {{what}} on {{when}} is cancelled. You can book another time whenever it suits you.",
      button: "Book another time",
    },
    whatsapp: { body: "Your viewing of {{what}} on {{when}} is cancelled. {{bookUrl}}" },
  },
  "viewing.changed": {
    audience: "internal",
    label: "Viewing moved or cancelled (to the agent and the lead inbox)",
    variables: ["name", "what", "when", "change", "url"],
    email: {
      subject: "Viewing {{change}}: {{name}} · {{what}}",
      body: "{{name}}'s viewing of {{what}} was {{change}}.\n{{when}}",
      button: "Open the lead",
    },
    whatsapp: { body: "Viewing {{change}}: {{name}}, {{what}}, {{when}}. {{url}}" },
  },
  "viewing.reminder": {
    audience: "customer",
    label: "Viewing reminder (to the visitor)",
    variables: ["name", "what", "when", "agencyTime", "how", "agent", "manageUrl"],
    email: {
      subject: "Reminder: your viewing {{when}}",
      body: "Hello {{name}},\n\nA reminder that you are seeing {{what}} on {{when}}{{agencyTime}}.\n{{how}}\n{{agent}} will be with you.\n\nCan't make it? Change or cancel here: {{manageUrl}}",
    },
    whatsapp: { body: "Reminder: your viewing of {{what}} is on {{when}}. {{manageUrl}}" },
  },
  "viewing.feedback": {
    audience: "customer",
    label: "How was the viewing? (to the visitor)",
    variables: ["name", "what", "feedbackUrl"],
    email: {
      subject: "How was your viewing of {{what}}?",
      body: "Hello {{name}},\n\nThank you for coming to see {{what}}. Two minutes to tell us what you thought helps us find you the right home.",
      button: "Rate the viewing",
    },
    whatsapp: { body: "Thanks for viewing {{what}}. How was it? {{feedbackUrl}}" },
  },
  "shortlist.sent": {
    audience: "customer",
    label: "Homes picked for a lead (send properties)",
    variables: ["name", "agent", "agency", "homes", "message", "url"],
    email: {
      subject: "{{homes}} picked for you by {{agent}}",
      body: "Hello {{name}},\n\n{{message}}\n\nThese fit what you are looking for. Tell me which ones you would like to see.\n\n{{agent}}, {{agency}}",
      button: "See the homes",
    },
    whatsapp: { body: "Hello {{name}}, {{homes}} picked for you: {{url}}" },
  },
  "brochure.link": {
    audience: "customer",
    label: "Brochure link (when Settings -> Leads asks for an email first)",
    variables: ["name", "title", "agency", "url"],
    email: {
      subject: "Your brochure: {{title}}",
      body: "Hello {{name}},\n\nHere is the brochure for {{title}}. The button below downloads the PDF; the link works for 30 days.\n\nReply to this email if you have any questions or would like to see it in person.\n\n{{agency}}",
      button: "Download the brochure",
    },
  },
  "compare.sent": {
    audience: "customer",
    label: "A comparison sent to the visitor's own email",
    variables: ["name", "homes", "list", "agency", "url"],
    email: {
      subject: "Your comparison: {{homes}}",
      body: "Hello {{name}},\n\nHere is the side-by-side comparison you made on our website:\n\n{{list}}\n\nThe button below opens it again; anyone you share the link with sees the same table.\n\n{{agency}}",
      button: "Open the comparison",
    },
  },
  "alerts.new_match": {
    audience: "customer",
    label: "New homes for a saved search, at once (alerts)",
    variables: ["name", "search", "count", "homes", "url"],
    email: {
      subject: "{{homes}} for “{{search}}”",
      body: "Hello {{name}},\n\n{{homes}} just came on the market for your search “{{search}}”.",
      button: "View all matches",
    },
    whatsapp: { body: "{{homes}} for your search “{{search}}”: {{url}}" },
  },
  "alerts.digest": {
    audience: "customer",
    label: "New homes for a saved search, daily or weekly (alerts)",
    variables: ["name", "search", "count", "homes", "period", "url"],
    email: {
      subject: "{{homes}} {{period}} for “{{search}}”",
      body: "Hello {{name}},\n\nHere is what came on the market {{period}} for your search “{{search}}”.",
      button: "View all matches",
    },
    whatsapp: { body: "{{homes}} {{period}} for “{{search}}”: {{url}}" },
  },
  "alerts.price_drop": {
    audience: "customer",
    label: "A saved or matching home dropped in price (alerts)",
    variables: ["name", "title", "price", "drop", "url"],
    email: {
      subject: "Price dropped by {{drop}}: {{title}}",
      body: "Hello {{name}},\n\n{{title}} is now {{price}}, {{drop}} less than before.",
      button: "See the home",
    },
    whatsapp: { body: "{{title}} dropped by {{drop}} to {{price}}: {{url}}" },
  },
  "alerts.status_change": {
    audience: "customer",
    label: "A saved home was reserved, sold or rented (alerts)",
    variables: ["name", "title", "status", "url"],
    email: {
      subject: "{{title}} is now {{status}}",
      body: "Hello {{name}},\n\nA home you saved, {{title}}, is now {{status}}. Similar homes are on its page.",
      button: "See the home",
    },
    whatsapp: { body: "A home you saved is now {{status}}: {{title}} {{url}}" },
  },
  "tools.roi_report": {
    audience: "customer",
    label: "Rental return report (ROI simulator)",
    variables: ["name", "agency", "agent", "summary", "days", "url"],
    email: {
      subject: "Your rental return report from {{agency}}",
      body: "Hello {{name}},\n\nHere is the report you asked for from our rental return simulator.\n\n{{summary}}\n\nThe download link works for {{days}} days. Want to talk it through? Reply to this email and {{agent}} will help.",
      button: "Download the report (PDF)",
    },
  },
  "newsletter.confirm": {
    audience: "customer",
    label: "Confirm a newsletter signup (double opt-in)",
    variables: ["agency", "confirmUrl", "unsubscribeUrl"],
    email: {
      subject: "Please confirm your subscription to {{agency}}",
      body: "Hello,\n\nSomeone (we hope you) asked to get news and new homes from {{agency}} by email. Please confirm with the button below.\n\nIf it wasn't you, ignore this email and nothing will be sent. To stop these emails for good: {{unsubscribeUrl}}",
      button: "Confirm my subscription",
    },
  },
  "system.integration_error": {
    audience: "internal",
    label: "An integration stopped working (to admins)",
    variables: ["integration", "error", "url"],
    email: {
      subject: "{{integration}} is not working",
      body: "{{integration}} answered with an error:\n\n{{error}}\n\nUntil it is fixed, what depends on it (emails, WhatsApp messages, maps, calendars or the assistant) may not go out. Check the key and test it again in Settings -> Integrations.",
      button: "Open Integrations",
    },
  },
  "system.rates_reminder": {
    audience: "internal",
    label: "Monthly reminder to update exchange rates (to admins)",
    variables: ["updated", "currencies", "url"],
    email: {
      subject: "Time to check the exchange rates",
      body: "Visitors can see prices in {{currencies}}. The display rates were last updated {{updated}}. Please check them in Settings -> Market so converted prices stay close to today's rates.",
      button: "Open Market settings",
    },
  },
  "account.deleted": {
    audience: "customer",
    label: "Account deleted (to the customer)",
    variables: ["agency", "url"],
    email: {
      subject: "Your {{agency}} account has been deleted",
      body: "Hello,\n\nAs you asked, your account with {{agency}} has been deleted, with your saved homes, lists and searches. What we keep about past inquiries and viewings no longer names you.\n\nIf you did not ask for this, reply to this email.",
      button: "Visit the website",
    },
  },
  "account.export_ready": {
    audience: "customer",
    label: "Your data download (to the customer)",
    variables: ["name", "agency", "url"],
    email: {
      subject: "Your data from {{agency}}",
      body: "Hello {{name}},\n\nYou downloaded a copy of your data from {{agency}}. You can download it again at any time from the privacy page of your account.\n\nIf this was not you, change your password and reply to this email.",
      button: "Open my privacy page",
    },
  },
} satisfies Record<string, TemplateDefault>;

/** Variables used in a text that the template does not offer (they would render empty). */
export function unknownVariables(text: string, allowed: readonly string[]): string[] {
  const used = [...text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);
  return [...new Set(used.filter((v) => !allowed.includes(v)))];
}

export type TemplateKey = keyof typeof templateDefaults;

export const isTemplateKey = (key: string): key is TemplateKey => key in templateDefaults;

export type TemplateVars = Record<string, string | number | null | undefined>;

/** Fills {{variables}}; missing values become empty and leftover spacing is tidied. */
export function fillTemplate(text: string, vars: TemplateVars): string {
  return text
    .replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => {
      const value = vars[name];
      return value === null || value === undefined ? "" : String(value);
    })
    .replace(/ · (?: · )+/g, " · ")
    .replace(/(?: · )+(?=\n|$)/g, "")
    .replace(/(^|\n)(?: · )+/g, "$1")
    .replace(/: · /g, ": ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
