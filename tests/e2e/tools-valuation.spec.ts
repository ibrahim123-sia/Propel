import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { clearLeads, clearListings, db, setSettings, snap } from "./helpers";

const AGENCY = process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";
const SQFT = 0.09290304;

/** One area with four 2-bed apartments for sale (AED 2,000-2,300 per sq ft). */
async function seedArea(request: APIRequestContext) {
  await clearLeads();
  await clearListings();
  await setSettings(request, "market", {
    baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
    areaUnit: "sqft",
    rentPeriod: "year",
    phoneCountryCode: "+971",
  });
  await setSettings(request, "contact", { email: "hello@propel.example" });
  await setSettings(request, "leads", { assignmentRule: "area_match" });
  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;
  const suffix = Math.floor(Math.random() * 1e6);
  const [type] = await q(
    `insert into property_types (id, agency_id, name, slug) values (gen_random_uuid(), $1, 'E2E VT Apartment', 'e2e-vt-apartments-${suffix}') returning id`,
    [AGENCY],
  );
  const [city] = await q(
    `insert into locations (id, agency_id, level, name, slug) values (gen_random_uuid(), $1, 'city', 'E2E VT City', 'e2e-vt-city-${suffix}') returning id`,
    [AGENCY],
  );
  const [area] = await q(
    `insert into locations (id, agency_id, parent_id, level, name, slug) values (gen_random_uuid(), $1, $2, 'area', 'E2E VT Marina', 'e2e-vt-marina-${suffix}') returning id`,
    [AGENCY, city.id],
  );
  await q(`delete from agents where slug = 'e2e-vt-agent'`);
  await q(
    `insert into agents (id, agency_id, name, slug, email, areas) values (gen_random_uuid(), $1, 'Noor Propel', 'e2e-vt-agent', 'noor@propel.example', array[$2::uuid])`,
    [AGENCY, area.id],
  );
  for (const [i, perSqft] of [2000, 2100, 2200, 2300].entries())
    await q(
      `insert into properties (id, agency_id, reference, title, slug, purpose, status, property_type_id, location_id,
         price, currency, beds, baths, size, published_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'sale', 'available', $5, $6, $7, 'AED', 2, 2, $8, now() - interval '10 days')`,
      [
        AGENCY,
        `VT-${suffix}-${i}`,
        `E2E VT two-bed ${i + 1}`,
        `e2e-vt-two-bed-${suffix}-${i}`,
        type.id,
        area.id,
        1200 * perSqft * 100,
        1200 * SQFT,
      ],
    );
}

/** Steps 1-4 of both forms: sell or rent, the area, the home, no photos. */
async function fillHome(page: Page, purpose: "Sell" | "Rent out") {
  await page.getByText(purpose, { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Location" })).toBeFocused();
  await page.getByRole("combobox", { name: "Area" }).selectOption({ label: "— E2E VT Marina" });
  await page.getByRole("button", { name: "Continue" }).click();
  // The home: the size is checked before moving on.
  await page.getByRole("combobox", { name: "Type of home" }).selectOption({
    label: "E2E VT Apartment",
  });
  await page.getByRole("combobox", { name: "Bedrooms" }).selectOption("2");
  await page.getByRole("combobox", { name: "Bathrooms" }).selectOption("2");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Enter the size")).toBeVisible();
  await page.getByRole("textbox", { name: "Size (sq ft)" }).fill("1200");
  await page.getByText("Good", { exact: true }).click();
}

test("valuation: the steps end on a range from comparable homes", async ({ page, request }) => {
  test.setTimeout(240_000);
  await seedArea(request);
  // The first route of a cold dev server compiles first.
  await page.goto("/valuation", { timeout: 200_000 });
  await expect(page.getByRole("heading", { name: "Free valuation", level: 1 })).toBeVisible();
  await fillHome(page, "Sell");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Photos" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Rana Owner");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill("rana@propel.example");
  await page.getByRole("button", { name: "Get my estimate" }).click();
  await expect(page.getByText("Please agree so we can contact you.")).toBeVisible();
  await page.getByRole("checkbox", { name: "I agree to be contacted about my request." }).check();
  await page.getByRole("button", { name: "Get my estimate" }).click();

  // Quartiles 2,075 / 2,225 AED per sq ft × 1,200 sq ft.
  await expect(page.getByTestId("estimate-range")).toHaveText("AED 2,490,000 – AED 2,670,000");
  await expect(page.getByText("Based on 4 similar homes in E2E VT Marina")).toBeVisible();
  await expect(page.getByText("An agent will refine this within 24 hours.")).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E VT two-bed 1" })).toBeVisible();
  await snap(page, "valuation-result");
  const rows = (await db().query("select ai_range_min, ai_range_max from valuation_requests")).rows;
  expect(rows).toEqual([{ ai_range_min: "249000000", ai_range_max: "267000000" }]);
});

