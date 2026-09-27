import { describe, expect, it } from "vitest";
import { ScheduleService, StaticScheduleProvider } from "@lifeos/core";
import type { LifeOSStore } from "@lifeos/db";
import { loadBotConfig } from "../config.js";
import { handleTelegramUpdate } from "./commands.js";
import type { TelegramBotRuntime, TelegramUpdate } from "./types.js";

const schedule = new ScheduleService(
  new StaticScheduleProvider(),
  "25-04",
  "A",
);

async function command(
  text: string,
  now: string,
  sender = 123,
): Promise<string> {
  const sent: string[] = [];
  const runtime: TelegramBotRuntime = {
    telegram: {
      async sendMessage(input) {
        sent.push(input.text);
      },
      async getFileUrl() {
        return "";
      },
    },
    store: {
      async resolveTelegramUser() {
        return { userId: "user-1", status: "active" };
      },
    } as unknown as LifeOSStore,
    scheduleOwnerTelegramId: 123,
    schedule,
    scheduleTimezone: "Asia/Almaty",
    now: () => new Date(now),
  };
  const update: TelegramUpdate = {
    update_id: 1,
    message: {
      message_id: 1,
      text,
      from: { id: sender },
      chat: { id: sender, type: "private" },
    },
  };
  await handleTelegramUpdate(update, runtime);
  return sent.at(-1) ?? "";
}

describe("/schedule and /tomorrow", () => {
  it("keeps both commands available when automatic delivery is disabled", async () => {
    expect(loadBotConfig({ SCHEDULE_ENABLED: "false" }).scheduleEnabled).toBe(
      false,
    );
    expect(await command("/schedule", "2026-09-28T08:00:00Z")).toContain(
      "Расписание на сегодня",
    );
    expect(await command("/tomorrow", "2026-09-28T08:00:00Z")).toContain(
      "Расписание на завтра",
    );
  });

  it("shows today's common and A lessons through the shared service", async () => {
    const message = await command("/schedule", "2026-10-01T06:00:00Z");
    expect(message).toMatch(
      /^📅 Расписание на сегодня\n🗓 Четверг, 1 октября\n📚 Пар: 4/,
    );
    expect(message).toContain("Четверг, 1 октября");
    expect(message).toContain("09:00–09:50");
    expect(message).not.toContain("12:00–12:50");
  });

  it("crosses Friday → Saturday → Sunday → Monday", async () => {
    expect(await command("/tomorrow", "2026-10-02T12:00:00Z")).toContain(
      "Суббота, 3 октября",
    );
    expect(await command("/tomorrow", "2026-10-03T12:00:00Z")).toContain(
      "Воскресенье, 4 октября",
    );
    const monday = await command("/tomorrow", "2026-10-04T12:00:00Z");
    expect(monday).toMatch(/^📅 Расписание на завтра\n/);
    expect(monday).toContain("Понедельник, 5 октября");
    expect(monday).toContain("08:00–08:50");
  });

  it("uses Almaty local date at the UTC boundary", async () => {
    expect(await command("/tomorrow", "2026-09-28T20:00:00Z")).toContain(
      "Среда, 30 сентября",
    );
  });

  it("does not reveal the owner's schedule to another user", async () => {
    expect(await command("/schedule", "2026-09-28T12:00:00Z", 456)).toContain(
      "только владельцу",
    );
  });
});
