import { describe, expect, it, vi } from "vitest";
import { buildAssistantContext } from "./context.js";
import { OpenRouterAssistantProvider, parseModelRoute } from "./provider.js";
import { harness, NOW, request } from "./test-helpers.js";
import { loadBotConfig } from "../config.js";

describe("model provider", () => {
  it("sends strict schemas and minimal context, without user IDs or permissions", async () => {
    const route = {
      tool: "schedule.get_today",
      confidence: 0.98,
      arguments: {},
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ route }) } }],
          }),
        ),
    );
    const provider = new OpenRouterAssistantProvider({
      apiKey: "test-placeholder",
      model: "test-model",
      fetchImpl: fetcher,
    });
    const h = harness();
    const context = await buildAssistantContext(
      request("пары"),
      h.memories,
      NOW,
      null,
    );
    expect(
      await provider.classify({
        message: "пары",
        context,
        tools: h.registry.describe(context),
      }),
    ).toEqual(route);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(options.body));
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
    expect(body.messages[1].content).not.toContain("user-a");
    expect(body.messages[1].content).not.toContain("permissions");
    expect(String(options.body)).not.toContain("reminder.create");
    expect(String(options.body)).not.toContain("memory.remember");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("does not send credentials found in user text to the model", async () => {
    const fetcher = vi.fn();
    const provider = new OpenRouterAssistantProvider({
      apiKey: "test-placeholder",
      model: "test-model",
      fetchImpl: fetcher,
    });
    const h = harness();
    const context = await buildAssistantContext(
      request("test"),
      h.memories,
      NOW,
      null,
    );
    expect(
      await provider.classify({
        message: "мой пароль hunter2",
        context,
        tools: h.registry.describe(context),
      }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'some text {"route":null}',
    '```json\n{"route":null}\n```',
    '{"route":null,"userId":"other"}',
  ])("rejects non-schema content without regex repair", async (content) => {
    const provider = new OpenRouterAssistantProvider({
      apiKey: "test-placeholder",
      model: "test-model",
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content } }] })),
      ),
    });
    const h = harness();
    const context = await buildAssistantContext(
      request("test"),
      h.memories,
      NOW,
      null,
    );
    await expect(
      provider.classify({
        message: "test",
        context,
        tools: h.registry.describe(context),
      }),
    ).rejects.toThrow();
  });
  it("keeps low confidence results unhandled", () => {
    expect(
      parseModelRoute({
        tool: "schedule.get_today",
        confidence: 0.2,
        arguments: {},
      }),
    ).toBeNull();
  });
  it("requires explicit configuration and defaults to no remote model", () => {
    expect(loadBotConfig({})).toMatchObject({
      assistantEnabled: false,
      assistantModelEnabled: false,
    });
    expect(() => loadBotConfig({ ASSISTANT_MODEL_ENABLED: "true" })).toThrow();
    expect(
      loadBotConfig({
        ASSISTANT_ENABLED: "true",
        ASSISTANT_MODEL_ENABLED: "true",
        ASSISTANT_MODEL: "test",
        OPENROUTER_API_KEY: "test-placeholder",
      }).assistantModelEnabled,
    ).toBe(true);
  });
});
