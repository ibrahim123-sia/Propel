import { describe, expect, it } from "vitest";
import { FallbackProvider } from "@/features/ai/providers/fallback";
import { GeminiProvider, geminiBaseUrl, geminiRequestBody } from "@/features/ai/providers/gemini";
import { GroqProvider, groqBaseUrl, groqRequestBody } from "@/features/ai/providers/groq";
import { MockProvider, resetMock, scriptMockReplies } from "@/features/ai/providers/mock";
import { XaiProvider, xaiBaseUrl, xaiRequestBody } from "@/features/ai/providers/xai";
import { priceFor } from "@/features/ai/pricing";
import {
  AiProviderError,
  type AiMessage,
  type AiRequest,
  type AiStreamEvent,
} from "@/features/ai/types";

const encoder = new TextEncoder();
const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(text));
      c.close();
    },
  });
const dataEvents = (events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

/** A conversation with one tool round: the question, a call, its result. */
const toolRound: AiMessage[] = [
  { role: "user", content: [{ type: "text", text: "Two beds in the Marina?" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "call_1", name: "search_listings", input: { beds: 2 } },
    ],
  },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "call_1", content: "<result>3 homes</result>" }],
  },
];

const request = (over: Partial<AiRequest> = {}): AiRequest => ({
  model: "grok-4.7",
  system: "You are a test.",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  maxTokens: 1000,
  ...over,
});

const tools = [
  {
    name: "search_listings",
    description: "Search homes",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { beds: { type: "integer" } },
    },
  },
];

describe("xAI provider (Grok, Responses API)", () => {
  it("sends the whole conversation, stores nothing and maps tools and results", () => {
    const body = xaiRequestBody(request({ messages: toolRound, tools }), false);
    expect(body).toMatchObject({
      model: "grok-4.7",
      instructions: "You are a test.",
      max_output_tokens: 1000,
      store: false,
      include: ["reasoning.encrypted_content"],
      tools: [{ type: "function", name: "search_listings", description: "Search homes" }],
    });
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Two beds in the Marina?" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Let me look." }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "search_listings",
        arguments: '{"beds":2}',
      },
      { type: "function_call_output", call_id: "call_1", output: "<result>3 homes</result>" },
    ]);
    expect(body.stream).toBeUndefined();
  });

  it("answers with text, tool calls, reasoning kept opaque, and cached tokens apart", async () => {
    expect(xaiBaseUrl(null)).toBe("https://api.x.ai");
    expect(xaiBaseUrl({ accountId: "acc", name: "gw" })).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc/gw/grok",
    );
    const reasoning = { type: "reasoning", encrypted_content: "enc", summary: [] };
    const { fn, calls } = fakeFetch([
      () =>
        Response.json({
          model: "grok-4.7",
          status: "completed",
          output: [
            reasoning,
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Searching." }],
            },
            {
              type: "function_call",
              call_id: "call_9",
              name: "search_listings",
              arguments: '{"beds":2}',
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 100 },
          },
        }),
    ]);
    const res = await new XaiProvider({ apiKey: "xai-k", fetch: fn }).complete(request({ tools }));
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/responses");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer xai-k");
    expect(res).toEqual({
      model: "grok-4.7",
      content: [
        { type: "opaque", provider: "xai", raw: reasoning },
        { type: "text", text: "Searching." },
        { type: "tool_use", id: "call_9", name: "search_listings", input: { beds: 2 } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 },
    });
    // The reasoning item goes back as it came in the next request of the loop.
    const next = xaiRequestBody(
      request({ messages: [request().messages[0]!, { role: "assistant", content: res.content }] }),
      false,
    );
    expect(next.input).toContainEqual(reasoning);
  });

  it("reports a cut-off answer as max_tokens", async () => {
    const { fn } = fakeFetch([
      () =>
        Response.json({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", content: [{ type: "output_text", text: "Half" }] }],
        }),
    ]);
    const res = await new XaiProvider({ apiKey: "k", fetch: fn }).complete(request());
    expect(res.stopReason).toBe("max_tokens");
  });

  it("streams text deltas and announces tool calls, ending with the whole response", async () => {
    const call = { type: "function_call", call_id: "c1", name: "search_listings", arguments: "{}" };
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hi there" }],
    };
    const body = dataEvents([
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, delta: "Hi " },
      { type: "response.output_text.delta", output_index: 0, delta: "there" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.output_item.done", output_index: 1, item: call },
      {
        type: "response.completed",
        response: {
          model: "grok-4.7",
          status: "completed",
          output: [message, call],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);
    const { fn } = fakeFetch([() => new Response(streamOf(body))]);
    const events: AiStreamEvent[] = [];
    for await (const e of new XaiProvider({ apiKey: "k", fetch: fn }).stream(request()))
      events.push(e);
    expect(events.slice(0, 3)).toEqual([
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "tool_use_start", id: "c1", name: "search_listings" },
    ]);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.response.stopReason).toBe("tool_use");
    expect(done.response.content).toEqual([
      { type: "text", text: "Hi there" },
      { type: "tool_use", id: "c1", name: "search_listings", input: {} },
    ]);
  });

  it("turns a failed stream into a provider error", async () => {
    const body = dataEvents([
      { type: "response.failed", response: { status: "failed", error: { message: "No credit" } } },
    ]);
    const { fn } = fakeFetch([() => new Response(streamOf(body))]);
    const run = async () => {
      for await (const e of new XaiProvider({ apiKey: "k", fetch: fn }).stream(request())) void e;
    };
    await expect(run()).rejects.toThrow(/No credit/);
  });
});

