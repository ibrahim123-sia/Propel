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
import { gatewayBase, postWithRetries } from "./http";
import { parseSse } from "./sse";

/**
 * Gemini through the Gemini API (`generateContent` / `streamGenerateContent`) over plain
 * `fetch`. Tool schemas go as JSON Schema (`parametersJsonSchema`). Through the Cloudflare AI
 * Gateway when it is set.
 *
 * Two Gemini rules the layer has to keep:
 * - a tool result names its tool (`functionResponse.name`), so the name is looked up from the
 *   call earlier in the conversation;
 * - Gemini 3 signs its tool calls (`thoughtSignature`) and wants the signature back with them.
 *   It is kept in an opaque block next to the call. A call another provider made (after a
 *   fallback) has none and is sent with the documented placeholder that skips the check.
 */

export type GeminiConfig = {
  apiKey: string;
  gateway?: { accountId: string; name: string; token?: string | null } | null;
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
};

export function geminiBaseUrl(gateway: GeminiConfig["gateway"]): string {
  return gatewayBase(gateway, "google-ai-studio") ?? "https://generativelanguage.googleapis.com";
}

/** Gemini did not give the call an id: ours is made up and never sent back. */
const LOCAL_ID = "gemini-local-";
const SKIP_SIGNATURE = "skip_thought_signature_validator";
/** Photos the model looks at (alt text): sent inline, so one large file cannot run away. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };
type SignatureNote = { signatureFor: string; thoughtSignature: string };

/** Gemini 1.x and 2.x neither sign tool calls nor take a thinking level. */
const signsToolCalls = (model: string) => !/^gemini-[12](\.|-|$)/.test(model);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function inlineImage(fetchImpl: typeof fetch, url: string): Promise<Part | null> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0]!.trim();
    return { inlineData: { mimeType, data: toBase64(bytes) } };
  } catch {
    return null;
  }
}

export async function geminiRequestBody(
  req: AiRequest,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Record<string, unknown>> {
  const toolNames = new Map<string, string>();
  for (const m of req.messages)
    for (const b of m.content) if (b.type === "tool_use") toolNames.set(b.id, b.name);

  const contents: Content[] = [];
  for (const m of req.messages) {
    const parts: Part[] = [];
    const signatures = new Map(
      m.content
        .filter((b) => b.type === "opaque" && b.provider === "gemini")
        .map((b) => (b as { raw: SignatureNote }).raw)
        .map((n) => [n.signatureFor, n.thoughtSignature] as const),
    );
    for (const b of m.content) {
      if (b.type === "text") {
        if (b.text.trim()) parts.push({ text: b.text });
      } else if (b.type === "image") {
        const image = await inlineImage(fetchImpl, b.url);
        if (image) parts.push(image);
      } else if (b.type === "tool_use") {
        const call: Part = { name: b.name, args: b.input ?? {} };
        if (!b.id.startsWith(LOCAL_ID)) call.id = b.id;
        const part: Part = { functionCall: call };
        const signature =
          signatures.get(b.id) ?? (signsToolCalls(req.model) ? SKIP_SIGNATURE : undefined);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      } else if (b.type === "tool_result") {
        const response: Part = {
          name: toolNames.get(b.toolUseId) ?? "tool",
          response: b.isError ? { error: b.content } : { result: b.content },
        };
        if (!b.toolUseId.startsWith(LOCAL_ID)) response.id = b.toolUseId;
        parts.push({ functionResponse: response });
      }
    }
    if (parts.length) contents.push({ role: m.role === "user" ? "user" : "model", parts });
  }

  const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
  if (req.effort && signsToolCalls(req.model))
    generationConfig.thinkingConfig = { thinkingLevel: req.effort === "low" ? "low" : "high" };
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    generationConfig,
  };
  if (req.tools?.length)
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const { $schema: _drop, ...schema } = t.inputSchema;
          return { name: t.name, description: t.description, parametersJsonSchema: schema };
        }),
      },
    ];
  return body;
}

type WireChunk = {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
};

const REFUSALS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

function stopReasonOf(
  finish: string | undefined,
  blocked: boolean,
  content: AiContentBlock[],
): AiStopReason {
  if (blocked || (finish && REFUSALS.has(finish))) return "refusal";
  if (finish === "MAX_TOKENS") return "max_tokens";
  if (content.some((b) => b.type === "tool_use")) return "tool_use";
  return finish === "STOP" || !finish ? "end_turn" : "other";
}

