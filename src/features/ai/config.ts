import "server-only";
import type { DbOrTx } from "@/db/client";
import type { AiFeature } from "@/db/schema/ai";
import { loadSettings } from "@/features/settings/queries";
import type { SettingsOf } from "@/features/settings/schema";
import { getSecret } from "@/features/settings/secrets";
import { env } from "@/lib/env";
import { AnthropicProvider } from "./providers/anthropic";
import { FallbackProvider } from "./providers/fallback";
import { GeminiProvider } from "./providers/gemini";
import { GroqProvider } from "./providers/groq";
import { MockProvider } from "./providers/mock";
import { XaiProvider } from "./providers/xai";
import type { AiProvider, AiProviderName } from "./types";

/**
 * Which provider and models the AI layer uses, from Settings -> Integrations (provider, models,
 * gateway, encrypted keys) and Settings -> AI (switches, budgets, the assistant's rules).
 * Model ids are never hard-coded here: they come from Settings.
 */

export type ModelTier = "chat" | "fast";

/** The admin's on/off switches (04 §9), one per AI feature. */
export type AiSwitch =
  "customerChat" | "whatsapp" | "adminAssistant" | "writingHelpers" | "leadScoring" | "mcp";

/** Which switch turns each logged feature on or off. */
export const featureSwitch: Record<AiFeature, AiSwitch | null> = {
  customer_chat: "customerChat",
  whatsapp: "whatsapp",
  admin_chat: "adminAssistant",
  listing_from_text: "adminAssistant",
  topics: "adminAssistant",
  description: "writingHelpers",
  seo: "writingHelpers",
  blog: "writingHelpers",
  alt_text: "writingHelpers",
  valuation: "writingHelpers",
  scoring: "leadScoring",
  summary: "leadScoring",
  embeddings: null,
};

export type AiConfig = {
  /** The master switch in Settings -> Integrations. */
  enabled: boolean;
  provider: AiProviderName | "mock";
  models: Record<ModelTier, string>;
  /** Asked when the provider fails (none with the test provider). */
  fallback: { provider: AiProviderName; models: Record<ModelTier, string> } | null;
  gateway: { accountId: string; name: string } | null;
  embedding: { provider: "mock" | "workers_ai"; model: string };
  ai: SettingsOf<"ai">;
};

export async function loadAiConfig(db?: DbOrTx): Promise<AiConfig> {
  const [integrations, ai] = await Promise.all([
    loadSettings("integrations", db),
    loadSettings("ai", db),
  ]);
  const i = integrations.ai;
  return {
    enabled: i.enabled,
    provider: i.provider,
    models: { chat: i.chatModel, fast: i.fastModel || i.chatModel },
    fallback:
      i.provider !== "mock" && i.fallbackProvider !== "none" && i.fallbackChatModel
        ? {
            provider: i.fallbackProvider,
            models: {
              chat: i.fallbackChatModel,
              fast: i.fallbackFastModel || i.fallbackChatModel,
            },
          }
        : null,
    gateway:
      i.gatewayAccountId && i.gatewayName
        ? { accountId: i.gatewayAccountId, name: i.gatewayName }
        : null,
    embedding: { provider: i.embeddingProvider, model: i.embeddingModel },
    ai,
  };
}

export function switchOn(config: AiConfig, name: AiSwitch): boolean {
  if (name === "adminAssistant") return config.ai.adminAssistantEnabled;
  return config.ai.features[name];
}

/** Whether the editors show their AI writing buttons (master switch and "Writing helpers"). */
export async function writingHelpersOn(db?: DbOrTx): Promise<boolean> {
  const config = await loadAiConfig(db);
  return config.enabled && switchOn(config, "writingHelpers");
}

export class AiNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

const g = globalThis as { __propelAiProviderOverride?: AiProvider | null };

/** Tests and the eval script can swap the provider (e.g. Anthropic over a fake fetch). */
export function setProviderOverride(provider: AiProvider | null): void {
  g.__propelAiProviderOverride = provider;
}

/** The key saved in Settings -> Integrations for this slot, else the provider's env key. */
export async function aiKey(
  slot: "ai_api_key" | "ai_fallback_api_key",
  provider: AiProviderName,
  db?: DbOrTx,
): Promise<string | null> {
  const saved = await getSecret(slot, db);
  if (saved) return saved;
  const e = env();
  return (
    {
      xai: e.XAI_API_KEY,
      groq: e.GROQ_API_KEY,
      gemini: e.GEMINI_API_KEY,
      anthropic: e.ANTHROPIC_API_KEY,
    }[provider] || null
  );
}

type Gateway = { accountId: string; name: string; token: string | null } | null;

function makeProvider(name: AiProviderName, apiKey: string, gateway: Gateway): AiProvider {
  switch (name) {
    case "xai":
      return new XaiProvider({ apiKey, gateway });
    case "groq":
      return new GroqProvider({ apiKey, gateway });
    case "gemini":
      return new GeminiProvider({ apiKey, gateway });
    case "anthropic":
      return new AnthropicProvider({ apiKey, gateway });
  }
}

/**
 * The provider for the current settings, with the backup provider behind it when one is set
 * and has its key. Keys live in Settings -> Integrations.
 */
export async function providerFor(config: AiConfig, db?: DbOrTx): Promise<AiProvider> {
  if (g.__propelAiProviderOverride) return g.__propelAiProviderOverride;
  if (config.provider === "mock") return new MockProvider();
  const [apiKey, fallbackKey, gatewayToken] = await Promise.all([
    aiKey("ai_api_key", config.provider, db),
    config.fallback ? aiKey("ai_fallback_api_key", config.fallback.provider, db) : null,
    config.gateway ? getSecret("ai_gateway_token", db) : Promise.resolve(null),
  ]);
  const gateway = config.gateway ? { ...config.gateway, token: gatewayToken } : null;
  const backup =
    config.fallback && fallbackKey
      ? makeProvider(config.fallback.provider, fallbackKey, gateway)
      : null;
  if (!apiKey) {
    throw new AiNotConfiguredError("The AI provider key is missing.");
  }
  const primary = makeProvider(config.provider, apiKey, gateway);
  if (!backup || !config.fallback) return primary;
  return new FallbackProvider(
    primary,
    backup,
    {
      [config.models.chat]: config.fallback.models.chat,
      [config.models.fast]: config.fallback.models.fast,
    },
    config.fallback.models.chat,
  );
}
