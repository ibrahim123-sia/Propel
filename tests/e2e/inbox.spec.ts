import { expect, test } from "@playwright/test";
import { db, decidedCookies, setSettings, signInAsAdmin, snap, uniqueEmail } from "./helpers";

test.afterAll(async ({ request }) => {
  await setSettings(request, "ai", { webChat: { enabled: false, askContactFirst: true } });
});

test("website chat reaches the inbox; the team replies, hands back and takes over", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const email = uniqueEmail("chat");
  const name = `E2E Chat ${email.slice(5, 11)}`;
  await setSettings(request, "ai", { webChat: { enabled: true, askContactFirst: true } });

  // A visitor starts a chat from the home page.
  const visitorContext = await browser.newContext({ storageState: decidedCookies });
  const visitor = await visitorContext.newPage();
  await visitor.goto("/");
  await visitor.getByRole("button", { name: "AI Assistant" }).click();
  const chat = visitor.getByRole("dialog", { name: "Assistant" });
  await chat.getByRole("textbox", { name: "Name" }).fill(name);
  await chat.getByRole("textbox", { name: "Email" }).fill(email);
  await chat
    .getByRole("textbox", { name: "Your message" })
    .fill("Do you have three beds in the marina?");
  await chat.getByRole("button", { name: "Start the chat" }).click();
  await expect(chat.getByText("Do you have three beds in the marina?")).toBeVisible();
  await snap(visitor, "chat-panel");

  // The team sees it in the inbox, as a lead's conversation waiting for a person.
  await signInAsAdmin(page, request);
  await page.goto("/admin/inbox?status=needs_human");
  const list = page.getByRole("list", { name: "Conversations" });
  await list.getByRole("link", { name: new RegExp(name) }).click();
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByText("Do you have three beds in the marina?")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the lead" })).toBeVisible();

  await page
    .getByRole("textbox", { name: "Write a reply…" })
    .fill("Yes, two right now. Shall I send them?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messages.getByText("Yes, two right now. Shall I send them?")).toBeVisible();
  await snap(page, "inbox-conversation");

  // The visitor sees the reply at the next poll.
  await expect(chat.getByText("Yes, two right now. Shall I send them?")).toBeVisible({
    timeout: 20_000,
  });

  // Replying took the conversation over; hand it back, then take it over again.
  await page.getByRole("button", { name: "Hand back to the assistant" }).click();
  await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByRole("button", { name: "Hand back to the assistant" })).toBeVisible();

  const { rows } = await db().query(
    `select c.status, l.source, l.first_response_at is not null as answered
       from conversations c join leads l on l.id = c.lead_id join contacts ct on ct.id = c.contact_id
      where ct.email = $1`,
    [email],
  );
  expect(rows).toEqual([{ status: "human", source: "chat", answered: true }]);
  await visitorContext.close();
});
