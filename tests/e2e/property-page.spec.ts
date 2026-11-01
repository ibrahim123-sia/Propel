import { expect, test, type APIRequestContext } from "@playwright/test";
import { clearListings, db, setSettings, snap } from "./helpers";

const AGENCY = process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";

/** A live listing with photos, a floor plan, facilities, nearby places and a price change. */
async function seedListing(request: APIRequestContext) {
  await clearListings();
  await db().query("delete from pois where name = 'Harbour Academy'");
  await db().query("delete from poi_types where name = 'E2E PP School'");
  await db().query("delete from agents where slug = 'e2e-pp-agent'");
  await db().query("delete from facilities where name = 'E2E PP Pool'");
  await setSettings(request, "market", {
    baseCurrency: { code: "AED", symbol: "AED", symbolPosition: "before", decimals: 2 },
    areaUnit: "sqft",
    distanceUnit: "km",
    phoneCountryCode: "+971",
  });
  await setSettings(request, "contact", {
    email: "hello@agency.example",
    whatsapp: "+97140000000",
  });
  // Another spec switches assignment to round robin: the listing's agent answers here.
  await setSettings(request, "leads", { assignmentRule: "listing_agent" });
  const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;
  const suffix = Math.floor(Math.random() * 1e6);
  const [type] = await q(
    `insert into property_types (id, agency_id, name, slug) values (gen_random_uuid(), $1, 'E2E PP Apartment', 'e2e-pp-apartments-${suffix}') returning id`,
    [AGENCY],
  );
  const [city] = await q(
    `insert into locations (id, agency_id, level, name, slug) values (gen_random_uuid(), $1, 'city', 'E2E PP City', 'e2e-pp-city-${suffix}') returning id`,
    [AGENCY],
  );
  const [area] = await q(
    `insert into locations (id, agency_id, parent_id, level, name, slug) values (gen_random_uuid(), $1, $2, 'area', 'E2E PP Marina', 'e2e-pp-marina-${suffix}') returning id`,
    [AGENCY, city.id],
  );
  const [agent] = await q(
    `insert into agents (id, agency_id, name, slug, email, whatsapp, phone, languages)
     values (gen_random_uuid(), $1, 'Layla Haddad', 'e2e-pp-agent', 'layla@agency.example', '+971501112233', '+971501112233', '{English,Arabic}') returning id`,
    [AGENCY],
  );
  // The desktop and @phone runs share these files: replace the earlier copies.
  await q(`delete from media where r2_key like '2026/10/e2epp%'`);
  const photos = await q(
    `insert into media (id, agency_id, r2_key, file_name, mime, status, alt) values
       (gen_random_uuid(), $1, '2026/10/e2epp00001/living.jpg', 'living.jpg', 'image/jpeg', 'ready', 'Living room'),
       (gen_random_uuid(), $1, '2026/10/e2epp00002/kitchen.jpg', 'kitchen.jpg', 'image/jpeg', 'ready', 'Kitchen'),
       (gen_random_uuid(), $1, '2026/10/e2epp00003/plan.png', 'plan.png', 'image/png', 'ready', 'Floor plan')
     returning id`,
    [AGENCY],
  );
  const [facility] = await q(
    `insert into facilities (id, agency_id, name, icon) values (gen_random_uuid(), $1, 'E2E PP Pool', 'waves') returning id`,
    [AGENCY],
  );
  const [listing] = await q(
    `insert into properties (id, agency_id, reference, title, slug, purpose, status, property_type_id, location_id, agent_id,
       point, map_pin_exact, price, currency, beds, baths, size, description_html, highlights, published_at, original_price, unit_number)
     values (gen_random_uuid(), $1, 'HD-E2E1', 'Marina view apartment', 'e2e-marina-view-${suffix}', 'sale', 'available', $2, $3, $4,
       ST_SetSRID(ST_MakePoint(55.1403, 25.0805), 4326), false, 230000000, 'AED', 2, 2, 111.48,
       '<p>Bright corner apartment with a view of the water.</p>', '{"Sea view","Walk to the metro"}', now() - interval '20 days', 245000000, 'SECRET-2304')
     returning id, slug`,
    [AGENCY, type.id, area.id, agent.id],
  );
  await q(
    `insert into property_media (id, agency_id, property_id, media_id, kind, sort_order, is_cover) values
       (gen_random_uuid(), $1, $2, $3, 'photo', 0, true),
       (gen_random_uuid(), $1, $2, $4, 'photo', 1, false),
       (gen_random_uuid(), $1, $2, $5, 'floor_plan', 0, false)`,
    [AGENCY, listing.id, photos[0].id, photos[1].id, photos[2].id],
  );
  await q(`insert into property_facilities (property_id, facility_id) values ($1, $2)`, [
    listing.id,
    facility.id,
  ]);
  await q(
    `insert into price_history (id, agency_id, property_id, old_price, new_price, currency, changed_at)
     values (gen_random_uuid(), $1, $2, 245000000, 230000000, 'AED', now() - interval '5 days')`,
    [AGENCY, listing.id],
  );
  const [poiType] = await q(
    `insert into poi_types (id, agency_id, name, icon, category, show_on_property, travel_mode)
     values (gen_random_uuid(), $1, 'E2E PP School', 'school', 'schools', true, 'drive') returning id`,
    [AGENCY],
  );
  const [poi] = await q(
    `insert into pois (id, agency_id, poi_type_id, name, point) values (gen_random_uuid(), $1, $2, 'Harbour Academy', ST_SetSRID(ST_MakePoint(55.145, 25.085), 4326)) returning id`,
    [AGENCY, poiType.id],
  );
  await q(
    `insert into property_pois (id, agency_id, property_id, poi_id, straight_distance_m, drive_seconds)
     values (gen_random_uuid(), $1, $2, $3, 820, 360)`,
    [AGENCY, listing.id, poi.id],
  );
  return { slug: listing.slug as string };
}

