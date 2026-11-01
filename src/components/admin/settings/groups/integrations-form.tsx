"use client";

import { CopyIcon, PlugZapIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { SelectField, SwitchField, TextInputField } from "@/components/admin/fields";
import { FormSection } from "@/components/admin/page-header";
import { actionErrorToast } from "@/components/admin/reauth-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { testIntegration } from "@/features/integrations/actions";
import { aiProviderLabels, suggestedModels } from "@/features/ai/provider-labels";
import { aiProviderNames } from "@/features/ai/types";
import { webhookPaths } from "@/features/integrations/catalog";
import type { TestableIntegration } from "@/features/integrations/checks";
import type { SecretKey, SettingsOf } from "@/features/settings/schema";
import { SecretKeyField, type KeyStatus } from "../secret-key-field";
import { SettingsForm } from "../settings-form";

type Integrations = SettingsOf<"integrations">;

/**
 * 04 §8 Integrations: each service has on/off and its settings (saved with the form), keys
 * (saved on their own, encrypted, shown masked), a "Test connection" button and the last error.
 */
export function IntegrationsSettingsForm({
  initial,
  readOnly,
  keys: initialKeys,
  appUrl,
}: {
  initial: Integrations;
  readOnly: boolean;
  keys: KeyStatus[];
  appUrl: string;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState(initialKeys);
  const [testing, setTesting] = useState<TestableIntegration | null>(null);
  const statusOf = (key: SecretKey) => keys.find((k) => k.key === key)!;
  const keyField = (key: SecretKey) => (
    <SecretKeyField
      status={statusOf(key)}
      readOnly={readOnly}
      onChange={(next) => setKeys((list) => list.map((k) => (k.key === next.key ? next : k)))}
    />
  );

  async function test(name: TestableIntegration) {
    setTesting(name);
    const res = await testIntegration({ name });
    setTesting(null);
    if (!res.ok) return actionErrorToast(res, router);
    setKeys(res.data.status);
    if (res.data.ok) toast.success(res.data.message);
    else toast.error(res.data.message);
  }

  const testButton = (name: TestableIntegration) =>
    readOnly ? undefined : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={testing !== null}
        onClick={() => void test(name)}
      >
        <PlugZapIcon /> {testing === name ? "Testing…" : "Test connection"}
      </Button>
    );

  return (
    <SettingsForm group="integrations" initial={initial} readOnly={readOnly}>
      {({ value, set, errorFor }) => (
        <>
          <p className="text-[13px] text-text-muted">
            Keys save on their own as soon as you press “Save key”; they are stored encrypted and
            never shown again in full. The other settings save with “Save changes”.
          </p>

          <FormSection
            title="Google Maps Platform"
            description="Address search, nearby places and travel times."
            actions={testButton("googleMaps")}
          >
            <SwitchField
              label="Use Google Maps Platform"
              checked={value.googleMaps.enabled}
              onChange={(enabled) => set({ googleMaps: { ...value.googleMaps, enabled } })}
            />
            {keyField("google_maps_server_key")}
            <SwitchField
              label="Allow “Import from Google” for places"
              checked={value.googleMaps.importPlaces}
              onChange={(importPlaces) =>
                set({ googleMaps: { ...value.googleMaps, importPlaces } })
              }
            />
            <SwitchField
              label="Add places Google finds near listings"
              description="When a listing has fewer than three places of a type nearby, the distances job looks on Google and adds what it finds to Setup -> Places."
              checked={value.googleMaps.addNearbyPlaces}
              onChange={(addNearbyPlaces) =>
                set({ googleMaps: { ...value.googleMaps, addNearbyPlaces } })
              }
            />
            <TextInputField
              label="Map tile key"
              description="Public key for the map background (e.g. MapTiler). Leave empty for the free default map."
              value={value.googleMaps.tileKey}
              onChange={(tileKey) =>
                set({ googleMaps: { ...value.googleMaps, tileKey: tileKey.trim() } })
              }
              error={errorFor("googleMaps.tileKey")}
            />
            <TextInputField
              label="Map style address"
              type="url"
              placeholder="https://"
              value={value.googleMaps.tileStyleUrl}
              onChange={(tileStyleUrl) =>
                set({ googleMaps: { ...value.googleMaps, tileStyleUrl: tileStyleUrl.trim() } })
              }
              error={errorFor("googleMaps.tileStyleUrl")}
            />
          </FormSection>

          <FormSection
            title="WhatsApp Cloud API"
            description="Two-way WhatsApp with leads, from Meta."
            actions={testButton("whatsapp")}
          >
            <SwitchField
              label="Use WhatsApp Cloud API"
              checked={value.whatsapp.enabled}
              onChange={(enabled) => set({ whatsapp: { ...value.whatsapp, enabled } })}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInputField
                label="Phone number ID"
                value={value.whatsapp.phoneNumberId}
                onChange={(phoneNumberId) =>
                  set({ whatsapp: { ...value.whatsapp, phoneNumberId: phoneNumberId.trim() } })
                }
                error={errorFor("whatsapp.phoneNumberId")}
              />
              <TextInputField
                label="Business account ID"
                value={value.whatsapp.businessAccountId}
                onChange={(businessAccountId) =>
                  set({
                    whatsapp: { ...value.whatsapp, businessAccountId: businessAccountId.trim() },
                  })
                }
                error={errorFor("whatsapp.businessAccountId")}
              />
              <TextInputField
                label="Number shown to visitors"
                type="tel"
                value={value.whatsapp.displayNumber}
                onChange={(displayNumber) =>
                  set({ whatsapp: { ...value.whatsapp, displayNumber } })
                }
                error={errorFor("whatsapp.displayNumber")}
              />
            </div>
            {keyField("whatsapp_access_token")}
            {keyField("whatsapp_app_secret")}
            <Webhook
              label="Webhook address (callback URL)"
              url={`${appUrl}${webhookPaths.whatsapp}`}
            />
            {keyField("whatsapp_verify_token")}
            <SwitchField
              label="Accept voice notes"
              checked={value.whatsapp.voiceNotes}
              onChange={(voiceNotes) => set({ whatsapp: { ...value.whatsapp, voiceNotes } })}
            />
          </FormSection>

          <FormSection
            title="Email (Resend)"
            description="Sends every email: sign-up, alerts, replies to leads."
            actions={testButton("resend")}
          >
            <SwitchField
              label="Send email through Resend"
              description={
                value.resend.enabled
                  ? undefined
                  : "Off: emails are kept in the outbox and not sent."
              }
              checked={value.resend.enabled}
              onChange={(enabled) => set({ resend: { ...value.resend, enabled } })}
            />
            {keyField("resend_api_key")}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInputField
                label="From address"
                type="email"
                value={value.resend.fromAddress}
                onChange={(fromAddress) =>
                  set({ resend: { ...value.resend, fromAddress: fromAddress.trim() } })
                }
                error={errorFor("resend.fromAddress")}
              />
              <TextInputField
                label="From name"
                description="Leave empty to use the agency name."
                value={value.resend.fromName}
                onChange={(fromName) => set({ resend: { ...value.resend, fromName } })}
                error={errorFor("resend.fromName")}
              />
              <TextInputField
                label="Reply-to address"
                type="email"
                value={value.resend.replyTo}
                onChange={(replyTo) =>
                  set({ resend: { ...value.resend, replyTo: replyTo.trim() } })
                }
                error={errorFor("resend.replyTo")}
              />
              <TextInputField
                label="Inbound domain"
                description="For replies that come back into the CRM."
                value={value.resend.inboundDomain}
                onChange={(inboundDomain) =>
                  set({ resend: { ...value.resend, inboundDomain: inboundDomain.trim() } })
                }
                error={errorFor("resend.inboundDomain")}
              />
            </div>
            <Webhook
              label="Webhook address (delivery events)"
              url={`${appUrl}${webhookPaths.resend}`}
            />
            {keyField("resend_webhook_secret")}
          </FormSection>

          <FormSection
            title="Google Calendar"
            description="Viewings appear in each agent's calendar; busy times are blocked."
            actions={testButton("googleCalendar")}
          >
            <SwitchField
              label="Use Google Calendar"
              checked={value.googleCalendar.enabled}
              onChange={(enabled) => set({ googleCalendar: { ...value.googleCalendar, enabled } })}
            />
            <TextInputField
              label="OAuth client ID"
              value={value.googleCalendar.clientId}
              onChange={(clientId) =>
                set({ googleCalendar: { ...value.googleCalendar, clientId: clientId.trim() } })
              }
              error={errorFor("googleCalendar.clientId")}
            />
            {keyField("google_oauth_client_secret")}
            <Webhook
              label="Authorised redirect URI (add it to the OAuth client in Google Cloud)"
              url={`${appUrl}/api/integrations/google/callback`}
            />
            <p className="text-[12.5px] text-text-muted">
              Each agent connects their own calendar from their profile in Setup, Agents.
            </p>
          </FormSection>

          <FormSection
            title="Analytics and pixels"
            description="Loaded only after a visitor accepts analytics or marketing cookies."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["ga4Id", "Google Analytics 4 ID", "G-XXXXXXXXXX"],
                  ["gtmId", "Google Tag Manager ID", "GTM-XXXXXXX"],
                  ["metaPixelId", "Meta Pixel ID", "123456789012345"],
                  ["tiktokPixelId", "TikTok Pixel ID", "C1A2B3C4D5E6F7G8H9I0"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <TextInputField
                  key={key}
                  label={label}
                  placeholder={placeholder}
                  value={value.analytics[key]}
                  onChange={(v) => set({ analytics: { ...value.analytics, [key]: v.trim() } })}
                  error={errorFor(`analytics.${key}`)}
                />
              ))}
            </div>
          </FormSection>

          <FormSection
            title="Lead forms from social ads"
            description="Leads from Meta, TikTok and Google Ads forms arrive in the inbox."
          >
            {(
              [
                ["meta", "Meta (Facebook and Instagram)", "social_meta_secret"],
                ["tiktok", "TikTok", "social_tiktok_secret"],
                ["google", "Google Ads", "social_google_secret"],
              ] as const
            ).map(([source, label, secret]) => (
              <div key={source} className="flex flex-col gap-3 rounded-md border border-border p-3">
                <SwitchField
                  label={label}
                  checked={value.socialForms[source]}
                  onChange={(on) => set({ socialForms: { ...value.socialForms, [source]: on } })}
                />
                {value.socialForms[source] && (
                  <>
                    <Webhook label="Webhook address" url={`${appUrl}${webhookPaths[source]}`} />
                    {keyField(secret)}
                    {source === "meta" && keyField("social_meta_app_secret")}
                    {source === "meta" && keyField("social_meta_page_token")}
                    <p className="text-[13px] text-muted-foreground">
                      Which form field holds each detail. Give several names, comma separated; the
                      first one the form has is used. Other answers stay on the lead.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["name", "Name"],
                          ["email", "Email"],
                          ["phone", "Phone"],
                          ["budget", "Budget"],
                          ["message", "Message"],
                        ] as const
                      ).map(([field, fieldLabel]) => (
                        <TextInputField
                          key={field}
                          label={`${fieldLabel} field`}
                          value={value.socialFieldMaps[source][field]}
                          onChange={(v) =>
                            set({
                              socialFieldMaps: {
                                ...value.socialFieldMaps,
                                [source]: { ...value.socialFieldMaps[source], [field]: v },
                              },
                            })
                          }
                          error={errorFor(`socialFieldMaps.${source}.${field}`)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </FormSection>

          <FormSection
            title="Property portals"
            description="Leads from portals by email, CSV or API."
            actions={
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/settings/portal-import">Import leads from a CSV</Link>
              </Button>
            }
          >
            {value.portals.map((portal, i) => (
              <div
                key={i}
                className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3"
              >
                <TextInputField
                  label="Name"
                  className="min-w-40 flex-1"
                  value={portal.name}
                  onChange={(name) =>
                    set({ portals: value.portals.map((p, j) => (j === i ? { ...p, name } : p)) })
                  }
                  error={errorFor(`portals.${i}.name`)}
                />
                <TextInputField
                  label="Short key"
                  description="Lowercase, e.g. propertyfinder."
                  className="min-w-40 flex-1"
                  value={portal.key}
                  onChange={(key) =>
                    set({
                      portals: value.portals.map((p, j) =>
                        j === i ? { ...p, key: key.toLowerCase().trim() } : p,
                      ),
                    })
                  }
                  error={errorFor(`portals.${i}.key`)}
                />
                <SelectField
                  label="How leads arrive"
                  className="min-w-40"
                  value={portal.mode}
                  onChange={(mode) =>
                    set({ portals: value.portals.map((p, j) => (j === i ? { ...p, mode } : p)) })
                  }
                  options={[
                    { value: "email", label: "By email" },
                    { value: "csv", label: "CSV upload" },
                    { value: "api", label: "API (webhook)" },
                  ]}
                />
                <SwitchField
                  label={`${portal.name || "Portal"} on`}
                  checked={portal.enabled}
                  onChange={(enabled) =>
                    set({ portals: value.portals.map((p, j) => (j === i ? { ...p, enabled } : p)) })
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${portal.name || "portal"}`}
                  onClick={() => set({ portals: value.portals.filter((_, j) => j !== i) })}
                >
                  <XIcon />
                </Button>
                {portal.mode === "api" && portal.key && (
                  <div className="w-full">
                    <Webhook
                      label="Webhook address"
                      url={`${appUrl}${webhookPaths.portals}/${portal.key}`}
                    />
                  </div>
                )}
              </div>
            ))}
            {value.portals.length < 10 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  set({
                    portals: [
                      ...value.portals,
                      { key: "", name: "", enabled: true, mode: "email" },
                    ],
                  })
                }
              >
                <PlusIcon /> Add a portal
              </Button>
            )}
            {value.portals.some((p) => p.mode === "api") && keyField("portal_webhook_secret")}
          </FormSection>

          <FormSection
            title="AI provider"
            description="Powers the website assistant, lead summaries and drafting."
            actions={testButton("ai")}
          >
            <SwitchField
              label="Use AI features"
              checked={value.ai.enabled}
              onChange={(enabled) => set({ ai: { ...value.ai, enabled } })}
            />
            <SelectField
              label="Provider"
              value={value.ai.provider}
              onChange={(provider) =>
                set({
                  ai: {
                    ...value.ai,
                    provider,
                    // A new provider starts from its suggested models; the admin can type others.
                    ...(provider !== "mock" && provider !== value.ai.provider
                      ? {
                          chatModel: suggestedModels[provider].chat,
                          fastModel: suggestedModels[provider].fast,
                        }
                      : {}),
                  },
                })
              }
              options={[
                ...aiProviderNames.map((p) => ({ value: p, label: aiProviderLabels[p] })),
                { value: "mock", label: "Built-in test provider (no key, canned answers)" },
              ]}
            />
            {value.ai.provider !== "mock" && (
              <>
                {keyField("ai_api_key")}
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextInputField
                    label="Chat model"
                    value={value.ai.chatModel}
                    onChange={(chatModel) =>
                      set({ ai: { ...value.ai, chatModel: chatModel.trim() } })
                    }
                    error={errorFor("ai.chatModel")}
                  />
                  <TextInputField
                    label="Fast model"
                    description="For short jobs: summaries, scoring, tagging."
                    value={value.ai.fastModel}
                    onChange={(fastModel) =>
                      set({ ai: { ...value.ai, fastModel: fastModel.trim() } })
                    }
                    error={errorFor("ai.fastModel")}
                  />
                  <TextInputField
                    label="Cloudflare AI Gateway account ID"
                    description="Optional: route calls through the gateway for logs and caching."
                    value={value.ai.gatewayAccountId}
                    onChange={(gatewayAccountId) =>
                      set({ ai: { ...value.ai, gatewayAccountId: gatewayAccountId.trim() } })
                    }
                    error={errorFor("ai.gatewayAccountId")}
                  />
                  <TextInputField
                    label="Gateway name"
                    value={value.ai.gatewayName}
                    onChange={(gatewayName) =>
                      set({ ai: { ...value.ai, gatewayName: gatewayName.trim() } })
                    }
                    error={errorFor("ai.gatewayName")}
                  />
                </div>
                {value.ai.gatewayAccountId && keyField("ai_gateway_token")}
                <SelectField
                  label="Backup provider"
                  description="Asked when the provider above fails: down, overloaded or out of credit."
                  value={value.ai.fallbackProvider}
                  onChange={(fallbackProvider) =>
                    set({
                      ai: {
                        ...value.ai,
                        fallbackProvider,
                        ...(fallbackProvider !== "none" &&
                        fallbackProvider !== value.ai.fallbackProvider
                          ? {
                              fallbackChatModel: suggestedModels[fallbackProvider].chat,
                              fallbackFastModel: suggestedModels[fallbackProvider].fast,
                            }
                          : {}),
                      },
                    })
                  }
                  options={[
                    { value: "none", label: "None" },
                    ...aiProviderNames.map((p) => ({ value: p, label: aiProviderLabels[p] })),
                  ]}
                />
                {value.ai.fallbackProvider !== "none" && (
                  <>
                    {keyField("ai_fallback_api_key")}
                    <div className="grid gap-4 sm:grid-cols-2">
                      <TextInputField
                        label="Backup chat model"
                        value={value.ai.fallbackChatModel}
                        onChange={(fallbackChatModel) =>
                          set({ ai: { ...value.ai, fallbackChatModel: fallbackChatModel.trim() } })
                        }
                        error={errorFor("ai.fallbackChatModel")}
                      />
                      <TextInputField
                        label="Backup fast model"
                        value={value.ai.fallbackFastModel}
                        onChange={(fallbackFastModel) =>
                          set({ ai: { ...value.ai, fallbackFastModel: fallbackFastModel.trim() } })
                        }
                        error={errorFor("ai.fallbackFastModel")}
                      />
                    </div>
                  </>
                )}
              </>
            )}
            <SelectField
              label="Search embeddings"
              description="Vectors for the assistants' search. Workers AI runs on Cloudflare; elsewhere the built-in test embeddings are used."
              value={value.ai.embeddingProvider}
              onChange={(embeddingProvider) => set({ ai: { ...value.ai, embeddingProvider } })}
              options={[
                { value: "workers_ai", label: "Cloudflare Workers AI" },
                { value: "mock", label: "Built-in test embeddings (no account)" },
              ]}
            />
            {value.ai.embeddingProvider === "workers_ai" && (
              <TextInputField
                label="Embedding model"
                description="Must return 1024 numbers per text (the default @cf/baai/bge-m3 does)."
                value={value.ai.embeddingModel}
                onChange={(embeddingModel) =>
                  set({ ai: { ...value.ai, embeddingModel: embeddingModel.trim() } })
                }
                error={errorFor("ai.embeddingModel")}
              />
            )}
          </FormSection>
        </>
      )}
    </SettingsForm>
  );
}

function Webhook({ label, url }: { label: string; url: string }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold text-ink">{label}</span>
      <div className="flex gap-2">
        <Input
          readOnly
          value={url}
          aria-label={label}
          className="font-mono text-[12.5px]"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          variant="outline"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            navigator.clipboard
              .writeText(url)
              .then(() => toast.success("Copied"))
              .catch(() => toast.error("Could not copy"))
          }
        >
          <CopyIcon />
        </Button>
      </div>
    </div>
  );
}
