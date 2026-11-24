import { describe, expect, it } from "vitest";
import { bindingFetch, WORKERS_AI_BINDING_URL } from "@/features/ai/binding";
import { GroqProvider } from "@/features/ai/providers/groq";
import { AiProviderError, type AiRequest, type AiStreamEvent } from "@/features/ai/types";

/**
 * Workers AI on the Worker's `AI` binding: the Chat Completions client talks to it through a
 * fetch that hands the same body to `AI.run` and reads the same JSON or events back.
 */

const request = (over: Partial<AiRequest> = {}): AiRequest => ({
  model: "@cf/openai/gpt-oss-120b",
  system: "You help find homes.",
  messages: [{ role: "user", content: [{ type: "text", text: "A two-bed in the Marina" }] }],
  maxTokens: 400,
  tools: [
    {
      name: "search_properties",
      description: "Search listings",
      inputSchema: { type: "object", properties: { area: { type: "string" } } },
    },
  ],
  ...over,
});

function fakeBinding(answer: (model: string, input: Record<string, unknown>) => unknown) {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    binding: {
      run: async (model: string, input: Record<string, unknown>) => {
        calls.push({ model, input });
        return answer(model, input);
      },
    },
  };
}

const provider = (binding: { run: (m: string, i: Record<string, unknown>) => Promise<unknown> }) =>
  new GroqProvider({
    apiKey: "",
    baseUrl: WORKERS_AI_BINDING_URL,
    name: "workers_ai",
    fetch: bindingFetch(binding),
    maxRetries: 0,
  });

describe("Workers AI through the AI binding", () => {
  it("passes the model apart and reads tool calls from the answer", async () => {
    const { binding, calls } = fakeBinding(() => ({
      model: "@cf/openai/gpt-oss-120b",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search_properties", arguments: '{"area":"Dubai Marina"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 143, completion_tokens: 65 },
    }));
    const res = await provider(binding).complete(request());
    expect(calls[0].model).toBe("@cf/openai/gpt-oss-120b");
    expect(calls[0].input.model).toBeUndefined();
    expect(calls[0].input.messages).toEqual([
      { role: "system", content: "You help find homes." },
      { role: "user", content: "A two-bed in the Marina" },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "search_properties",
        input: { area: "Dubai Marina" },
      },
    ]);
    expect(res.usage.inputTokens).toBe(143);
  });

  it("streams the binding's events, with the totals from the last one", async () => {
    const lines = [
      { choices: [{ delta: { role: "assistant", content: "" } }], usage: { prompt_tokens: 191 } },
      { choices: [{ delta: { reasoning: "Thinking" } }], usage: { completion_tokens: 1 } },
      { choices: [{ delta: { content: "Two homes " } }] },
      { choices: [{ delta: { content: "match." }, finish_reason: "stop" }] },
      { response: "", usage: { prompt_tokens: 191, completion_tokens: 209 } },
    ];
    const body = lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n";
    const { binding, calls } = fakeBinding(
      () =>
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
    );
    const events: AiStreamEvent[] = [];
    for await (const e of provider(binding).stream(request())) events.push(e);
    expect(calls[0].input.stream).toBe(true);
    expect(
      events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text),
    ).toEqual(["Two homes ", "match."]);
    const done = events.at(-1) as Extract<AiStreamEvent, { type: "done" }>;
    expect(done.response.usage).toMatchObject({ inputTokens: 191, outputTokens: 209 });
  });

  it("turns a binding error into a provider error the backup can take over", async () => {
    const { binding } = fakeBinding(() => {
      throw new Error("3040: Capacity temporarily exceeded, please try again.");
    });
    const err = await provider(binding)
      .complete(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).status).toBe(429);
    expect((err as AiProviderError).retryable).toBe(true);
  });
});