describe("Gemini provider", () => {
  it("names tool results after their call and sends schemas as JSON Schema", async () => {
    const body = await geminiRequestBody(
      request({ model: "gemini-3.8-flash", messages: toolRound, tools, effort: "low" }),
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are a test." }] });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "search_listings",
            description: "Search homes",
            parametersJsonSchema: { type: "object", properties: { beds: { type: "integer" } } },
          },
        ],
      },
    ]);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Two beds in the Marina?" }] },
      {
        role: "model",
        parts: [
          { text: "Let me look." },
          // Another provider made this call: Gemini 3 gets the placeholder signature.
          {
            functionCall: { name: "search_listings", args: { beds: 2 }, id: "call_1" },
            thoughtSignature: "skip_thought_signature_validator",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "search_listings",
              response: { result: "<result>3 homes</result>" },
              id: "call_1",
            },
          },
        ],
      },
    ]);
    // Gemini 2.x: no thinking level, no signatures.
    const old = await geminiRequestBody(
      request({ model: "gemini-2.5-flash", messages: toolRound, effort: "high" }),
    );
    expect(old.generationConfig).toEqual({ maxOutputTokens: 1000 });
    expect(JSON.stringify(old.contents)).not.toContain("thoughtSignature");
  });

  it("keeps Gemini's signature with its call and never sends back an id it did not give", async () => {
    expect(geminiBaseUrl(null)).toBe("https://generativelanguage.googleapis.com");
    const { fn, calls } = fakeFetch([
      () =>
        Response.json({
          modelVersion: "gemini-3.8-flash",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "Checking." },
                  {
                    functionCall: { name: "search_listings", args: { beds: 2 } },
                    thoughtSignature: "sig-abc",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 200,
            cachedContentTokenCount: 150,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
          },
        }),
    ]);
    const provider = new GeminiProvider({ apiKey: "g-k", fetch: fn });
    const res = await provider.complete(request({ model: "gemini-3.8-flash", tools }));
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-k");
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({
      inputTokens: 50,
      outputTokens: 50,
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
    });
    const call = res.content.find((b) => b.type === "tool_use")!;
    expect(call).toMatchObject({ name: "search_listings", input: { beds: 2 } });

    const next = await geminiRequestBody(
      request({
        model: "gemini-3.8-flash",
        messages: [
          request().messages[0]!,
          { role: "assistant", content: res.content },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: (call as { id: string }).id, content: "ok" },
            ],
          },
        ],
      }),
    );
    const contents = next.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[1]!.parts[1]).toEqual({
      functionCall: { name: "search_listings", args: { beds: 2 } },
      thoughtSignature: "sig-abc",
    });
    expect(contents[2]!.parts[0]).toEqual({
      functionResponse: { name: "search_listings", response: { result: "ok" } },
    });
  });

  it("treats a safety stop as a refusal", async () => {
    const { fn } = fakeFetch([
      () => Response.json({ candidates: [{ finishReason: "SAFETY" }] }),
      () => Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } }),
    ]);
    const provider = new GeminiProvider({ apiKey: "k", fetch: fn });
    expect((await provider.complete(request({ model: "gemini-3.8-flash" }))).stopReason).toBe(
      "refusal",
    );
    expect((await provider.complete(request({ model: "gemini-3.8-flash" }))).stopReason).toBe(
      "refusal",
    );
  });

  it("streams text chunks and tool calls", async () => {
    const body = dataEvents([
      { candidates: [{ content: { parts: [{ text: "Hi " }] } }] },
      { candidates: [{ content: { parts: [{ text: "there" }] } }] },
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { id: "fc1", name: "search_listings", args: {} } }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      },
    ]).replace("data: [DONE]\n\n", "");
    const { fn, calls } = fakeFetch([() => new Response(streamOf(body))]);
    const events: AiStreamEvent[] = [];
    for await (const e of new GeminiProvider({ apiKey: "k", fetch: fn }).stream(
      request({ model: "gemini-3.8-flash" }),
    ))
      events.push(e);
    expect(calls[0]!.url).toMatch(/:streamGenerateContent\?alt=sse$/);
    expect(events.slice(0, 3)).toEqual([
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "tool_use_start", id: "fc1", name: "search_listings" },
    ]);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.response.content).toEqual([
      { type: "text", text: "Hi there" },
      { type: "tool_use", id: "fc1", name: "search_listings", input: {} },
    ]);
    expect(done.response.usage.outputTokens).toBe(4);
  });
});

