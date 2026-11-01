/** Interface words of the page sections (content itself comes from the page builder). */
export const sectionsText = {
  search: {
    tabs: { buy: "Buy", rent: "Rent", off_plan: "Off-plan" },
    location: "Area, building or project",
    locationPlaceholder: "Where would you like to live?",
    type: "Type",
    anyType: "Any type",
    budget: "Budget",
    anyBudget: "Any budget",
    upTo: "Up to",
    beds: "Beds",
    anyBeds: "Any",
    studio: "Studio",
    submit: "Search",
  },
  listings: { viewAll: "View all" },
  areas: {
    forSale: (n: number) => `${n} for sale`,
    toRent: (n: number) => `${n} to rent`,
    noHomes: "New homes coming soon",
  },
  projects: { handover: "Handover", from: "from", progress: (n: number) => `${n}% built` },
  tools: {
    label: "Tools",
    items: {
      mortgage: {
        title: "Mortgage calculator",
        text: "Monthly payments, the deposit and what you can borrow.",
      },
      rental_returns: {
        title: "Rental returns",
        text: "Yield, cash flow and returns for an investment home.",
      },
      compare: { title: "Compare homes", text: "Up to four homes side by side." },
      valuation: { title: "Free valuation", text: "What your home could sell or rent for." },
      list_property: { title: "List your property", text: "Sell or rent it out with us." },
    },
  },
  aiTeaser: {
    prompts: "Example questions",
    previewLabel: "Example chat",
    ask: "Ask a question",
  },
} as const;
