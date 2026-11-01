import type { AiProviderName } from "./types";

/** How the admin screens name each provider. Client-safe. */
export const aiProviderLabels: Record<AiProviderName, string> = {
  xai: "xAI (Grok)",
  groq: "Groq (open models: gpt-oss, Llama)",
  gemini: "Google (Gemini)",
  anthropic: "Anthropic (Claude)",
};

/** Filled in when the admin picks a provider; any model id the provider lists can be typed. */
export const suggestedModels: Record<AiProviderName, { chat: string; fast: string }> = {
  xai: { chat: "grok-4.7", fast: "grok-4.20-0309-non-reasoning" },
  groq: { chat: "openai/gpt-oss-120b", fast: "openai/gpt-oss-20b" },
  gemini: { chat: "gemini-3.6-flash", fast: "gemini-3.5-flash-lite" },
  anthropic: { chat: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
};