describe("Groq provider (OpenAI-compatible Chat Completions)", () => {
  it("maps the conversation, tools and tool results to chat messages", () => {
    const body = groqRequestBody(
      request({ model: "openai/gpt-oss-120b", messages: toolRound, tools }),
      false,
    );
    expect(body).toMatchObject({ model: "openai/gpt-oss-120b", max_completion_tokens: 1000 });
    expect(body.messages).toEqual([
      { role: "system", content: "You are a test." },
      { role: "user", content: "Two beds in the Marina?" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search_listings", arguments: '{"beds":2}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "<result>3 homes</result>" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_listings",
          description: "Search homes",
          parameters: { type: "object", properties: { beds: { type: "integer" } } },
        },
      },
    ]);
    expect(groqBaseUrl(null)).toBe("https://api.groq.com/openai/v1");
  });

  it("answers with tool calls, and streams text and tool calls built from pieces", async () => {
    const { fn, calls } = fakeFetch([
      () =>
        Response.json({
          model: "openai/gpt-oss-120b",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "c9",
                    type: "function",
                    function: { name: "search_listings", arguments: '{"beds":2}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        }),
      () =>
        new Response(
          streamOf(
            dataEvents([
              { choices: [{ delta: { content: "Hi " } }] },
              { choices: [{ delta: { content: "there" } }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "c1",
                          function: { name: "search_listings", arguments: '{"be' },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                choices: [
                  { delta: { tool_calls: [{ index: 0, function: { arguments: 'ds":2}' } }] } },
                ],
              },
              {
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                x_groq: { usage: { prompt_tokens: 10, completion_tokens: 4 } },
              },
            ]),
          ),
        ),
    ]);
    const p = new GroqProvider({ apiKey: "gsk_test", fetch: fn });
    const res = await p.complete(request({ model: "openai/gpt-oss-120b", tools }));
    expect(calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer gsk_test",
    );
    expect(res).toEqual({
      model: "openai/gpt-oss-120b",
      content: [{ type: "tool_use", id: "c9", name: "search_listings", input: { beds: 2 } }],
      stopReason: "tool_use",
      usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0 },
    });
    const events: AiStreamEvent[] = [];
    for await (const e of p.stream(request({ model: "openai/gpt-oss-120b" }))) events.push(e);
    expect(events.slice(0, 3)).toEqual([
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "tool_use_start", id: "c1", name: "search_listings" },
    ]);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.response.content).toEqual([
      { type: "text", text: "Hi there" },
      { type: "tool_use", id: "c1", name: "search_listings", input: { beds: 2 } },
    ]);
    expect(done.response.usage.outputTokens).toBe(4);
  });
});

describe("backup provider", () => {
  const failing = (status: number) => {
    const { fn } = fakeFetch([() => Response.json({ error: { message: "down" } }, { status })]);
    return new XaiProvider({ apiKey: "k", fetch: fn, maxRetries: 0 });
  };

  it("asks the backup, with its own model for the tier, when the main provider fails", async () => {
    resetMock();
    scriptMockReplies({ text: "From the backup" });
    const backup = new MockProvider();
    const provider = new FallbackProvider(
      failing(503),
      backup,
      { "grok-4.7": "mock-chat", "grok-fast": "mock-fast" },
      "mock-chat",
    );
    const res = await provider.complete(request({ model: "grok-fast" }));
    expect(res.content).toEqual([{ type: "text", text: "From the backup" }]);
    expect(res.model).toBe("mock:mock-fast");
  });

  it("streams from the backup only when nothing was said yet", async () => {
    resetMock();
    scriptMockReplies({ text: "Backup words" });
    const provider = new FallbackProvider(failing(401), new MockProvider(), {}, "mock-chat");
    const events: AiStreamEvent[] = [];
    for await (const e of provider.stream(request())) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "done", response: { model: "mock:mock-chat" } });

    const halfway: XaiProvider = Object.assign(Object.create(XaiProvider.prototype), {
      name: "xai",
      async *stream() {
        yield { type: "text", text: "Hel" };
        throw new AiProviderError("cut off", null, true);
      },
    });
    const after = new FallbackProvider(halfway, new MockProvider(), {}, "mock-chat");
    const run = async () => {
      for await (const e of after.stream(request())) void e;
    };
    await expect(run()).rejects.toThrow(/cut off/);
  });
});

describe("prices", () => {
  it("knows Grok and Gemini, and a versioned id takes its base model's price", () => {
    expect(priceFor("grok-4.7").output).toBe(6);
    expect(priceFor("gemini-3.8-flash").input).toBe(0.75);
    expect(priceFor("gemini-2.5-flash-001")).toEqual(priceFor("gemini-2.5-flash"));
    expect(priceFor("mock-chat").input).toBe(0);
  });
});
