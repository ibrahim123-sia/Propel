import {
  AiProviderError,
  emptyUsage,
  type AiContentBlock,
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
 * Grok through xAI's Responses API (`POST /v1/responses`, the endpoint xAI recommends) over
 * plain `fetch`. Nothing is stored at xAI (`store: false`): every call sends the whole
 * conversation, as the other providers do, and reasoning items come back encrypted so they
 * can be passed on within a tool loop. Through the Cloudflare AI Gateway when it is set.
 */

export type XaiConfig = {
  apiKey: string;
  gateway?: { accountId: string; name: string; token?: string | null } | null;
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
};

export function xaiBaseUrl(gateway: XaiConfig["gateway"]): string {
  return gatewayBase(gateway, "grok") ?? "https://api.x.ai";
}

type WireItem = Record<string, unknown> & { type?: string };

function toWireInput(req: AiRequest): WireItem[] {
  const items: WireItem[] = [];
  for (const m of req.messages) {
    if (m.role === "user") {
      const parts: WireItem[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result")
          items.push({ type: "function_call_output", call_id: b.toolUseId, output: b.content });
        else if (b.type === "text" && b.text.trim())
          parts.push({ type: "input_text", text: b.text });
        else if (b.type === "image") parts.push({ type: "input_image", image_url: b.url });
      }
      if (parts.length) items.push({ type: "message", role: "user", content: parts });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text.trim())
          items.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: b.text }],
          });
      } else if (b.type === "tool_use")
        items.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      // Reasoning items (encrypted) go back as they came; other providers' blocks are dropped.
      else if (b.type === "opaque" && b.provider === "xai") items.push(b.raw as WireItem);
    }
  }
  return items;
}

export function xaiRequestBody(req: AiRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input: toWireInput(req),
    max_output_tokens: req.maxTokens,
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (req.tools?.length)
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  if (stream) body.stream = true;
  return body;
}

type WireResponse = {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: WireItem[];
  usage?: WireUsage;
  error?: { message?: string } | null;
};

type WireUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

function fromWireOutput(output: WireItem[]): AiContentBlock[] {
  const out: AiContentBlock[] = [];
  for (const item of output) {
    if (item.type === "message") {
      const text = ((item.content as WireItem[] | undefined) ?? [])
        .filter((p) => p.type === "output_text")
        .map((p) => String(p.text ?? ""))
        .join("");
      if (text) out.push({ type: "text", text });
    } else if (item.type === "function_call")
      out.push({
        type: "tool_use",
        id: String(item.call_id ?? item.id),
        name: String(item.name),
        input: parseToolInput(String(item.arguments ?? "")),
      });
    else out.push({ type: "opaque", provider: "xai", raw: item });
  }
  return out;
}

function stopReasonOf(res: WireResponse, content: AiContentBlock[]): AiStopReason {
  if (res.status === "incomplete")
    return res.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "other";
  const refused = (res.output ?? []).some(
    (i) =>
      i.type === "message" &&
      ((i.content as WireItem[] | undefined) ?? []).some((p) => p.type === "refusal"),
  );
  if (refused) return "refusal";
  return content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
}

/** xAI counts cached tokens inside `input_tokens`; ours keeps them apart. */
function usageOf(u: WireUsage | undefined): AiUsageCount {
  if (!u) return emptyUsage();
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.input_tokens ?? 0) - cached),
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function toResponse(json: WireResponse, model: string): AiResponse {
  const content = fromWireOutput(json.output ?? []);
  return {
    model: json.model ?? model,
    content,
    stopReason: stopReasonOf(json, content),
    usage: usageOf(json.usage),
  };
}

export class XaiProvider implements AiProvider {
  readonly name = "xai" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: XaiConfig) {
    this.fetchImpl = config.fetch ?? ((...args) => fetch(...args));
  }

  private post(req: AiRequest, stream: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.gateway?.token)
      headers["cf-aig-authorization"] = `Bearer ${this.config.gateway.token}`;
    return postWithRetries({
      fetch: this.fetchImpl,
      url: `${xaiBaseUrl(this.config.gateway)}/v1/responses`,
      headers,
      body: JSON.stringify(xaiRequestBody(req, stream)),
      signal: req.signal,
      maxRetries: this.config.maxRetries,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const res = await this.post(req, false);
    const json = (await res.json()) as WireResponse;
    if (json.status === "failed")
      throw new AiProviderError(`The AI provider failed: ${json.error?.message ?? "unknown"}`);
    return toResponse(json, req.model);
  }

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const res = await this.post(req, true);
    if (!res.body) throw new AiProviderError("The AI provider sent an empty stream.");

    // Items by output index as they finish; the final response event carries them all too.
    const items: WireItem[] = [];
    let final: WireResponse | null = null;

    for await (const { data } of parseSse(res.body)) {
      if (!data || data === "[DONE]") continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (msg.type) {
        case "response.output_text.delta": {
          const text = String(msg.delta ?? "");
          if (text) yield { type: "text", text };
          break;
        }
        case "response.output_item.added": {
          const item = msg.item as WireItem | undefined;
          if (item?.type === "function_call")
            yield {
              type: "tool_use_start",
              id: String(item.call_id ?? item.id),
              name: String(item.name),
            };
          break;
        }
        case "response.output_item.done": {
          const item = msg.item as WireItem | undefined;
          if (item) items[Number(msg.output_index ?? items.length)] = item;
          break;
        }
        case "response.completed":
        case "response.incomplete":
          final = (msg.response as WireResponse | undefined) ?? null;
          break;
        case "response.failed": {
          const r = msg.response as WireResponse | undefined;
          throw new AiProviderError(`The AI provider failed: ${r?.error?.message ?? "unknown"}`);
        }
        case "error": {
          const e = (msg.error as { message?: string } | undefined) ?? msg;
          throw new AiProviderError(
            `The AI provider stopped: ${String((e as { message?: string }).message ?? "unknown error")}`,
          );
        }
      }
    }

    const json: WireResponse = final?.output?.length
      ? final
      : { ...final, status: final?.status ?? "completed", output: items.filter(Boolean) };
    yield { type: "done", response: toResponse(json, req.model) };
  }
}