test("property page: blocks, gallery viewer and an inquiry that reaches the agent", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "desktop layout");
  test.setTimeout(240_000);
  const { slug } = await seedListing(request);
  await page.goto(`/property/${slug}`);

  await expect(
    page.getByRole("heading", { name: "Marina view apartment", level: 1 }),
  ).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("link", { name: "E2E PP Marina" })).toHaveAttribute(
    "href",
    /^\/buy\/e2e-pp-marina-/,
  );
  await expect(page.getByText("SECRET-2304")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "About this home" })).toContainText(
    "Bright corner apartment",
  );
  await expect(page.getByRole("region", { name: "Details" })).toContainText("HD-E2E1");
  await expect(page.getByRole("region", { name: "Facilities" })).toContainText("E2E PP Pool");
  const nearby = page.getByRole("region", { name: "Location and nearby" });
  await expect(nearby).toContainText("Harbour Academy");
  await expect(nearby).toContainText("820 m · 6 min drive");
  await expect(nearby).toContainText("The exact location is shared when you book a viewing.");
  await expect(page.getByRole("region", { name: "Price history" })).toContainText(
    "Reduced by 6.1%",
  );
  await snap(page, "property-page");

  // Gallery viewer: opens at the first photo, arrows move, Esc closes.
  await page.getByRole("button", { name: "All photos (2)", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Photos of Marina view apartment" });
  await expect(viewer.getByText("1 of 2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(viewer.getByText("2 of 2")).toBeVisible();
  await viewer.getByRole("tab", { name: "Floor plans" }).click();
  await expect(viewer.getByText("1 of 1")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // WhatsApp carries the reference and the page address.
  const card = page.getByRole("complementary", { name: "Ask about this home" });
  const whatsapp = card.getByRole("link", { name: "WhatsApp" });
  await expect(whatsapp).toHaveAttribute("href", /^https:\/\/wa\.me\/971501112233\?text=.*HD-E2E1/);

  // The inquiry form makes a lead; the agent is emailed.
  await card.getByRole("textbox", { name: "Name" }).fill("Sam Visitor");
  await card.getByRole("textbox", { name: "Email" }).fill("sam@example.com");
  await card.getByRole("textbox", { name: "Phone" }).fill("050 123 4567");
  await card.getByRole("checkbox", { name: "I agree to be contacted about this home." }).check();
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    card.getByRole("status").filter({ hasText: "Layla Haddad has your message" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (
          await db().query(
            `select "to", subject from email_log where template = 'lead.new' and "to" = 'layla@agency.example'`,
          )
        ).rows,
    )
    .toEqual([
      {
        to: "layla@agency.example",
        subject: "New lead: Sam Visitor · HD-E2E1 · Website form, listing",
      },
    ]);
});

test("property page @phone: contact options stay at the bottom", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const { slug } = await seedListing(request);
  await page.goto(`/property/${slug}`);
  const bar = page.getByRole("region", { name: "Contact options" });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("link", { name: "WhatsApp" })).toBeVisible();
  await bar.getByRole("button", { name: "Book a tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Book a tour" });
  await expect(dialog.getByRole("group", { name: "Time" })).toBeVisible();
  await snap(page, "property-page-phone");
});

test("property page: book a tour at a real free time, then move and cancel it", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "desktop flow");
  test.setTimeout(240_000);
  const { slug } = await seedListing(request);
  await db().query("delete from viewings");
  await page.goto(`/property/${slug}`);
  const card = page.getByRole("complementary", { name: "Ask about this home" });
  await card.getByRole("button", { name: "Book a tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Book a tour" });

  // Free times come from the agency's viewing hours; pick the first one offered.
  const times = dialog.getByRole("group", { name: "Time" });
  await times.getByRole("radio").first().check({ force: true });
  await dialog.getByRole("radio", { name: "Video tour" }).check({ force: true });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Sam Visitor");
  await dialog.getByRole("textbox", { name: "Phone" }).fill("050 123 4567");
  await dialog
    .getByRole("textbox", { name: "Email (for the confirmation)" })
    .fill("sam@example.com");
  await dialog
    .getByRole("checkbox", { name: "I agree to be contacted about this viewing." })
    .check();
  await dialog.getByRole("button", { name: "Book this time" }).click();
  await expect(dialog.getByText(/You're booked for /)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Add to my calendar" })).toHaveAttribute(
    "href",
    /^\/api\/viewings\/[A-Za-z0-9_-]{32}\/ics$/,
  );
  await snap(page, "viewing-booked");
  await expect
    .poll(async () => (await db().query("select status, type from viewings")).rows)
    .toEqual([{ status: "confirmed", type: "video" }]);
  await expect
    .poll(
      async () =>
        (
          await db().query(
            `select count(*)::int as n from email_log where template = 'viewing.confirmed'`,
          )
        ).rows[0].n,
    )
    .toBe(1);

  // The private link: move to another time, then cancel.
  const manage = await dialog.getByRole("link", { name: "Change or cancel" }).getAttribute("href");
  // Closing the dialog sends focus back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(card.getByRole("button", { name: "Book a tour" })).toBeFocused();
  await page.goto(manage!);
  await expect(page.getByRole("heading", { name: "Your viewing", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Move to another time" }).click();
  // Another day, so a free time is there whatever the hour now.
  await page.getByRole("group", { name: "Day" }).getByRole("radio").nth(1).check({ force: true });
  await page.getByRole("group", { name: "Time" }).getByRole("radio").first().check({ force: true });
  await page.getByRole("button", { name: "Move to another time" }).click();
  await expect(page.getByText(/^Moved to /)).toBeVisible();
  await page.getByRole("button", { name: "Cancel the viewing" }).click();
  await page.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(page.getByText("Your viewing is cancelled.")).toBeVisible();
  await expect
    .poll(async () => (await db().query("select status from viewings")).rows)
    .toEqual([{ status: "cancelled" }]);
});
