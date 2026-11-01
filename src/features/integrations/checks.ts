import "server-only";
import type { DbOrTx } from "@/db/client";
import { loadSettings } from "@/features/settings/queries";
import { getSecret } from "@/features/settings/secrets";
import { recordIntegrationResult } from "@/features/system/alerts";
import type { SecretKey, SettingsOf } from "@/features/settings/schema";
import { aiProviderLabels } from "@/features/ai/provider-labels";
import { aiKey } from "@/features/ai/config";
import { gatewayBase } from "@/features/ai/providers/http";
import type { AiProviderName } from "@/features/ai/types";
import { testGoogleCalendar } from "./google-calendar/calendar";
import { testMapsConnection } from "./google-maps";

/**
 * "Test connection" for each integration (04 §8): a cheap, read-only call with the stored
 * key. The outcome is kept on the key (last tested, last error) for the Integrations screen.
 */
export type CheckResult = { ok: boolean; message: string };

export const testableIntegrations = [
  "googleMaps",
  "googleCalendar",
  "resend",
  "whatsapp",
  "ai",
] as const;
export type TestableIntegration = (typeof testableIntegrations)[number];

/** Graph API version for WhatsApp Cloud API calls (supported until mid-2027). */
export const GRAPH_API_VERSION = "v23.0";

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    error?: { message?: string } | string;
  } | null;
  const nested = typeof body?.error === "string" ? body.error : body?.error?.message;
  return (body?.message ?? nested ?? res.statusText ?? "").slice(0, 300);
}

async function check(
  key: SecretKey,
  db: DbOrTx | undefined,
  run: (secret: string) => Promise<CheckResult>,
  /** Where the key comes from when none is saved (AI keys can live in the environment). */
  lookup: () => Promise<string | null> = () => getSecret(key, db),
): Promise<CheckResult> {
  const secret = await lookup();
  if (!secret) return { ok: false, message: "Add the key first." };
  let result: CheckResult;
  try {
    result = await run(secret);
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    result = {
      ok: false,
      message: timedOut
        ? "No answer within 10 seconds."
        : `Could not connect: ${(err as Error).message}`,
    };
  }
  await recordIntegrationResult(key, result.ok ? null : result.message, db);
  return result;
}

const timeout = () => AbortSignal.timeout(10_000);

export async function testResend(db?: DbOrTx): Promise<CheckResult> {
  return check("resend_api_key", db, async (key) => {
    const res = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeout(),
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown[] };
      const n = body.data?.length ?? 0;
      return { ok: true, message: `Connected (${n} sending domain${n === 1 ? "" : "s"})` };
    }
    const text = await errorText(res);
    // A key limited to sending cannot list domains, but it is valid.
    if (res.status === 401 && /restricted/i.test(text)) {
      return { ok: true, message: "Connected (sending-only key)" };
    }
    return { ok: false, message: `Resend answered ${res.status}: ${text}` };
  });
}

