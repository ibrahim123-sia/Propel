import { doc } from "../doc";
import type { SeedPagesCopy } from "../pages";

/**
 * Page builder pages of the Haven & Dune demo (08 §1 "Seed pages"). Image ids are filled in by
 * the seed ("$living" is one of the drawn living-room pictures). Figures and policies are
 * samples for the demo, and say so.
 */
/** The demo policies as a text section; other presets reuse them with their agency's name. */
export function legalText(kind: "privacy" | "terms" | "cookies", agency = "Haven & Dune") {
  const sample = {
    p: `This is sample text for the ${agency} demo, not legal advice. Replace it with your own policy, checked by your lawyer, before you go live.`,
  };
  const blocks: Record<typeof kind, Array<{ h?: string; p?: string; list?: string[] }>> = {
    privacy: [
      sample,
      { h: "Who we are" },
      {
        p: `${agency} (demo) is the company responsible for the personal data you share on this website. You can reach us through the contact page.`,
      },
      { h: "What we collect" },
      {
        list: [
          "What you send us in a form: your name, email, phone and message.",
          "Your account details if you sign up, and the homes and searches you save.",
          "With your permission, how you use the site (analytics) and which adverts brought you here (marketing).",
        ],
      },
      { h: "How we use it" },
      {
        p: "To answer you, arrange viewings, send the alerts you asked for and improve the site. We never sell your data.",
      },
      { h: "How long we keep it" },
      {
        p: "Messages and enquiries for as long as we need them to help you, then they are deleted or anonymised. Account data until you delete your account.",
      },
      { h: "Your rights" },
      {
        p: "You can ask for a copy of your data, ask us to correct or delete it, and withdraw your consent at any time. Signed-in customers can export and delete their data from their account.",
      },
    ],
    terms: [
      sample,
      { h: "Using this site" },
      {
        p: "The listings, prices and plans on this site are given in good faith and checked as described on each listing, but they can change. Always confirm the details with us before you make a decision.",
      },
      { h: "Prices and currencies" },
      {
        p: "Prices in other currencies are converted with sample rates and are approximate. The listed price in the original currency is the one that counts.",
      },
      { h: "Your account" },
      {
        p: "Keep your password safe. We may close an account that is used to send spam or to copy our listings.",
      },
      { h: "Liability" },
      {
        p: "We are not liable for decisions made only on the information on this site. Nothing in these terms limits rights you have by law.",
      },
    ],
    cookies: [
      sample,
      { h: "Necessary cookies" },
      {
        p: "These keep you signed in, remember your currency and cookie choices, and protect the forms from spam. They are always on.",
      },
      { h: "Analytics cookies" },
      {
        p: "With your permission, these count visits and show us which pages help people most. The data is not used to identify you.",
      },
      { h: "Marketing cookies" },
      {
        p: "With your permission, these tell advertising platforms that you visited, so we can measure our adverts.",
      },
      { h: "Changing your choice" },
      {
        p: "Use the “Cookie settings” link at the bottom of every page to change your choice at any time.",
      },
    ],
  };
  return {
    type: "text" as const,
    props: { maxWidth: "normal", body: doc(blocks[kind]) },
  };
}

