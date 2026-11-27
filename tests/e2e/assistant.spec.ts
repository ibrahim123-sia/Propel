import { expect, test } from "@playwright/test";
import { db, decidedCookies, seedDemo, setSettings, snap } from "./helpers";

/**
 * The website assistant (10 §2) with the built-in test provider: it answers in the chat with
 * listing cards (live prices), and the visitor can hand over to a person at any time.
 */

test.describe.configure({ mode: "serial" });

/** Settings -> Integrations -> AI as a whole (the settings helper merges top-level keys only). */
const aiIntegration = (enabled: boolean) => ({
  ai: {
    enabled,
    provider: "mock",
    chatModel: "claude-sonnet-5-5",
    fastModel: "claude-haiku-5-5",
    gatewayAccountId: "",
    gatewayName: "",
    embeddingProvider: "mock",
    embeddingModel: "@cf/baai/bge-m3",
  },
});

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000);
  await seedDemo(request);
});

test.afterAll(async ({ request }) => {
  await setSettings(request, "ai", { webChat: { enabled: false, askContactFirst: true } });
  await setSettings(request, "integrations", aiIntegration(false));
});

test("the assistant answers with listing cards, then hands over to a person", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  await setSettings(request, "integrations", aiIntegration(true));
  await setSettings(request, "ai", { webChat: { enabled: true, askContactFirst: false } });

  const context = await browser.newContext({ storageState: decidedCookies });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "AI Assistant" }).click();
  const chat = page.getByRole("dialog", { name: "Assistant" });
  await chat
    .getByRole("textbox", { name: "Your message" })
    .fill("Do you have a two-bed apartment with a sea view?");
  await chat.getByRole("button", { name: "Start the chat" }).click();

  // The answer shows the homes as cards in a sideways row: photo, live price, Open, Book tour.
  const cards = chat.getByRole("list", { name: "Homes" });
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const card = cards.first().getByRole("listitem").first();
  await expect(card).toContainText("AED");
  const open = card.getByRole("link", { name: "Open" });
  await expect(open).toHaveAttribute("href", /^\/property\/[a-z0-9-]+$/);
  const tour = card.getByRole("link", { name: "Book tour" });
  await expect(tour).toHaveAttribute("href", /^\/property\/[a-z0-9-]+\?tour=1$/);
  const tourHref = (await tour.getAttribute("href"))!;
  await snap(page, "assistant-cards");

  await chat.getByRole("button", { name: "Talk to a person" }).click();
  await expect(chat.getByText(/to reply to you here/)).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByRole("button", { name: "Talk to a person" })).toHaveCount(0);

  const { rows } = await db().query(
    `select c.status, (select count(*)::int from messages m where m.conversation_id = c.id and m.sender = 'ai') as ai
       from conversations c order by c.created_at desc limit 1`,
  );
  expect(rows[0]).toMatchObject({ status: "needs_human" });
  expect(rows[0].ai).toBeGreaterThan(0);

  // "Book tour" on a card opens the listing with its booking already open.
  await page.goto(tourHref);
  await expect(page.getByRole("dialog", { name: "Book a tour" })).toBeVisible({ timeout: 20_000 });
  await expect(page).not.toHaveURL(/tour=1/);
  await context.close();
});
