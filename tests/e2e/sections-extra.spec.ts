import { expect, test } from "@playwright/test";
import { db, revalidateTags, setSettings } from "./helpers";

const AGENCY = process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";

/**
 * 06 §2-3 additions: the Tools section, the AI assistant teaser whose chips open the chat
 * with the question typed in, and a page that hides the chat button.
 */
test.afterAll(async ({ request }) => {
  await db().query("delete from pages where slug in ('e2e-tools-teaser', 'e2e-no-chat')");
  await setSettings(request, "ai", { webChat: { enabled: false, askContactFirst: true } });
});

test("tools cards, the teaser's question chips open the chat, and a page without the chat", async ({
  page,
  request,
}) => {
  await setSettings(request, "ai", { webChat: { enabled: true, askContactFirst: true } });
  const style = {
    background: "white",
    spacing: "normal",
    width: "contained",
    anchor: "",
    hideOn: "none",
  };
  const sections = [
    {
      id: "tools1",
      type: "tools",
      props: { eyebrow: "", heading: "Plan your move", tools: ["mortgage", "valuation"] },
      style,
    },
    {
      id: "teaser1",
      type: "ai_teaser",
      props: {
        eyebrow: "",
        heading: "Ask our assistant",
        text: "Answers from our own listings, day and night.",
        prompts: ["Two beds near the beach?", "What does a villa cost?"],
      },
      style,
    },
  ];
  await db().query(
    `insert into pages (id, agency_id, title, slug, status, template, sections, hide_chat) values
       (gen_random_uuid(), $1, 'E2E tools', 'e2e-tools-teaser', 'published', 'default', $2::jsonb, false),
       (gen_random_uuid(), $1, 'E2E no chat', 'e2e-no-chat', 'published', 'default', $3::jsonb, true)`,
    [AGENCY, JSON.stringify(sections), JSON.stringify(sections.slice(0, 1))],
  );
  await revalidateTags(request, ["pages"]);

  await page.goto("/e2e-tools-teaser");
  const tools = page.getByRole("region", { name: "Plan your move" });
  await expect(tools.getByRole("link", { name: /Mortgage calculator/ })).toHaveAttribute(
    "href",
    "/tools/mortgage",
  );
  await expect(tools.getByRole("link", { name: /Free valuation/ })).toHaveAttribute(
    "href",
    "/valuation",
  );
  await expect(tools.getByRole("link")).toHaveCount(2);

  const chips = page.getByRole("list", { name: "Example questions" });
  await chips.getByRole("button", { name: "What does a villa cost?" }).click();
  const chat = page.getByRole("dialog");
  await expect(chat.getByLabel("Your message")).toHaveValue("What does a villa cost?");
  await expect(page.getByRole("button", { name: /^Chat/ })).toHaveCount(0);

  // The page that hides the chat: no button, and it comes back on the next page.
  await page.goto("/e2e-no-chat");
  await expect(page.getByRole("region", { name: "Plan your move" })).toBeVisible();
  await expect(
    page.locator("button[aria-haspopup='dialog']").filter({ hasText: /chat/i }),
  ).toHaveCount(0);
  await page.goto("/e2e-tools-teaser");
  await expect(
    page.locator("button[aria-haspopup='dialog']").filter({ hasText: /chat/i }),
  ).toHaveCount(1);
});
