/**
 * Interface words around page builder content (08 §1): templates, the preview banner and
 * the section types. The content itself (headings, text, buttons) comes from the pages.
 */
export const cms = {
  legal: {
    lastUpdated: "Last updated {date}",
    onThisPage: "On this page",
  },
  preview: {
    banner: "Preview: this version of the page is not published.",
    expires: "The link works until {date}.",
    expiredTitle: "This preview link has expired",
    expiredText: "Preview links work for 7 days. Ask for a new link.",
    status: { draft: "Draft", published: "Published", scheduled: "Scheduled" },
  },
  landing: {
    call: "Call",
    whatsapp: "WhatsApp",
  },
  sections: {
    nothingYet: "Nothing to show yet",
    viewAll: "View all",
  },
  testimonials: {
    rating: "{n} out of 5",
    previous: "Previous testimonial",
    next: "Next testimonial",
  },
  team: {
    viewProfile: "View profile",
    languages: "Speaks {languages}",
  },
  posts: {
    minutes: "{n} min read",
  },
  video: {
    play: "Play video",
  },
  gallery: {
    open: "Open image {n} of {count}",
    close: "Close",
    previous: "Previous image",
    next: "Next image",
  },
  map: {
    label: "Map",
    office: "Our office",
  },
  forms: {
    name: "Name",
    email: "Email",
    phone: "Phone",
    preferredTime: "When should we call?",
    purpose: "To sell or to rent out?",
    purposes: { sale: "Sell", rent: "Rent out" },
    area: "Where is the property?",
    propertyType: "Type",
    any: "Choose",
    beds: "Bedrooms",
    expectedPrice: "Price you have in mind (optional)",
    message: "Message",
    messageOptional: "Anything else we should know? (optional)",
    consent: "I agree to be contacted about my request.",
    consentNewsletter: "Send me the newsletter. I can unsubscribe at any time.",
    consentRequired: "Please agree so we can contact you.",
    sending: "Sending…",
    send: {
      contact: "Send message",
      callback: "Call me back",
      newsletter: "Subscribe",
    },
    success: {
      contact: "Thank you. We have your message and will reply by phone, WhatsApp or email.",
      callback: "Thank you. We'll call you back on the number you gave.",
      newsletter: "Thank you. Check your inbox and confirm with the link we sent.",
    },
  },
  contact: {
    phone: "Phone",
    whatsapp: "WhatsApp",
    email: "Email",
    address: "Office",
    hours: "Opening hours",
    directions: "Get directions",
  },
} as const;
