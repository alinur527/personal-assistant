import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { LifeOSStore } from "@lifeos/db";
import { handleTelegramUpdate } from "../telegram/commands.js";
import type { TelegramBotRuntime, TelegramUpdate } from "../telegram/types.js";
import { createBotServer } from "../server.js";
import { harness, NOW, schedule } from "./test-helpers.js";

function setup(status = "active", sender = 123) {
  const h = harness();
  const user = {
    userId: "user-a",
    telegramUserId: sender,
    timezone: "Asia/Qyzylorda",
    status,
    role: "user",
    displayName: "Test",
    username: null,
  };
  const captured: unknown[] = [];
  const store = {
    ...h.store,
    resolveTelegramUser: vi.fn(async () => user),
    createLifeEntityWithSync: vi.fn(async (input) => {
      captured.push(input);
      return { ...input, id: "capture-1", createdAt: NOW.toISOString() };
    }),
  } as unknown as LifeOSStore;
  const sent: string[] = [];
  const runtime: TelegramBotRuntime = {
    store,
    assistant: h.brain,
    schedule,
    scheduleOwnerTelegramId: 123,
    scheduleTimezone: "Asia/Qyzylorda",
    now: () => NOW,
    telegram: {
      async sendMessage(input) {
        sent.push(input.text);
      },
      async getFileUrl() {
        return "";
      },
    },
  };
  let next = 0;
  const update = (text: string, type = "private"): TelegramUpdate => ({
    update_id: ++next,
    message: {
      message_id: next,
      text,
      from: { id: sender },
      chat: { id: sender, type },
    },
  });
  return { ...h, store, runtime, sent, captured, update };
}

describe("Telegram assistant gateway", () => {
  it("produces the same answer as /tomorrow and preserves /schedule", async () => {
    const h = setup();
    await handleTelegramUpdate(h.update("/tomorrow"), h.runtime);
    const expected = h.sent.at(-1);
    await handleTelegramUpdate(h.update("Что у меня завтра?"), h.runtime);
    expect(h.sent.at(-1)).toBe(expected);
    await handleTelegramUpdate(h.update("/schedule"), h.runtime);
    expect(h.sent.at(-1)).toContain("Расписание на сегодня");
  });
  it.each(["pending", "blocked"])(
    "rejects %s before the assistant",
    async (status) => {
      const h = setup(status);
      const handle = vi.spyOn(h.brain, "handle");
      await handleTelegramUpdate(h.update("Что завтра?"), h.runtime);
      expect(handle).not.toHaveBeenCalled();
      expect(h.captured).toEqual([]);
    },
  );
  it("does not reveal the owner's schedule to another active user", async () => {
    const h = setup("active", 456);
    await handleTelegramUpdate(h.update("Что завтра?"), h.runtime);
    expect(h.sent.at(-1)).toContain("недоступен");
    expect(h.sent.at(-1)).not.toContain("2408");
  });
  it("keeps the assistant out of group conversations", async () => {
    const h = setup();
    const handle = vi.spyOn(h.brain, "handle");
    await handleTelegramUpdate(
      h.update("Какая следующая пара?", "group"),
      h.runtime,
    );
    expect(handle).not.toHaveBeenCalled();
  });
  it("preserves ordinary text capture and keeps notes out of memory", async () => {
    const h = setup();
    await handleTelegramUpdate(h.update("Идея для проекта"), h.runtime);
    expect(h.captured).toHaveLength(1);
    expect(h.memories.remember).not.toHaveBeenCalled();
  });
  it("prioritizes explicit reminder/memory requests over broad finance keywords", async () => {
    const h = setup();
    await handleTelegramUpdate(
      h.update("Напомни завтра в 19:00 оплатить такси"),
      h.runtime,
    );
    expect(h.reminders).toHaveLength(1);
    await handleTelegramUpdate(
      h.update("Запомни: goal personal.budget: Хочу придерживаться бюджета"),
      h.runtime,
    );
    expect(h.records.size).toBe(1);
  });
  it("does not repeat writes on duplicate updates", async () => {
    const h = setup();
    const update = h.update("Напомни завтра в 19:00 купить воду");
    await handleTelegramUpdate(update, h.runtime);
    await handleTelegramUpdate(update, h.runtime);
    expect(h.reminders).toHaveLength(1);
  });
  it("retains /remind parsing and its existing store path", async () => {
    const h = setup();
    await handleTelegramUpdate(
      h.update("/remind Read notes in:30m"),
      h.runtime,
    );
    expect(h.reminders[0]).toMatchObject({
      message: "Read notes",
      remindAt: "2026-09-28T05:30:00.000Z",
    });
  });
  it("keeps unknown text on the old path when assistant is disabled", async () => {
    const h = setup();
    h.runtime.assistant = undefined;
    await handleTelegramUpdate(h.update("Что завтра?"), h.runtime);
    expect(h.captured).toHaveLength(1);
    expect(h.audit.begin).not.toHaveBeenCalled();
  });
  it("runs through a real authenticated HTTP webhook and rejects a bad secret", async () => {
    const h = setup();
    const server = createBotServer({
      store: h.store,
      telegram: h.runtime.telegram,
      assistant: h.brain,
      schedule,
      config: {
        telegramWebhookSecret: "local-webhook-test",
        scheduleOwnerTelegramId: 123,
        scheduleTimezone: "Asia/Qyzylorda",
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/telegram/webhook`;
      const post = (secret: string) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify(h.update("Что завтра?")),
        });
      expect((await post("wrong")).status).toBe(401);
      expect(h.audit.begin).not.toHaveBeenCalled();
      expect((await post("local-webhook-test")).status).toBe(200);
      expect(h.sent.at(-1)).toContain("Расписание на завтра");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
