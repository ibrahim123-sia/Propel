import { expect, test } from "@playwright/test";
import { db, seedDemo, setSettings, signInAsAdmin } from "./helpers";

/**
 * AI writing helpers in the editors (10 §5) with the built-in test provider: suggestions land
 * in the editor (nothing is saved until the admin saves), drafts open in their editor.
 */

test.describe.configure({ mode: "serial" });

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
  await setSettings(request, "integrations", aiIntegration(false));
});

test("listing editor: AI description, titles and SEO; blog: a draft from a brief", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await setSettings(request, "integrations", aiIntegration(true));
  const { rows } = await db().query(
    `select id, title from properties where status = 'available' and deleted_at is null order by reference limit 1`,
  );
  const listing = rows[0] as { id: string; title: string };
  await signInAsAdmin(page, request);
  await page.goto(`/admin/properties/${listing.id}`);

  await page.getByRole("button", { name: "Write with AI" }).click();
  await expect(page.getByText("[add detail", { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Undo AI draft" }).click();
  await expect(page.getByRole("button", { name: "Undo AI draft" })).toHaveCount(0);

  await page.getByRole("button", { name: "Suggest titles" }).click();
  const title = page.getByRole("textbox", { name: "Title", exact: true });
  const firstIdea = page.getByRole("group", { name: "Title ideas" }).getByRole("button").first();
  await expect(firstIdea).toBeVisible({ timeout: 30_000 });
  const idea = (await firstIdea.textContent())!.trim();
  await firstIdea.click();
  await expect(title).toHaveValue(idea);

  await page.getByRole("button", { name: "Suggest title and description" }).click();
  const options = page.getByRole("list", { name: "Suggestions" });
  await expect(options).toBeVisible({ timeout: 30_000 });
  await options.getByRole("button").first().click();
  await expect(page.getByRole("textbox", { name: "SEO title" })).not.toHaveValue("");

  await page.goto("/admin/website/blog");
  await page.getByRole("button", { name: "Draft with AI" }).click();
  await page
    .getByRole("textbox", { name: "Brief" })
    .fill("Moving to Dubai Hills with children: schools and parks");
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/admin\/website\/blog\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const posts = await db().query(
    "select status, is_ai_drafted from posts order by created_at desc limit 1",
  );
  expect(posts.rows[0]).toMatchObject({ status: "draft", is_ai_drafted: true });

  // The post's SEO panel offers the same suggestions.
  await page.getByRole("button", { name: "Suggest title and description" }).click();
  const postOptions = page.getByRole("list", { name: "Suggestions" });
  await expect(postOptions).toBeVisible({ timeout: 30_000 });
  await postOptions.getByRole("button").first().click();
  await expect(page.getByRole("textbox", { name: "SEO title" })).not.toHaveValue("");
});
