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
 * GroqCloud (open models such as gpt-oss and Llama on Groq's LPUs) through its
 * OpenAI-compatible Chat Completions API (`/openai/v1/chat/completions`), over plain `fetch`.
 * Through the Cloudflare AI Gateway when it is set. Not xAI's Grok: see providers/xai.ts.
 */

export type GroqConfig = {
  apiKey: string;
  gateway?: { accountId: string; name: string; token?: string | null } | null;
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
};

export function groqBaseUrl(gateway: GroqConfig["gateway"]): string {
  return gatewayBase(gateway, "groq") ?? "https://api.groq.com/openai/v1";
}

type WireMessage = Record<string, unknown> & { role: string };
type WireToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function toWireMessages(req: AiRequest): WireMessage[] {
  const out: WireMessage[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "user") {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of m.content) {
        if (b.type === "tool_result")
          out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
        else if (b.type === "text" && b.text.trim()) parts.push({ type: "text", text: b.text });
        else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: b.url } });
      }
      if (parts.length)
        out.push({
          role: "user",
          content: parts.every((p) => p.type === "text")
            ? parts.map((p) => String(p.text)).join("\n\n")
            : parts,
        });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const calls: WireToolCall[] = m.content
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        const u = b as { id: string; name: string; input: unknown };
        return {
          id: u.id,
          type: "function",
          function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
        };
      });
    if (!text.trim() && calls.length === 0) continue;
    out.push({
      role: "assistant",
      content: text.trim() ? text : null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  return out;
}

type Schema = Record<string, unknown>;

/**
 * Groq checks tool arguments against the schema itself, and open models often send `null` for
 * a field they leave out ("maxPrice": null), which Groq then refuses. Optional fields may be
 * null in what Groq sees; `withoutNulls` drops them again before our own validation.
 */
export function nullableOptionals(schema: Schema): Schema {
  const out: Schema = { ...schema };
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const required = new Set((schema.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, Schema>).map(([k, v]) => {
        const inner = nullableOptionals(v);
        if (required.has(k)) return [k, inner];
        if (typeof inner.type === "string") return [k, { ...inner, type: [inner.type, "null"] }];
        if (Array.isArray(inner.anyOf))
          return [k, { ...inner, anyOf: [...inner.anyOf, { type: "null" }] }];
        return [k, { anyOf: [inner, { type: "null" }] }];
      }),
    );
  }
  if (schema.type === "array" && schema.items && typeof schema.items === "object")
    out.items = nullableOptionals(schema.items as Schema);
  return out;
}

/** Null-valued fields removed (left out, as our tool schemas expect). */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, withoutNulls(v)]),
    );
  return value;
}

export function groqRequestBody(req: AiRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toWireMessages(req),
    max_completion_tokens: req.maxTokens,
  };
  if (req.tools?.length)
    body.tools = req.tools.map((t) => {
      const { $schema: _drop, ...parameters } = t.inputSchema;
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: nullableOptionals(parameters),
        },
      };
    });
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

type WireUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
};

/** Groq counts cached tokens inside `prompt_tokens`; ours keeps them apart. */
function usageOf(u: WireUsage | undefined | null): AiUsageCount {
  if (!u) return emptyUsage();
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function stopOf(finish: string | null | undefined, content: AiContentBlock[]): AiStopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (content.some((b) => b.type === "tool_use")) return "tool_use";
  return finish === "stop" || !finish ? "end_turn" : "other";
}

function blocksOf(text: string, calls: WireToolCall[]): AiContentBlock[] {
  const out: AiContentBlock[] = [];
  if (text) out.push({ type: "text", text });
  for (const c of calls)
    out.push({
      type: "tool_use",
      id: c.id,
      name: c.function.name,
      input: withoutNulls(parseToolInput(c.function.arguments ?? "")),
    });
  return out;
}

export class GroqProvider implements AiProvider {
  readonly name = "groq" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GroqConfig) {
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
      url: `${groqBaseUrl(this.config.gateway)}/chat/completions`,
      headers,
      body: JSON.stringify(groqRequestBody(req, stream)),
      signal: req.signal,
      maxRetries: this.config.maxRetries,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const res = await this.post(req, false);
    const json = (await res.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: WireToolCall[] };
        finish_reason?: string;
      }>;
      usage?: WireUsage;
    };
    const choice = json.choices?.[0];
    const content = blocksOf(choice?.message?.content ?? "", choice?.message?.tool_calls ?? []);
    return {
      model: json.model ?? req.model,
      content,
      stopReason: stopOf(choice?.finish_reason, content),
      usage: usageOf(json.usage),
    };
  }

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const res = await this.post(req, true);
    if (!res.body) throw new AiProviderError("The AI provider sent an empty stream.");
    let model = req.model;
    let text = "";
    let finish: string | null = null;
    let usage: WireUsage | null = null;
    // Tool calls arrive in pieces by index: the id and name first, the arguments in fragments.
    const calls: WireToolCall[] = [];

    for await (const { data } of parseSse(res.body)) {
      if (!data || data === "[DONE]") continue;
      let chunk: {
        model?: string;
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: WireUsage | null;
        x_groq?: { usage?: WireUsage; error?: { message?: string } };
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      const error = chunk.error ?? chunk.x_groq?.error;
      if (error)
        throw new AiProviderError(`The AI provider stopped: ${error.message ?? "unknown"}`);
      if (chunk.model) model = chunk.model;
      usage = chunk.usage ?? chunk.x_groq?.usage ?? usage;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const delta = choice?.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text", text: delta.content };
      }
      for (const part of delta?.tool_calls ?? []) {
        const call = (calls[part.index] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (part.id) call.id = part.id;
        if (part.function?.name) {
          call.function.name = part.function.name;
          yield {
            type: "tool_use_start",
            id: call.id || `call_${part.index}`,
            name: call.function.name,
          };
        }
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
      }
    }
    const done = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    const content = blocksOf(text, done);
    yield {
      type: "done",
      response: { model, content, stopReason: stopOf(finish, content), usage: usageOf(usage) },
    };
  }
}
