import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, type Db, type DbOrTx } from "@/db/client";
import { currentAgencyId } from "@/db/schema/_common";
import { secrets } from "@/db/schema/system";
import { sendTemplate } from "@/features/leads/process";
import { activeAdminEmails } from "@/features/reports/weekly";
import { loadSettings } from "@/features/settings/queries";
import type { SecretKey } from "@/features/settings/schema";
import { recordSecretTest } from "@/features/settings/secrets";
import { localDateString } from "@/lib/local-date";

/**
 * Admin alerts about the system itself (13 §3 "Integration error: email + banner in admin";
 * 13 §2 monthly "exchange-rate reminder to admin"). Both follow Settings -> Notifications.
 */

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** What the alert calls each key's service. */
const serviceOf: Partial<Record<SecretKey, string>> = {
  google_maps_server_key: "Google Maps Platform",
  whatsapp_access_token: "WhatsApp Cloud API",
  resend_api_key: "Email (Resend)",
  google_oauth_client_secret: "Google Calendar",
  ai_api_key: "The AI provider",
  ai_fallback_api_key: "The backup AI provider",
};

async function lastErrorOf(key: SecretKey, db: DbOrTx): Promise<string | null> {
  const [row] = await db
    .select({ lastError: secrets.lastError })
    .from(secrets)
    .where(and(eq(secrets.agencyId, currentAgencyId()), eq(secrets.key, key)))
    .limit(1);
  return row?.lastError ?? null;
}

/**
 * Keeps a test or call result on the key (as `recordSecretTest`) and, when a working
 * integration starts failing, emails the admins once a day at most. The admin banner reads
 * the same stored error, so it shows until a test passes again.
 */
export async function recordIntegrationResult(
  key: SecretKey,
  error: string | null,
  conn?: DbOrTx,
): Promise<void> {
  const db = conn ?? (await getDb());
  const before = error ? await lastErrorOf(key, db) : null;
  await recordSecretTest(key, error, db);
  if (!error || before) return;
  const notifications = await loadSettings("notifications", db);
  if (!notifications.admins.integrationError.email) return;
  const { timeZone } = await loadSettings("general", db);
  const url = `${appUrl()}/admin/settings/integrations`;
  await sendTemplate(
    db,
    "system.integration_error",
    await activeAdminEmails(db as Db),
    { integration: serviceOf[key] ?? key, error: error.slice(0, 500), url },
    url,
    { type: "integration_error", id: `${key}:${localDateString(new Date(), timeZone)}` },
  );
}

/** Rates older than this get the monthly reminder. */
const STALE_RATE_DAYS = 25;

/** Monthly (1st): a reminder when the visitor currencies' display rates are getting old. */
export async function remindExchangeRates(
  db: Db,
  now: Date = new Date(),
): Promise<{ sent: number; reason?: string }> {
  const market = await loadSettings("market", db);
  const others = market.visitorCurrencies
    .filter((c) => c.code !== market.baseCurrency.code)
    .map((c) => c.code);
  if (others.length === 0) return { sent: 0, reason: "no other currencies" };
  const updated = market.ratesUpdatedAt ? new Date(market.ratesUpdatedAt) : null;
  if (updated && now.getTime() - updated.getTime() < STALE_RATE_DAYS * 86_400_000)
    return { sent: 0, reason: "rates are recent" };
  const { timeZone, dateFormat } = await loadSettings("general", db);
  const url = `${appUrl()}/admin/settings/market`;
  const ids = await sendTemplate(
    db,
    "system.rates_reminder",
    await activeAdminEmails(db),
    {
      updated: updated
        ? new Intl.DateTimeFormat(dateFormat === "MM/dd/yyyy" ? "en-US" : "en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
            timeZone,
          }).format(updated)
        : "never",
      currencies: others.join(", "),
      url,
    },
    url,
    { type: "rates_reminder", id: localDateString(now, timeZone).slice(0, 7) },
  );
  return { sent: ids.length };
}