/** Gemini counts cached tokens inside the prompt and thinking apart from the answer. */
function usageOf(u: WireChunk["usageMetadata"]): AiUsageCount {
  if (!u) return emptyUsage();
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/** Turns response parts into blocks; `counter` numbers calls Gemini gave no id. */
function partsToBlocks(parts: Part[], counter: { n: number }): AiContentBlock[] {
  const out: AiContentBlock[] = [];
  for (const p of parts) {
    if (p.thought) continue;
    if (typeof p.text === "string") {
      const last = out[out.length - 1];
      if (last?.type === "text") last.text += p.text;
      else if (p.text) out.push({ type: "text", text: p.text });
    } else if (p.functionCall) {
      const call = p.functionCall as { id?: string; name?: string; args?: unknown };
      const id = call.id || `${LOCAL_ID}${++counter.n}`;
      out.push({ type: "tool_use", id, name: String(call.name), input: call.args ?? {} });
      if (typeof p.thoughtSignature === "string")
        out.push({
          type: "opaque",
          provider: "gemini",
          raw: { signatureFor: id, thoughtSignature: p.thoughtSignature } satisfies SignatureNote,
        });
    }
  }
  return out;
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GeminiConfig) {
    this.fetchImpl = config.fetch ?? ((...args) => fetch(...args));
  }

  private async post(req: AiRequest, stream: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-goog-api-key": this.config.apiKey,
    };
    if (this.config.gateway?.token)
      headers["cf-aig-authorization"] = `Bearer ${this.config.gateway.token}`;
    const model = encodeURIComponent(req.model);
    const url = `${geminiBaseUrl(this.config.gateway)}/v1beta/models/${model}:${
      stream ? "streamGenerateContent?alt=sse" : "generateContent"
    }`;
    return postWithRetries({
      fetch: this.fetchImpl,
      url,
      headers,
      body: JSON.stringify(await geminiRequestBody(req, this.fetchImpl)),
      signal: req.signal,
      maxRetries: this.config.maxRetries,
      timeoutMs: this.config.timeoutMs,
    });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const res = await this.post(req, false);
    const json = (await res.json()) as WireChunk;
    const candidate = json.candidates?.[0];
    const content = partsToBlocks(candidate?.content?.parts ?? [], { n: 0 });
    return {
      model: json.modelVersion ?? req.model,
      content,
      stopReason: stopReasonOf(
        candidate?.finishReason,
        Boolean(json.promptFeedback?.blockReason),
        content,
      ),
      usage: usageOf(json.usageMetadata),
    };
  }

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const res = await this.post(req, true);
    if (!res.body) throw new AiProviderError("The AI provider sent an empty stream.");

    const parts: Part[] = [];
    let finish: string | undefined;
    let blocked = false;
    let usage: WireChunk["usageMetadata"];
    let model = req.model;
    const counter = { n: 0 };

    for await (const { data } of parseSse(res.body)) {
      if (!data) continue;
      let chunk: WireChunk & { error?: { message?: string } };
      try {
        chunk = JSON.parse(data) as typeof chunk;
      } catch {
        continue;
      }
      if (chunk.error)
        throw new AiProviderError(`The AI provider stopped: ${chunk.error.message ?? "unknown"}`);
      if (chunk.modelVersion) model = chunk.modelVersion;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      if (chunk.promptFeedback?.blockReason) blocked = true;
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      for (const p of candidate?.content?.parts ?? []) {
        parts.push(p);
        if (p.thought) continue;
        if (typeof p.text === "string" && p.text) yield { type: "text", text: p.text };
        else if (p.functionCall) {
          const call = p.functionCall as { id?: string; name?: string };
          yield {
            type: "tool_use_start",
            id: call.id || `${LOCAL_ID}${counter.n + 1}`,
            name: String(call.name),
          };
          counter.n++;
        }
      }
    }

    const content = partsToBlocks(parts, { n: 0 });
    yield {
      type: "done",
      response: {
        model,
        content,
        stopReason: stopReasonOf(finish, blocked, content),
        usage: usageOf(usage),
      },
    };
  }
}
