import { expect, test } from "@playwright/test";
import { clearListings, db, deleteLocations, revalidateTags, setSettings } from "./helpers";

const AGENCY = process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";

const market = {
  baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
  visitorCurrencies: [
    {
      code: "USD",
      symbol: "$",
      symbolPosition: "before",
      decimals: 2,
      rate: 0.2723,
      isExample: true,
    },
  ],
};
const headerButton = { label: "List your property", href: "/list-your-property" };

test("cookie banner: first visit, necessary only, reopened from the footer", async ({
  browser,
}) => {
  // A fresh visitor: no cookie choice yet.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/sign-in");
  const banner = page.getByRole("region", { name: "Cookies" });
  await expect(banner).toBeVisible({ timeout: 60_000 });
  await banner.getByRole("button", { name: "Necessary only" }).click();
  await expect(banner).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  await expect(banner).toBeHidden();

  await page.getByRole("contentinfo").getByRole("button", { name: "Cookie settings" }).click();
  await expect(banner).toBeVisible();
  await banner.getByRole("checkbox", { name: "Analytics" }).check();
  await banner.getByRole("button", { name: "Save choices" }).click();
  await expect(banner).toBeHidden();
  const cookie = (await context.cookies()).find((c) => c.name === "propel_consent");
  expect(cookie?.value).toMatch(/^v1\.a1\.m0\.\d+$/);
  await context.close();
});

test("404: a search box and the agency's popular areas", async ({ page, request }) => {
  await clearListings();
  await deleteLocations(["e2e-popular-area"]);
  await db().query(
    `insert into locations (id, agency_id, level, name, slug, is_featured)
     values (gen_random_uuid(), $1, 'area', 'E2E Popular Area', 'e2e-popular-area', true)`,
    [AGENCY],
  );
  await revalidateTags(request, ["locations"]);

  // One segment could be a page-builder page (a soft 404); two segments match no route.
  const res = await page.goto("/no/such-page-e2e");
  expect(res?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "We couldn't find that page", level: 1 }),
  ).toBeVisible();
  const areas = page.getByRole("navigation", { name: "Popular areas" });
  await expect(areas.getByRole("link", { name: "E2E Popular Area" })).toHaveAttribute(
    "href",
    "/buy/e2e-popular-area",
  );
  await page.getByRole("searchbox", { name: "Search homes" }).fill("marina");
  await page.getByRole("main").getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/buy\?q=marina$/);
});

test("header: the primary button and the currency switcher come from settings", async ({
  page,
  request,
}) => {
  await setSettings(request, "general", { headerButton });
  await setSettings(request, "market", market);
  await page.goto("/sign-in");
  const header = page.getByRole("banner");
  await expect(header.getByRole("link", { name: "List your property" })).toHaveAttribute(
    "href",
    "/list-your-property",
  );
  await header.getByRole("button", { name: "Currency: AED" }).click();
  await page.getByRole("menuitemradio", { name: "USD · example rate" }).click();
  await expect(header.getByRole("button", { name: "Currency: USD" })).toBeVisible();
  // The button changes at once (optimistic); the cookie arrives with the action's answer.
  await expect
    .poll(
      async () => (await page.context().cookies()).find((c) => c.name === "propel_currency")?.value,
    )
    .toBe("USD");
});

test("phone: the menu holds the button and the currency choice @phone", async ({
  page,
  request,
  isMobile,
}) => {
  test.skip(!isMobile, "Phone layout only");
  await setSettings(request, "general", { headerButton });
  await setSettings(request, "market", market);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Open menu" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: "List your property" })).toBeVisible();
  await sheet.getByText("USD · example rate").click();
  await expect
    .poll(
      async () => (await page.context().cookies()).find((c) => c.name === "propel_currency")?.value,
    )
    .toBe("USD");
  await expect(sheet.getByRole("radio", { name: "USD · example rate" })).toBeChecked();
  // The sheet loads on the first open; closing it gives focus back to the menu button.
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
});