export async function testWhatsapp(db?: DbOrTx): Promise<CheckResult> {
  const { whatsapp } = await loadSettings("integrations", db);
  if (!whatsapp.phoneNumberId) return { ok: false, message: "Enter the phone number ID first." };
  return check("whatsapp_access_token", db, async (token) => {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(whatsapp.phoneNumberId)}?fields=display_phone_number,verified_name`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeout(),
    });
    if (!res.ok)
      return { ok: false, message: `Meta answered ${res.status}: ${await errorText(res)}` };
    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string };
    return {
      ok: true,
      message: `Connected: ${body.display_phone_number ?? "number"}${body.verified_name ? ` (${body.verified_name})` : ""}`,
    };
  });
}

type AiSettings = SettingsOf<"integrations">["ai"];

/** The models a key can use, from the provider's model list (empty when it lists none). */
async function listModels(
  provider: AiProviderName,
  key: string,
  ai: AiSettings,
  db: DbOrTx | undefined,
): Promise<{ ok: true; models: Set<string> } | { ok: false; message: string }> {
  const gateway =
    ai.gatewayAccountId && ai.gatewayName
      ? { accountId: ai.gatewayAccountId, name: ai.gatewayName }
      : null;
  const headers: Record<string, string> = {};
  if (gateway) {
    const gatewayToken = await getSecret("ai_gateway_token", db);
    if (gatewayToken) headers["cf-aig-authorization"] = `Bearer ${gatewayToken}`;
  }
  let url: string;
  if (provider === "anthropic") {
    url = `${gatewayBase(gateway, "anthropic") ?? "https://api.anthropic.com"}/v1/models`;
    Object.assign(headers, { "x-api-key": key, "anthropic-version": "2023-06-01" });
  } else if (provider === "groq") {
    url = `${gatewayBase(gateway, "groq") ?? "https://api.groq.com/openai/v1"}/models`;
    headers.authorization = `Bearer ${key}`;
  } else if (provider === "xai") {
    url = `${gatewayBase(gateway, "grok") ?? "https://api.x.ai"}/v1/models`;
    headers.authorization = `Bearer ${key}`;
  } else {
    url = `${gatewayBase(gateway, "google-ai-studio") ?? "https://generativelanguage.googleapis.com"}/v1beta/models?pageSize=1000`;
    headers["x-goog-api-key"] = key;
  }
  const res = await fetch(url, { headers, signal: timeout() });
  if (!res.ok)
    return {
      ok: false,
      message: `${aiProviderLabels[provider]} answered ${res.status}: ${await errorText(res)}`,
    };
  const body = (await res.json()) as {
    data?: Array<{ id: string }>;
    models?: Array<{ name: string }>;
  };
  const ids = [
    ...(body.data ?? []).map((m) => m.id),
    ...(body.models ?? []).map((m) => m.name.replace(/^models\//, "")),
  ];
  return { ok: true, models: new Set(ids) };
}

async function testAiKey(
  key: SecretKey,
  provider: AiProviderName,
  models: string[],
  ai: AiSettings,
  db: DbOrTx | undefined,
): Promise<CheckResult> {
  return check(
    key,
    db,
    async (secret) => {
      const listed = await listModels(provider, secret, ai, db);
      if (!listed.ok) return listed;
      const missing = [...new Set(models.filter(Boolean))].filter(
        (m) => listed.models.size > 0 && !listed.models.has(m),
      );
      const via = ai.gatewayAccountId && ai.gatewayName ? " through the AI Gateway" : "";
      return missing.length
        ? {
            ok: false,
            message: `${aiProviderLabels[provider]}: connected, but these models are not available: ${missing.join(", ")}`,
          }
        : { ok: true, message: `${aiProviderLabels[provider]}: connected${via}` };
    },
    () => aiKey(key === "ai_api_key" ? "ai_api_key" : "ai_fallback_api_key", provider, db),
  );
}

/** The provider, then the backup provider when one is set. */
export async function testAi(db?: DbOrTx): Promise<CheckResult> {
  const { ai } = await loadSettings("integrations", db);
  if (ai.provider === "mock") {
    return { ok: true, message: "Using the built-in test provider (no key needed)." };
  }
  const main = await testAiKey("ai_api_key", ai.provider, [ai.chatModel, ai.fastModel], ai, db);
  if (ai.fallbackProvider === "none") return main;
  const backup = await testAiKey(
    "ai_fallback_api_key",
    ai.fallbackProvider,
    [ai.fallbackChatModel, ai.fallbackFastModel],
    ai,
    db,
  );
  return {
    ok: main.ok && backup.ok,
    message: `${main.message}. Backup: ${backup.message}`,
  };
}

export function runCheck(name: TestableIntegration, db?: DbOrTx): Promise<CheckResult> {
  switch (name) {
    case "googleMaps":
      return testMapsConnection(db);
    case "googleCalendar":
      return testGoogleCalendar(db);
    case "resend":
      return testResend(db);
    case "whatsapp":
      return testWhatsapp(db);
    case "ai":
      return testAi(db);
  }
}
