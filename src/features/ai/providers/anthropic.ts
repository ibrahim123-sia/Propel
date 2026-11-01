import {
  AiProviderError,
  emptyUsage,
  type AiContentBlock,
  type AiMessage,
  type AiProvider,
  type AiRequest,
  type AiResponse,
  type AiStopReason,
  type AiStreamEvent,
  type AiUsageCount,
} from "../types";
import { gatewayBase, parseToolInput, postWithRetries } from "./http";
import { parseSse } from "./sse";

/**
 * Claude through the Messages API over plain `fetch` (no SDK: it runs the same on Workers and
 * in Node, and the spec keeps the provider behind our own interface). Requests go through the
 * Cloudflare AI Gateway when its account and name are set (logs, caching, rate limits there),
 * straight to Anthropic otherwise.
 */

export type AnthropicConfig = {
  apiKey: string;
  gateway?: { accountId: string; name: string; token?: string | null } | null;
  /** Tests pass a fake; defaults to the global fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
};

const API_VERSION = "2023-06-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`): a declined
 * request is re-run on a fallback model inside the same call. Other models (Haiku) have none;
 * a refusal there ends in our normal hand-over to the team.
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export function anthropicBaseUrl(gateway: AnthropicConfig["gateway"]): string {
  return gatewayBase(gateway, "anthropic") ?? "https://api.anthropic.com";
}

type WireBlock = Record<string, unknown> & { type: string };

function toWireContent(blocks: AiMessage["content"]): WireBlock[] {
  const out: WireBlock[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.text.trim()) out.push({ type: "text", text: b.text });
    } else if (b.type === "image") out.push({ type: "image", source: { type: "url", url: b.url } });
    else if (b.type === "tool_use")
      out.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "tool_result")
      out.push({
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      });
    else if (b.provider === "anthropic") out.push(b.raw as WireBlock);
  }
  return out;
}

export function anthropicRequestBody(req: AiRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    // The system prompt (and the tools before it) is the same on every turn: cache it.
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: req.messages.map((m) => ({ role: m.role, content: toWireContent(m.content) })),
  };
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  if (req.effort) body.output_config = { effort: req.effort };
  if (FALLBACK_MODELS.has(req.model)) body.fallbacks = "default";
  if (stream) body.stream = true;
  return body;
}

function fromWireContent(blocks: WireBlock[]): AiContentBlock[] {
  return blocks.map((b): AiContentBlock => {
    if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b.type === "tool_use")
      return { type: "tool_use", id: String(b.id), name: String(b.name), input: b.input ?? {} };
    return { type: "opaque", provider: "anthropic", raw: b };
  });
}

function stopReason(value: unknown): AiStopReason {
  switch (value) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "stop_sequence":
    case "pause_turn":
      return value;
    default:
      return "other";
  }
}

type WireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function usageFrom(u: WireUsage | undefined, base: AiUsageCount = emptyUsage()): AiUsageCount {
  if (!u) return base;
  return {
    inputTokens: u.input_tokens ?? base.inputTokens,
    outputTokens: u.output_tokens ?? base.outputTokens,
    cacheReadTokens: u.cache_read_input_tokens ?? base.cacheReadTokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? base.cacheWriteTokens,
  };
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AnthropicConfig) {
    this.fetchImpl = config.fetch ?? ((...args) => fetch(...args));
  }

  private headers(model: string): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": API_VERSION,
    };
    if (FALLBACK_MODELS.has(model)) h["anthropic-beta"] = FALLBACK_BETA;
    if (this.config.gateway?.token)
      h["cf-aig-authorization"] = `Bearer ${this.config.gateway.token}`;
    return h;
  }

  private post(req: AiRequest, stream: boolean): Promise<Response> {
    return postWithRetries({
      fetch: this.fetchImpl,
      url: `${anthropicBaseUrl(this.config.gateway)}/v1/messages`,
      headers: this.headers(req.model),
      body: JSON.stringify(anthropicRequestBody(req, stream)),
      signal: req.signal,
      maxRetries: this.config.maxRetries,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const res = await this.post(req, false);
    const json = (await res.json()) as {
      model?: string;
      content?: WireBlock[];
      stop_reason?: string;
      usage?: WireUsage;
    };
    return {
      model: json.model ?? req.model,
      content: fromWireContent(json.content ?? []),
      stopReason: stopReason(json.stop_reason),
      usage: usageFrom(json.usage),
    };
  }

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const res = await this.post(req, true);
    if (!res.body) throw new AiProviderError("The AI provider sent an empty stream.");

    let model = req.model;
    let usage = emptyUsage();
    let stop: AiStopReason = "other";
    // Blocks by index as they stream in; tool inputs arrive as JSON fragments.
    const blocks: WireBlock[] = [];
    const partialJson = new Map<number, string>();

    for await (const { event, data } of parseSse(res.body)) {
      if (event === "ping" || !data) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (msg.type) {
        case "message_start": {
          const m = msg.message as { model?: string; usage?: WireUsage } | undefined;
          if (m?.model) model = m.model;
          usage = usageFrom(m?.usage, usage);
          break;
        }
        case "content_block_start": {
          const index = Number(msg.index);
          const block = { ...(msg.content_block as WireBlock) };
          blocks[index] = block;
          if (block.type === "tool_use") {
            partialJson.set(index, "");
            yield { type: "tool_use_start", id: String(block.id), name: String(block.name) };
          }
          break;
        }
        case "content_block_delta": {
          const index = Number(msg.index);
          const block = blocks[index];
          const delta = msg.delta as Record<string, unknown> & { type: string };
          if (!block) break;
          if (delta.type === "text_delta") {
            const text = String(delta.text ?? "");
            block.text = String(block.text ?? "") + text;
            if (text) yield { type: "text", text };
          } else if (delta.type === "input_json_delta")
            partialJson.set(
              index,
              (partialJson.get(index) ?? "") + String(delta.partial_json ?? ""),
            );
          else if (delta.type === "thinking_delta")
            block.thinking = String(block.thinking ?? "") + String(delta.thinking ?? "");
          else if (delta.type === "signature_delta") block.signature = delta.signature;
          break;
        }
        case "content_block_stop": {
          const index = Number(msg.index);
          const block = blocks[index];
          if (block?.type === "tool_use") {
            // Cut off mid-input (max_tokens): the runner reports it as an invalid call.
            block.input = parseToolInput(partialJson.get(index) ?? "");
          }
          break;
        }
        case "message_delta": {
          const delta = msg.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) stop = stopReason(delta.stop_reason);
          usage = usageFrom(msg.usage as WireUsage | undefined, usage);
          break;
        }
        case "error": {
          const e = msg.error as { type?: string; message?: string } | undefined;
          throw new AiProviderError(
            `The AI provider stopped: ${e?.message ?? "unknown error"}`,
            null,
            e?.type === "overloaded_error",
          );
        }
      }
    }

    yield {
      type: "done",
      response: {
        model,
        content: fromWireContent(blocks.filter(Boolean)),
        stopReason: stop,
        usage,
      },
    };
  }
}
