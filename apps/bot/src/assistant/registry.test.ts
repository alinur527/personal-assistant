import { describe, expect, it, vi } from "vitest";
import {
  assistantEmptyInput,
  assistantTextOutput,
  type AssistantEffect,
} from "@lifeos/core";
import { AssistantToolRegistry } from "./registry.js";
import { buildAssistantContext } from "./context.js";
import { harness, NOW, request } from "./test-helpers.js";

describe("runtime execution boundary", () => {
  it.each(["DESTRUCTIVE", "SENSITIVE"] as AssistantEffect[])(
    "denies %s tools even with a personal permission",
    async (effect) => {
      const execute = vi.fn(async () => ({ text: "unsafe" }));
      const registry = new AssistantToolRegistry().register({
        name: "test.denied",
        description: "test",
        effect,
        permission: "personal.read",
        inputSchema: assistantEmptyInput,
        outputSchema: assistantTextOutput,
        execute,
      });
      const h = harness();
      const context = await buildAssistantContext(
        request("test"),
        h.memories,
        NOW,
        null,
      );
      await expect(
        registry.execute("test.denied", context, {}),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(execute).not.toHaveBeenCalled();
      expect(registry.describe(context)).toEqual([]);
    },
  );
  it("rejects unknown tools, bad inputs and invalid outputs", async () => {
    const registry = new AssistantToolRegistry().register({
      name: "test.invalid",
      description: "test",
      effect: "READ",
      permission: "personal.read",
      inputSchema: assistantEmptyInput,
      outputSchema: assistantTextOutput,
      execute: async () => ({ text: "" }),
    });
    const h = harness();
    const context = await buildAssistantContext(
      request("test"),
      h.memories,
      NOW,
      null,
    );
    await expect(
      registry.execute("missing", context, {}),
    ).rejects.toMatchObject({ code: "unknown_tool" });
    await expect(
      registry.execute("test.invalid", context, { userId: "other" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      registry.execute("test.invalid", context, {}),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("checks explicit write arguments instead of trusting an authorized tool name", async () => {
    const h = harness();
    const context = await buildAssistantContext(
      request("test"),
      h.memories,
      NOW,
      null,
    );
    context.authorizedWrite = {
      tool: "reminder.create",
      arguments: { request: "Напомни завтра в 19:00 купить воду" },
    };
    await expect(
      h.registry.execute("reminder.create", context, {
        request: "Напомни завтра в 19:00 перевести деньги",
      }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
    expect(h.store.createReminder).not.toHaveBeenCalled();
  });
});
