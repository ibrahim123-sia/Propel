import type { SecretKey } from "@/features/settings/schema";

/**
 * What the Integrations screen shows for each stored key (04 §8). Keys are saved encrypted
 * and only ever shown masked.
 */
export const keyInfo: Record<SecretKey, { label: string; help?: string }> = {
  google_maps_server_key: {
    label: "Server key",
    help: "Used on the server only. Restrict it to the Geocoding, Places and Routes APIs.",
  },
  whatsapp_access_token: {
    label: "Access token",
    help: "A permanent system-user token from Meta.",
  },
  whatsapp_app_secret: {
    label: "App secret",
    help: "Lets Propel check that webhook calls really come from Meta.",
  },
  whatsapp_verify_token: { label: "Webhook verify token" },
  resend_api_key: { label: "API key" },
  resend_webhook_secret: {
    label: "Webhook signing secret",
    help: "From Resend -> Webhooks (it starts with whsec_).",
  },
  google_oauth_client_secret: { label: "OAuth client secret" },
  ai_api_key: { label: "API key", help: "For the provider chosen above." },
  ai_fallback_api_key: { label: "Backup provider API key" },
  ai_gateway_token: {
    label: "AI Gateway token",
    help: "Only if your gateway requires authentication.",
  },
  social_meta_secret: { label: "Meta verify token" },
  social_tiktok_secret: { label: "TikTok secret" },
  social_google_secret: { label: "Google Ads key" },
  portal_webhook_secret: { label: "Portal webhook secret" },
  social_meta_app_secret: {
    label: "Meta app secret",
    help: "Lets Propel check that Lead Ads webhook calls really come from Meta.",
  },
  social_meta_page_token: {
    label: "Page access token",
    help: "A long-lived page token with leads_retrieval, to read each lead's answers.",
  },
};

/** Tokens Propel makes up itself (the admin pastes them into the other service). */
export const generatableSecrets = [
  "whatsapp_verify_token",
  "social_meta_secret",
  "social_tiktok_secret",
  "social_google_secret",
  "portal_webhook_secret",
] as const satisfies readonly SecretKey[];
export type GeneratableSecret = (typeof generatableSecrets)[number];

export const isGeneratable = (key: SecretKey): key is GeneratableSecret =>
  (generatableSecrets as readonly string[]).includes(key);

/** Where other services send events (the routes arrive with each feature). */
export const webhookPaths = {
  whatsapp: "/api/webhooks/whatsapp",
  resend: "/api/webhooks/resend",
  meta: "/api/webhooks/leads/meta",
  tiktok: "/api/webhooks/leads/tiktok",
  google: "/api/webhooks/leads/google",
  portals: "/api/webhooks/portals",
} as const;
