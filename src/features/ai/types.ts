/**
 * Provider-neutral shapes for the AI service layer (10 intro). Every provider maps these to
 * and from its own API, so the model can be swapped without touching the assistants.
 */

export type AiTextBlock = { type: "text"; text: string };
export type AiToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type AiToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
};
/**
 * A provider block the layer does not interpret (e.g. Claude's thinking blocks). Kept and sent
 * back unchanged in the next request of the same conversation, as the provider requires.
 */
export type AiOpaqueBlock = { type: "opaque"; provider: string; raw: unknown };
/** An image the model looks at, by public address (alt text suggestions, 10 §5). */
export type AiImageBlock = { type: "image"; url: string };

export type AiContentBlock =
  AiTextBlock | AiImageBlock | AiToolUseBlock | AiToolResultBlock | AiOpaqueBlock;

export type AiMessage = { role: "user" | "assistant"; content: AiContentBlock[] };

/** JSON Schema of a tool's input (from its Zod schema, see tools/registry.ts). */
export type JsonSchema = Record<string, unknown>;

export type AiToolSpec = { name: string; description: string; inputSchema: JsonSchema };

export type AiEffort = "low" | "medium" | "high";

export type AiRequest = {
  model: string;
  system: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  maxTokens: number;
  /** How much the model thinks before answering; omitted = the model's default. */
  effort?: AiEffort;
  signal?: AbortSignal;
};

export type AiStopReason =
  "end_turn" | "tool_use" | "max_tokens" | "refusal" | "stop_sequence" | "pause_turn" | "other";

export type AiUsageCount = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type AiResponse = {
  /** The model that actually answered (a fallback model may differ from the one asked). */
  model: string;
  content: AiContentBlock[];
  stopReason: AiStopReason;
  usage: AiUsageCount;
};

export type AiStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "done"; response: AiResponse };

/** The real model providers Settings -> Integrations offers. */
export const aiProviderNames = ["xai", "groq", "gemini", "anthropic"] as const;
export type AiProviderName = (typeof aiProviderNames)[number];

export interface AiProvider {
  readonly name: AiProviderName | "mock";
  complete(request: AiRequest): Promise<AiResponse>;
  /** Text arrives as it is written; the last event carries the whole response. */
  stream(request: AiRequest): AsyncIterable<AiStreamEvent>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export const emptyUsage = (): AiUsageCount => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: AiUsageCount, b: AiUsageCount): AiUsageCount {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** All text blocks of a response, joined. */
export function responseText(content: AiContentBlock[]): string {
  return content
    .filter((b): b is AiTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
