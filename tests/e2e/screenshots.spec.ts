import { mkdirSync } from "node:fs";
import { devices, expect, test, type Page } from "@playwright/test";
import { db, seedDemo, setSettings, signInAsAdmin } from "./helpers";

/**
 * The README screenshots, taken from the demo agency on the production build:
 * `SCREENSHOTS=1 E2E_MODE=prod pnpm exec playwright test tests/e2e/screenshots.spec.ts`.
 * Written to .github/screenshots; skipped in normal runs.
 */

test.skip(!process.env.SCREENSHOTS, "Run with SCREENSHOTS=1 to refresh the README screenshots");
test.describe.configure({ mode: "serial" });

const DIR = ".github/screenshots";
const desktop = { width: 1440, height: 900 };

async function shot(page: Page, name: string) {
  // Let lazy images and the map settle.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${DIR}/${name}.jpg`, type: "jpeg", quality: 82 });
}

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
  mkdirSync(DIR, { recursive: true });
  await seedDemo(request);
});

test.afterAll(async ({ request }) => {
  await setSettings(request, "integrations", aiIntegration(false));
});

test("public site", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await page.setViewportSize(desktop);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "home");

  await page.goto("/buy");
  await expect(page.locator(".maplibregl-canvas").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "search");

  const { rows } = await db().query(
    `select slug from properties where status = 'available' and deleted_at is null
      order by reference limit 1`,
  );
  const slug = (rows[0] as { slug: string }).slug;
  await page.goto(`/property/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(page, "property");

  const phone = await browser.newContext({
    ...devices["Pixel 7"],
    storageState: {
      cookies: [
        {
          name: "propel_consent",
          value: "v1.a0.m0.1760000000",
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });
  const mobile = await phone.newPage();
  await mobile.goto(`${new URL(page.url()).origin}/property/${slug}`);
  await expect(mobile.getByRole("heading", { level: 1 })).toBeVisible();
  await shot(mobile, "property-phone");
  await phone.close();
});

test("admin", async ({ page, request }) => {
  test.setTimeout(300_000);
  await setSettings(request, "integrations", aiIntegration(true));
  await page.setViewportSize(desktop);
  await signInAsAdmin(page, request);
  await shot(page, "admin-dashboard");

  const { rows } = await db().query(
    `select id, reference from properties where status = 'available' and deleted_at is null
      order by reference limit 1`,
  );
  const listing = rows[0] as { id: string; reference: string };
  await page.goto(`/admin/properties/${listing.id}`);
  await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
  await shot(page, "admin-property-editor");

  await page.goto("/admin");
  const input = page.getByRole("textbox", { name: "Ask anything about your agency…" });
  await input.fill(`What is the status of ${listing.reference}?`);
  await input.press("Enter");
  const panel = page.getByRole("dialog", { name: "Assistant" });
  await expect(panel.getByText(new RegExp(`${listing.reference} ·`))).toBeVisible({
    timeout: 60_000,
  });
  await shot(page, "admin-assistant");
});
