import { describe, expect, it, vi } from "vitest";
import { formatScheduleMessage } from "@lifeos/core";
import { buildAssistantContext } from "./context.js";
import { harness, NOW, request, schedule } from "./test-helpers.js";

describe("AssistantBrain", () => {
  it("uses the existing schedule and formatter without model or memory fetch", async () => {
    const provider = { classify: vi.fn() };
    const h = harness(provider);
    const reply = await h.brain.handle(request("Что у меня завтра?"));
    expect(reply.text).toBe(
      formatScheduleMessage(
        "2026-09-29",
        schedule.getLessons("2026-09-29"),
        true,
      ),
    );
    expect(provider.classify).not.toHaveBeenCalled();
    expect(h.memories.retrieve).not.toHaveBeenCalled();
    expect(h.audit.finish).toHaveBeenCalledWith(
      "user-a",
      "request:1",
      expect.objectContaining({
        status: "succeeded",
        toolName: "schedule.get_tomorrow",
      }),
    );
    expect(JSON.stringify(vi.mocked(h.audit.begin).mock.calls)).not.toContain(
      "Что у меня",
    );
  });

  it("rejects inactive profiles before accessing storage", async () => {
    const h = harness();
    for (const status of ["pending", "blocked"] as const) {
      const input = request("Что завтра?");
      input.principal.status = status;
      expect((await h.brain.handle(input)).status).toBe("rejected");
    }
    expect(h.audit.begin).not.toHaveBeenCalled();
  });

  it("keeps owner-only schedule authorization", async () => {
    const h = harness();
    const input = request("Что завтра?");
    input.principal.permissions = ["personal.read"];
    expect((await h.brain.handle(input)).text).toContain("недоступен");
  });

  it("creates exactly one reminder for repeated Telegram delivery", async () => {
    const h = harness();
    const input = request("Напомни завтра в 19:00 купить воду");
    expect((await h.brain.handle(input)).text).toContain("Напоминание создано");
    await h.brain.handle(input);
    expect(h.store.createReminder).toHaveBeenCalledTimes(1);
    expect(h.reminders[0]).toMatchObject({
      userId: "user-a",
      message: "купить воду",
      remindAt: "2026-09-29T14:00:00.000Z",
    });
  });

  it.each([
    "Напомни завтра купить воду",
    "Напомни вечером сделать лабу",
    "Напомни сегодня в 07:00 выпить воду",
    "Напомни завтра в 25:70 купить воду",
  ])("does not guess a time: %s", async (message) => {
    const h = harness();
    expect((await h.brain.handle(request(message))).handled).toBe(true);
    expect(h.store.createReminder).not.toHaveBeenCalled();
  });

  it("keeps successful writes when finishing audit fails, without leaking errors", async () => {
    const h = harness();
    vi.mocked(h.audit.finish).mockRejectedValue(new Error("token SECRET"));
    const result = await h.brain.handle(
      request("Напомни через 30 минут сделать перерыв"),
    );
    expect(result.status).toBe("succeeded");
    expect(h.reminders).toHaveLength(1);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("SECRET");
  });

  it("fails closed before a write if durable dedupe cannot be claimed", async () => {
    const h = harness();
    vi.mocked(h.audit.begin).mockRejectedValue(new Error("database secret"));
    const reply = await h.brain.handle(
      request("Напомни завтра в 19:00 купить воду"),
    );
    expect(reply.text).toContain("Хранилище");
    expect(reply.text).not.toContain("secret");
    expect(h.store.createReminder).not.toHaveBeenCalled();
  });

  it("persists an explicit candidate, updates its key, isolates owners and archives", async () => {
    const h = harness();
    await h.brain.handle(request("Запомни: дорога занимает час", "1"));
    await h.brain.handle(
      request("Запомни: теперь дорога занимает 40 минут", "2"),
    );
    expect(h.records.size).toBe(1);
    expect(
      (await h.brain.handle(request("Покажи память", "3"))).text,
    ).toContain("40 минут");
    expect(
      (await h.brain.handle(request("Покажи память", "3", "user-b"))).text,
    ).not.toContain("40 минут");
    await h.brain.handle(request("Забудь commute.duration", "4"));
    expect(
      (await h.brain.handle(request("Покажи память", "5"))).text,
    ).toContain("пуста");
  });

  it("does not persist conversation, secrets or operational events as memory", async () => {
    const h = harness();
    expect((await h.brain.handle(request("интересная идея"))).handled).toBe(
      false,
    );
    await h.brain.handle(
      request("Запомни: fact personal.secret: мой пароль hunter2", "2"),
    );
    await h.brain.handle(
      request("Запомни: fact study.event: завтра пара в 12:00", "3"),
    );
    expect(h.memories.remember).not.toHaveBeenCalled();
  });

  it("uses a validated model route only for unknown phrasing", async () => {
    const classify = vi.fn(async () => ({
      tool: "schedule.get_next",
      confidence: 0.98,
      arguments: {},
    }));
    const h = harness({ classify });
    expect(
      (
        await h.brain.handle(
          request("Когда начинать собираться на следующую пару?"),
        )
      ).text,
    ).toContain("Следующая пара");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(h.memories.retrieve).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ limit: 4 }),
    );
  });

  it.each([
    { tool: "shell.exec", confidence: 1, arguments: {} },
    {
      tool: "reminder.create",
      confidence: 1,
      arguments: { request: "Напомни завтра в 19:00 купить воду" },
    },
    {
      tool: "schedule.get_today",
      confidence: 1,
      arguments: { userId: "user-b" },
    },
    { tool: "schedule.get_today", confidence: 2, arguments: {} },
    {
      tool: "memory.archive",
      confidence: 1,
      arguments: { key: "commute.duration" },
      permission: "admin",
    },
  ])("rejects hostile model output %#", async (output) => {
    const h = harness({ classify: vi.fn(async () => output) });
    const reply = await h.brain.handle(request("Необычный запрос"));
    expect(reply.status).toBe("failed");
    expect(h.store.createReminder).not.toHaveBeenCalled();
    expect(h.memories.archive).not.toHaveBeenCalled();
  });

  it("bounds and filters context even if a memory adapter returns another owner", async () => {
    const h = harness();
    await h.memories.remember(
      "user-b",
      {
        type: "fact",
        key: "commute.duration",
        content: "Дорога занимает час",
        importance: 1,
        confidence: 1,
      },
      "telegram",
    );
    vi.mocked(h.memories.retrieve).mockResolvedValue([...h.records.values()]);
    expect(
      (await buildAssistantContext(request("дорога"), h.memories, NOW, null))
        .relevantMemories,
    ).toEqual([]);
  });

  it("reports handler failures using stable codes and no raw payload", async () => {
    const h = harness();
    h.store.listGradeChanges.mockRejectedValue(new Error("password = ABC"));
    const reply = await h.brain.handle(request("Есть новые оценки?"));
    expect(reply.text).not.toContain("ABC");
    expect(h.audit.finish).toHaveBeenCalledWith(
      "user-a",
      "request:1",
      expect.objectContaining({ errorCode: "handler_error" }),
    );
  });
});
