import { describe, expect, it, vi } from "vitest";
import { TelegramHttpClient } from "./client.js";

describe("TelegramHttpClient.sendMessage", () => {
  it("accepts only Telegram's ok:true response and sends HTML", async () => {
    const fetchImpl = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        }),
    );
    const client = new TelegramHttpClient(
      "test-token",
      fetchImpl as typeof fetch,
    );
    await client.sendMessage({ chatId: 123, text: "Hello", timeoutMs: 1_000 });
    const request = fetchImpl.mock.calls[0]?.[1];
    expect(request).toBeDefined();
    expect(JSON.parse(request!.body as string)).toMatchObject({
      chat_id: 123,
      text: "Hello",
      parse_mode: "HTML",
    });
    expect(request!.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects Telegram ok:false even with HTTP 200", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request" }),
          { status: 200 },
        ),
    );
    const client = new TelegramHttpClient(
      "test-token",
      fetchImpl as typeof fetch,
    );
    await expect(
      client.sendMessage({ chatId: 123, text: "Hello" }),
    ).rejects.toThrow("Bad Request");
  });

  it("propagates network errors and aborts a timed-out schedule send", async () => {
    const network = new TelegramHttpClient(
      "test-token",
      vi.fn(async () => {
        throw new Error("network down");
      }) as typeof fetch,
    );
    await expect(
      network.sendMessage({ chatId: 123, text: "Hello" }),
    ).rejects.toThrow("network down");

    const hanging = new TelegramHttpClient(
      "test-token",
      vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      ) as typeof fetch,
    );
    await expect(
      hanging.sendMessage({ chatId: 123, text: "Hello", timeoutMs: 10 }),
    ).rejects.toBeDefined();
  });
});
