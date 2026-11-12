import { notFound } from "next/navigation";
import { connection } from "next/server";
import { FormSection, PageHeader } from "@/components/admin/page-header";
import { AiSettingsForm } from "@/components/admin/settings/groups/ai-form";
import { BrandingSettingsForm } from "@/components/admin/settings/groups/branding-form";
import { ContactSettingsForm } from "@/components/admin/settings/groups/contact-form";
import { GeneralSettingsForm } from "@/components/admin/settings/groups/general-form";
import { IntegrationsSettingsForm } from "@/components/admin/settings/groups/integrations-form";
import { LeadsSettingsForm } from "@/components/admin/settings/groups/leads-form";
import { LegalSettingsForm } from "@/components/admin/settings/groups/legal-form";
import { LeadStagesEditor } from "@/components/admin/settings/lead-stages-editor";
import { MarketSettingsForm } from "@/components/admin/settings/groups/market-form";
import { NotificationsSettingsForm } from "@/components/admin/settings/groups/notifications-form";
import { SecuritySettingsForm } from "@/components/admin/settings/groups/security-form";
import { SeoSettingsForm } from "@/components/admin/settings/groups/seo-form";
import { ViewingsSettingsForm } from "@/components/admin/settings/groups/viewings-form";
import { resolveMapStyle } from "@/components/maps/map-style";
import { getDb } from "@/db/client";
import { microsToCents } from "@/features/ai/pricing";
import { spendSummary, usageByDay } from "@/features/ai/usage";
import { listLeadStages } from "@/features/lead-stages/queries";
import { loadSettings } from "@/features/settings/queries";
import { listSecretStatus } from "@/features/settings/secrets";
import { requireAdminPage } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { smtpFromEnv } from "@/lib/email/config";

/** Only the host and user reach the page; the password stays on the server. */
function mailServerOf() {
  const smtp = smtpFromEnv();
  return smtp ? { host: smtp.host, port: smtp.port, user: smtp.user } : null;
}

export const instant = false;

const titles = {
  general: ["General", "Agency details, logos, region and maintenance mode."],
  branding: ["Branding", "Colours, fonts and corners of the public site, with a live preview."],
  market: ["Market", "Currency, units, rentals and calculator defaults for your market."],
  contact: ["Contact", "How visitors reach you, and where new lead alerts go."],
  leads: ["Leads and CRM", "The pipeline, assignment, response alerts and lead rules."],
  viewings: ["Viewings", "When viewings can be booked, video tools and reminders."],
  seo: ["SEO", "Title patterns, defaults and what search engines see."],
  integrations: [
    "Integrations",
    "Connections to maps, WhatsApp, email, calendars, analytics, ads and AI.",
  ],
  ai: ["AI", "How the website and admin assistants behave."],
  notifications: ["Notifications", "Which events send email or WhatsApp alerts."],
  legal: ["Legal and privacy", "Policy pages, the cookie banner and data retention."],
  security: ["Security", "Two-step verification, sessions and sign-in options."],
} as const;

type Tab = keyof typeof titles;
const isTab = (g: string): g is Tab => g in titles;

export async function generateMetadata(props: PageProps<"/admin/settings/[group]">) {
  const { group } = await props.params;
  return { title: isTab(group) ? `${titles[group][0]} settings` : "Settings" };
}