export const havenDunePages: SeedPagesCopy = {
  home: [
    {
      type: "testimonials",
      props: {
        eyebrow: "Reviews",
        heading: "What our clients say",
        source: "latest",
        count: 3,
        layout: "grid",
      },
      style: { background: "white" },
    },
    {
      type: "blog_posts",
      props: {
        eyebrow: "Insights",
        heading: "From our blog",
        source: "latest",
        count: 3,
        viewAll: { label: "All articles", href: "/insights" },
      },
      style: { background: "sand" },
    },
    {
      type: "faq",
      props: {
        eyebrow: "Questions",
        heading: "Buying in Dubai: the short answers",
        source: "group",
        group: "buying",
        count: 6,
      },
      style: { background: "white" },
    },
  ],
  pages: [
    {
      title: "About us",
      slug: "about",
      template: "default",
      seoTitle: "About Haven & Dune",
      seoDescription:
        "A small Dubai agency that visits every home it lists, explains every payment plan and answers on WhatsApp.",
      sections: [
        {
          type: "hero_simple",
          props: {
            heading: "A small team that visits every home",
            subheading:
              "Haven & Dune helps people buy, rent and invest in Dubai. We only list homes we have seen for ourselves.",
            buttons: [
              { label: "Meet the team", href: "#team" },
              { label: "Contact us", href: "/contact" },
            ],
          },
          style: { background: "sand" },
        },
        {
          type: "text_image",
          props: {
            eyebrow: "How we work",
            heading: "Checked in person, explained in plain words",
            body: doc([
              {
                p: "Before a home goes on our site, one of us walks through it, checks the photos match and notes what the building is like on a weekday evening. Each listing shows when it was last checked.",
              },
              {
                p: "We measure the real travel times to schools, beaches and the metro, and we show off-plan payment plans step by step, so you can compare homes without a spreadsheet.",
              },
            ]),
            imageId: "$living",
            imageSide: "right",
            imageShape: "portrait",
          },
        },
        {
          type: "stats",
          props: {
            heading: "In numbers",
            items: [
              { value: "1,200+", label: "homes visited", source: "Sample figure for the demo" },
              { value: "14", label: "areas covered", source: "Sample figure for the demo" },
              {
                value: "9 min",
                label: "average WhatsApp reply",
                source: "Sample figure for the demo",
              },
            ],
          },
          style: { background: "soft", spacing: "compact" },
        },
        {
          type: "team",
          props: { eyebrow: "The team", heading: "People you will meet", source: "all", count: 8 },
          style: { anchor: "team" },
        },
        {
          type: "testimonials",
          props: { heading: "What clients say", source: "latest", count: 1, layout: "quote" },
          style: { background: "sand" },
        },
        {
          type: "cta",
          props: {
            heading: "Thinking of moving?",
            text: "Tell us what you are looking for and we will send homes that fit, with honest notes on each one.",
            buttons: [
              { label: "Search homes", href: "/buy" },
              { label: "Talk to us", href: "/contact" },
            ],
          },
          style: { background: "ink" },
        },
      ],
    },
    {
      title: "Contact",
      slug: "contact",
      template: "default",
      seoTitle: "Contact Haven & Dune",
      seoDescription:
        "Call, message us on WhatsApp or visit our office. A consultant replies within one working day.",
      sections: [
        {
          type: "hero_simple",
          props: {
            heading: "Talk to us",
            subheading:
              "Call, message us on WhatsApp or send the form below: a consultant replies within one working day.",
          },
          style: { background: "sand", spacing: "compact" },
        },
        {
          type: "contact_block",
          props: {
            heading: "Our office",
            text: "Drop in for a coffee and a chat about the areas you are considering. Viewings are by appointment.",
            showDetails: true,
            showMap: true,
            showForm: true,
            formHeading: "Send us a message",
          },
          style: { background: "white", spacing: "compact" },
        },
      ],
    },
    {
      title: "Off-plan guide",
      slug: "off-plan-guide",
      template: "default",
      seoTitle: "Buying off-plan in Dubai: a step-by-step guide",
      seoDescription:
        "How off-plan payment plans work, what to check before you book and what happens at handover.",
      sections: [
        {
          type: "hero_simple",
          props: {
            heading: "Buying off-plan in Dubai, step by step",
            subheading:
              "What a payment plan really costs, what to check before you book a unit and what happens at handover.",
            buttons: [{ label: "See projects", href: "/projects" }],
          },
          style: { background: "sand" },
        },
        {
          type: "text",
          props: {
            maxWidth: "normal",
            body: doc([
              { h: "How payment plans work" },
              {
                p: "You pay a booking amount, then instalments while the building goes up, then the rest at handover or over a few years after it. Each project page shows every step with its amount, so you can see what you pay and when.",
              },
              { h: "What to check before you book" },
              {
                list: [
                  "The developer's record: earlier projects, and whether they were handed over on time.",
                  "The escrow account and the project's registration.",
                  "What is included: finishes, appliances, parking and service charges.",
                  "What happens if handover is late, and what you can do about it.",
                ],
              },
              { h: "Handover" },
              {
                p: "Before handover you inspect the unit with a snagging list. Anything that is not right is fixed before you take the keys. We come with you if you like.",
              },
            ]),
          },
        },
        {
          type: "projects_showcase",
          props: {
            eyebrow: "Off-plan",
            heading: "Projects we know well",
            source: "featured",
            count: 4,
            dark: true,
            viewAll: { label: "All projects", href: "/projects" },
          },
        },
        {
          type: "faq",
          props: { heading: "Off-plan questions", source: "group", group: "off_plan", count: 8 },
        },
        {
          type: "cta",
          props: {
            heading: "Not sure which plan suits you?",
            text: "We compare plans side by side with you, including what you pay after handover.",
            buttons: [{ label: "Talk to an off-plan consultant", href: "/contact" }],
          },
          style: { background: "ink" },
        },
      ],
    },
    {
      title: "How we verify listings",
      slug: "how-we-verify",
      template: "legal",
      legal: "verify",
      seoDescription: "What the “Verified in person” badge means and how often we check each home.",
      sections: [
        {
          type: "text",
          props: {
            maxWidth: "normal",
            body: doc([
              {
                p: "A listing with the “Verified in person” badge was visited by one of our consultants. The badge shows the date of the last visit, and it goes away when a check is more than 30 days old.",
              },
              { h: "What we check" },
              {
                list: [
                  "The home exists, is available and matches the photos.",
                  "The number of bedrooms and bathrooms, and the size we publish.",
                  "The view, the noise and the state of the building's common areas.",
                ],
              },
              { h: "What we do not check" },
              {
                p: "We do not survey the structure or test the appliances. For that, ask for an inspection before you buy or rent.",
              },
            ]),
          },
        },
      ],
    },
    {
      title: "Privacy policy",
      slug: "privacy-policy",
      template: "legal",
      legal: "privacy",
      seoDescription:
        "How this demo agency handles personal data. Sample text: replace it with your own.",
      sections: [legalText("privacy")],
    },
    {
      title: "Terms of use",
      slug: "terms",
      template: "legal",
      legal: "terms",
      seoDescription:
        "The terms for using this demo website. Sample text: replace it with your own.",
      sections: [legalText("terms")],
    },
    {
      title: "Cookie policy",
      slug: "cookie-policy",
      template: "legal",
      legal: "cookies",
      seoDescription: "The cookies this demo website uses and how to change your choice.",
      sections: [legalText("cookies")],
    },
  ],
};
