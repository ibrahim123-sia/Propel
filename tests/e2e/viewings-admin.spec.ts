import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  clearLeads,
  clearListings,
  db,
  deleteLocations,
  revalidateTags,
  setSettings,
  signInAsAdmin,
  snap,
} from "./helpers";

const AGENCY = process.env.AGENCY_ID || "0192f000-0000-7000-8000-000000000001";
const q = async (sql: string, params: unknown[] = []) => (await db().query(sql, params)).rows;

/** A listing with its agent, a lead for it and one confirmed viewing tomorrow at 11:00. */
async function seed(request: APIRequestContext) {
  await clearLeads();
  await clearListings();
  await db().query("delete from agents where slug = 'e2e-va-agent'");
  await db().query("delete from developers where slug = 'e2e-va-dev'");
  await deleteLocations(["e2e-va-bay"]);
  await setSettings(request, "general", { timeZone: "UTC" });
  const [loc] = await q(
    `insert into locations (id, agency_id, level, name, slug) values (gen_random_uuid(), $1, 'area', 'E2E VA Bay', 'e2e-va-bay') returning id`,
    [AGENCY],
  );
  const [agent] = await q(
    `insert into agents (id, agency_id, name, slug, email, is_active) values (gen_random_uuid(), $1, 'E2E Viewing Agent', 'e2e-va-agent', 'va@agency.example', true) returning id`,
    [AGENCY],
  );
  const [home] = await q(
    `insert into properties (id, agency_id, reference, title, slug, purpose, status, agent_id, location_id, published_at, price, currency)
     values (gen_random_uuid(), $1, 'HD-V1', 'E2E Viewing Home', 'e2e-viewing-home', 'sale', 'available', $2, $3, now(), 150000000, 'AED') returning id`,
    [AGENCY, agent.id, loc.id],
  );
  const [contact] = await q(
    `insert into contacts (id, agency_id, name, email, phone) values (gen_random_uuid(), $1, 'E2E Viewer', 'viewer@example.com', '+971501112299') returning id`,
    [AGENCY],
  );
  const [lead] = await q(
    `insert into leads (id, agency_id, contact_id, source, agent_id, property_ids) values (gen_random_uuid(), $1, $2, 'form', $3, array[$4]::uuid[]) returning id`,
    [AGENCY, contact.id, agent.id, home.id],
  );
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const start = new Date(`${tomorrow}T11:00:00Z`);
  await q(
    `insert into viewings (id, agency_id, lead_id, contact_id, property_id, agent_id, type, starts_at, ends_at, status, source)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'in_person', $6, $7, 'confirmed', 'site')`,
    [
      AGENCY,
      lead.id,
      contact.id,
      home.id,
      agent.id,
      start,
      new Date(start.getTime() + 30 * 60_000),
    ],
  );
  await revalidateTags(request, ["listings", "agents", "locations", "projects", "developers"]);
  return { tomorrow, leadId: lead.id as string, homeId: home.id as string, locationId: loc.id };
}

test("viewings calendar: open a viewing, mark it done; book one from a lead", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "desktop admin");
  test.setTimeout(300_000);
  const { tomorrow, leadId, homeId } = await seed(request);
  await signInAsAdmin(page, request);

  await page.goto(`/admin/viewings?view=week&date=${tomorrow}`);
  await expect(page.getByRole("heading", { name: "Viewings", level: 1 })).toBeVisible();
  const block = page.getByRole("button", {
    name: /^E2E Viewer, HD-V1 · E2E Viewing Home, 11:00, Confirmed/,
  });
  await expect(block).toBeVisible();
  await snap(page, "viewings-calendar");
  await block.click();
  const panel = page.getByRole("dialog", { name: "E2E Viewer: HD-V1 · E2E Viewing Home" });
  await expect(panel.getByRole("combobox", { name: "Agent" })).toHaveText("E2E Viewing Agent");
  await panel.getByRole("button", { name: "Mark done" }).click();
  await expect.poll(async () => (await q("select status from viewings"))[0]?.status).toBe("done");
  // Done asks the visitor how it went.
  await expect
    .poll(
      async () =>
        (await q("select count(*)::int as n from email_log where template = 'viewing.feedback'"))[0]
          .n,
    )
    .toBe(1);

  // From the lead's "Book viewing": the agent's free times are offered.
  await page.goto(`/admin/viewings/new?lead=${leadId}&property=${homeId}`);
  await expect(page.getByRole("heading", { name: "New viewing", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "E2E Viewer" })).toBeVisible();
  await page.getByRole("combobox", { name: "Time" }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Book viewing" }).click();
  await expect(page).toHaveURL(/\/admin\/viewings\?date=\d{4}-\d{2}-\d{2}$/);
  await expect
    .poll(async () => await q("select source, status from viewings where source = 'admin'"))
    .toEqual([{ source: "admin", status: "confirmed" }]);
});

test("project page: book a tour at the agency's free times", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "desktop flow");
  test.setTimeout(240_000);
  const { locationId } = await seed(request);
  const [dev] = await q(
    `insert into developers (id, agency_id, name, slug) values (gen_random_uuid(), $1, 'E2E VA Developer', 'e2e-va-dev') returning id`,
    [AGENCY],
  );
  await q(
    `insert into projects (id, agency_id, name, slug, developer_id, location_id, status, is_published, published_at)
     values (gen_random_uuid(), $1, 'E2E Harbour Lofts', 'e2e-harbour-lofts', $2, $3, 'under_construction', true, now())`,
    [AGENCY, dev.id, locationId],
  );
  await revalidateTags(request, ["projects", "developers"]);

  await page.goto("/projects/e2e-harbour-lofts");
  await expect(page.getByRole("heading", { name: "E2E Harbour Lofts", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Book a tour" }).click();
  const dialog = page.getByRole("dialog", { name: "Book a tour" });
  await dialog.getByRole("combobox", { name: "Time" }).selectOption({ index: 1 });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Project Visitor");
  await dialog.getByRole("textbox", { name: "Phone" }).fill("+971 50 222 3344");
  await dialog
    .getByRole("checkbox", { name: "I agree to be contacted about this viewing." })
    .check();
  await dialog.getByRole("button", { name: "Book this time" }).click();
  await expect(dialog.getByText(/You're booked for /)).toBeVisible();
  await expect
    .poll(
      async () =>
        (await q("select count(*)::int as n from viewings where project_id is not null"))[0].n,
    )
    .toBe(1);
});