export default async function SettingsGroupPage(props: PageProps<"/admin/settings/[group]">) {
  const { group } = await props.params;
  if (!isTab(group)) notFound();
  const { user } = await requireAdminPage();
  const readOnly = user.readOnly;
  const db = await getDb();
  const [title, description] = titles[group];

  const form = await (async () => {
    switch (group) {
      case "general": {
        const value = await loadSettings("general", db);
        return (
          <GeneralSettingsForm
            initial={value}
            readOnly={readOnly}
            timeZones={Intl.supportedValuesOf("timeZone")}
          />
        );
      }
      case "branding": {
        const [value, market] = await Promise.all([
          loadSettings("branding", db),
          loadSettings("market", db),
        ]);
        const c = market.baseCurrency;
        const amount = (1_250_000).toLocaleString("en", { maximumFractionDigits: 0 });
        return (
          <BrandingSettingsForm
            initial={value}
            readOnly={readOnly}
            preview={{
              price:
                c.symbolPosition === "before" ? `${c.symbol}${amount}` : `${amount} ${c.symbol}`,
              area: market.areaUnit === "sqft" ? "1,450 sq.ft" : "135 m²",
            }}
          />
        );
      }
      case "market": {
        const [value, integrations] = await Promise.all([
          loadSettings("market", db),
          loadSettings("integrations", db),
        ]);
        return (
          <MarketSettingsForm
            initial={value}
            readOnly={readOnly}
            mapStyleUrl={resolveMapStyle(integrations.googleMaps).styleUrl}
          />
        );
      }
      case "contact": {
        const [value, integrations, market] = await Promise.all([
          loadSettings("contact", db),
          loadSettings("integrations", db),
          loadSettings("market", db),
        ]);
        return (
          <ContactSettingsForm
            initial={value}
            readOnly={readOnly}
            mapStyleUrl={resolveMapStyle(integrations.googleMaps).styleUrl}
            mapCenter={market.mapCenter}
          />
        );
      }
      case "leads": {
        const [value, stages] = await Promise.all([loadSettings("leads", db), listLeadStages(db)]);
        return (
          <div className="flex flex-col gap-6">
            <FormSection
              title="Pipeline stages"
              description="The columns of the leads board, in order. New leads start in the first open stage. Changes here save straight away."
            >
              <LeadStagesEditor stages={stages} readOnly={readOnly} />
            </FormSection>
            <LeadsSettingsForm initial={value} readOnly={readOnly} />
          </div>
        );
      }
      case "viewings": {
        const [value, general] = await Promise.all([
          loadSettings("viewings", db),
          loadSettings("general", db),
        ]);
        return (
          <ViewingsSettingsForm
            initial={value}
            readOnly={readOnly}
            firstDayOfWeek={general.firstDayOfWeek}
          />
        );
      }
      case "seo":
        return <SeoSettingsForm initial={await loadSettings("seo", db)} readOnly={readOnly} />;
      case "integrations": {
        const [value, keys] = await Promise.all([
          loadSettings("integrations", db),
          listSecretStatus(db),
        ]);
        return (
          <IntegrationsSettingsForm
            initial={value}
            readOnly={readOnly}
            keys={keys.map((k) => ({ ...k, lastTestedAt: k.lastTestedAt?.toISOString() ?? null }))}
            appUrl={env().APP_URL.replace(/\/$/, "")}
            mailServer={mailServerOf()}
          />
        );
      }
      case "ai": {
        // Usage per day reads the clock: render at request time.
        await connection();
        const [value, spend, days] = await Promise.all([
          loadSettings("ai", db),
          spendSummary(db),
          usageByDay(14, db),
        ]);
        return (
          <AiSettingsForm
            initial={value}
            readOnly={readOnly}
            usage={{
              todayCents: microsToCents(spend.todayMicros),
              monthCents: microsToCents(spend.monthMicros),
              days: days.map((d) => ({
                date: d.date,
                requests: d.requests,
                tokens: d.inputTokens + d.outputTokens,
                costCents: microsToCents(d.costMicros),
              })),
            }}
          />
        );
      }
      case "notifications":
        return (
          <NotificationsSettingsForm
            initial={await loadSettings("notifications", db)}
            readOnly={readOnly}
          />
        );
      case "legal":
        // Pages arrive with the CMS (Website -> Pages); until then there is nothing to link.
        return (
          <LegalSettingsForm
            initial={await loadSettings("legal", db)}
            readOnly={readOnly}
            pages={[]}
          />
        );
      case "security":
        return (
          <SecuritySettingsForm
            initial={await loadSettings("security", db)}
            readOnly={readOnly}
            googleConfigured={Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET)}
          />
        );
    }
  })();

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        breadcrumb={[{ label: "Settings" }, { label: title }]}
      />
      {/* A fresh form per tab, so unsaved edits never carry over to another group. */}
      <div key={group}>{form}</div>
    </>
  );
}
