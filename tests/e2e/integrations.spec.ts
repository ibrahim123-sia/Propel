import { expect, test } from "@playwright/test";
import { db, signInAsAdmin } from "./helpers";

test("integrations: keys are saved masked, tokens shown once, toggles saved", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await db().query("delete from secrets");
  await db().query(`delete from settings where "group" = 'integrations'`);
  await signInAsAdmin(page, request);
  await page.goto("/admin/settings/integrations");
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();

  // A key: saved on its own, then only shown masked.
  const maps = page.getByRole("group", { name: "Server key" });
  await maps.getByLabel("Server key").fill("re_e2e_secret_value_9876");
  await maps.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Server key saved")).toBeVisible();
  await expect(maps.getByLabel("Saved key, hidden")).toHaveText("••••••••9876");
  await expect(page.getByText("re_e2e_secret_value_9876")).toHaveCount(0);
  const stored = await db().query(
    "select encrypted_value from secrets where key = 'google_maps_server_key'",
  );
  expect(stored.rows[0]!.encrypted_value).not.toContain("secret_value");

  // A generated webhook token is shown once, to paste into Meta.
  const verify = page.getByRole("group", { name: "Webhook verify token" });
  await verify.getByRole("button", { name: "Generate" }).click();
  const once = verify.getByRole("status");
  await expect(once).toContainText("shown only this once");
  const token = (await once.locator("code").textContent())!;
  expect(token).toMatch(/^[a-z0-9]{40}$/);
  await once.getByRole("button", { name: "Done" }).click();
  await expect(verify.getByLabel("Saved key, hidden")).toHaveText(`••••••••${token.slice(-4)}`);

  // Ordinary settings save with the form.
  await page.getByRole("switch", { name: "Use Google Maps Platform" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  const settings = await db().query(`select value from settings where "group" = 'integrations'`);
  expect(settings.rows[0]!.value.googleMaps.enabled).toBe(true);
});
