import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { ScheduleService, StaticScheduleProvider } from "@lifeos/core";
import type { LifeOSStore, ScheduleDeliveryStore } from "@lifeos/db";
import type { TelegramClient } from "../telegram/types.js";
import {
  nextScheduleRunAt,
  sendTomorrowSchedule,
  startDailySchedule,
} from "./daily.js";

class MemoryDeliveries implements ScheduleDeliveryStore {
  readonly rows = new Map<
    string,
    { status: "attempted" | "failed" | "sent"; token: string }
  >();
  private nextToken = 0;

  async claim(userId: string, sendOn: string) {
    const key = `${userId}:${sendOn}`;
    const row = this.rows.get(key);
    if (row?.status === "sent") return { status: "sent" } as const;
    if (row?.status === "attempted") return { status: "busy" } as const;
    const token = String(++this.nextToken);
    this.rows.set(key, { status: "attempted", token });
    return { status: "claimed", token } as const;
  }

  async mark(
    userId: string,
    sendOn: string,
    token: string,
    status: "sent" | "failed",
  ) {
    const row = this.rows.get(`${userId}:${sendOn}`);
    if (!row || row.token !== token || row.status !== "attempted") {
      throw new Error("claim lost");
    }
    row.status = status;
  }
}

function deliveryOptions(
  now: string,
  deliveries: ScheduleDeliveryStore,
  telegram: TelegramClient,
) {
  return {
    sendTime: "20:00",
    timezone: "Asia/Almaty",
    ownerTelegramId: 123,
    schedule: new ScheduleService(new StaticScheduleProvider(), "25-04", "A"),
    store: {
      async resolveTelegramUser() {
        return { userId: "user-1", status: "active" };
      },
    } as unknown as LifeOSStore,
    deliveries,
    telegram,
    now: () => new Date(now),
  };
}

describe("daily schedule delivery", () => {
  it("plans the next 20:00 in Asia/Almaty, including after a restart at 20:05", () => {
    const first = nextScheduleRunAt(
      new Date("2026-09-28T14:59:00Z"),
      "20:00",
      "Asia/Almaty",
    );
    const restarted = nextScheduleRunAt(
      new Date("2026-09-28T15:05:00Z"),
      "20:00",
      "Asia/Almaty",
    );
    expect(DateTime.fromJSDate(first).setZone("Asia/Almaty").toISO()).toContain(
      "2026-09-28T20:00:00",
    );
    expect(
      DateTime.fromJSDate(restarted).setZone("Asia/Almaty").toISO(),
    ).toContain("2026-09-29T20:00:00");
  });

  it("claims one local date once, so a restart cannot send a duplicate", async () => {
    const claims = new Set<string>();
    const sent: string[] = [];
    const deliveries: ScheduleDeliveryStore = {
      async claim(userId, date) {
        const key = `${userId}:${date}`;
        if (claims.has(key)) return { status: "sent" } as const;
        claims.add(key);
        return { status: "claimed", token: key } as const;
      },
      async mark() {},
    };
    const store = {
      async resolveTelegramUser() {
        return { userId: "user-1", status: "active" };
      },
    } as unknown as LifeOSStore;
    const telegram = {
      async sendMessage(input: { text: string }) {
        sent.push(input.text);
      },
    } as unknown as TelegramClient;
    const base = {
      sendTime: "20:00",
      timezone: "Asia/Almaty",
      ownerTelegramId: 123,
      schedule: new ScheduleService(new StaticScheduleProvider(), "25-04", "A"),
      store,
      deliveries,
      telegram,
    };
    expect(
      await sendTomorrowSchedule({
        ...base,
        now: () => new Date("2026-09-28T15:00:00Z"),
      }),
    ).toBe("sent");
    expect(
      await sendTomorrowSchedule({
        ...base,
        now: () => new Date("2026-09-28T15:05:00Z"),
      }),
    ).toBe("already_sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^📅 Расписание на завтра\n/);
    expect(sent[0]).toContain("Вторник, 29 сентября");
    expect(sent[0]).not.toContain("14:00");
  });

  it("runs the automatic task when local time reaches 20:00", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T14:59:00Z"));
    const sent: string[] = [];
    const stop = startDailySchedule({
      sendTime: "20:00",
      timezone: "Asia/Almaty",
      ownerTelegramId: 123,
      schedule: new ScheduleService(new StaticScheduleProvider(), "25-04", "A"),
      store: {
        async resolveTelegramUser() {
          return { userId: "user-1", status: "active" };
        },
      } as unknown as LifeOSStore,
      deliveries: {
        async claim() {
          return { status: "claimed", token: "first" } as const;
        },
        async mark() {},
      },
      telegram: {
        async sendMessage(input: { text: string }) {
          sent.push(input.text);
        },
      } as unknown as TelegramClient,
    });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Вторник, 29 сентября");
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("catches up at 20:05 after downtime but does not resend after another restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T15:05:00Z"));
    const claimed = new Set<string>();
    const sent: string[] = [];
    const options = {
      sendTime: "20:00",
      timezone: "Asia/Almaty",
      ownerTelegramId: 123,
      schedule: new ScheduleService(new StaticScheduleProvider(), "25-04", "A"),
      store: {
        async resolveTelegramUser() {
          return { userId: "user-1", status: "active" };
        },
      } as unknown as LifeOSStore,
      deliveries: {
        async claim(userId: string, date: string) {
          const key = `${userId}:${date}`;
          if (claimed.has(key)) return { status: "sent" } as const;
          claimed.add(key);
          return { status: "claimed", token: key } as const;
        },
        async mark() {},
      } satisfies ScheduleDeliveryStore,
      telegram: {
        async sendMessage(input: { text: string }) {
          sent.push(input.text);
        },
      } as unknown as TelegramClient,
    };
    const stopFirst = startDailySchedule(options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      stopFirst();
      const stopSecond = startDailySchedule(options);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toHaveLength(1);
      } finally {
        stopSecond();
      }
    } finally {
      stopFirst();
      vi.useRealTimers();
    }
  });

  it("Telegram send failed -> retry can succeed -> restart cannot duplicate", async () => {
    const deliveries = new MemoryDeliveries();
    const sent: string[] = [];
    let attempts = 0;
    const telegram = {
      async sendMessage(input: { text: string }) {
        attempts += 1;
        if (attempts === 1) throw new Error("Telegram network error");
        sent.push(input.text);
      },
    } as unknown as TelegramClient;
    const first = deliveryOptions("2026-09-28T15:00:00Z", deliveries, telegram);
    await expect(sendTomorrowSchedule(first)).rejects.toThrow(
      "Telegram network error",
    );
    expect(deliveries.rows.get("user-1:2026-09-28")?.status).toBe("failed");

    const retry = deliveryOptions("2026-09-28T15:05:00Z", deliveries, telegram);
    expect(await sendTomorrowSchedule(retry)).toBe("sent");
    expect(deliveries.rows.get("user-1:2026-09-28")?.status).toBe("sent");

    const restarted = deliveryOptions(
      "2026-09-28T15:10:00Z",
      deliveries,
      telegram,
    );
    expect(await sendTomorrowSchedule(restarted)).toBe("already_sent");
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Вторник, 29 сентября");
  });

  it("automatically retries a failed Telegram send after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T14:59:00Z"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const deliveries = new MemoryDeliveries();
    let attempts = 0;
    const telegram = {
      async sendMessage() {
        attempts += 1;
        if (attempts === 1) throw new Error("Telegram timeout");
      },
    } as unknown as TelegramClient;
    const options = deliveryOptions(
      "2026-09-28T14:59:00Z",
      deliveries,
      telegram,
    );
    options.now = () => new Date();
    const stop = startDailySchedule(options);
    try {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(attempts).toBe(2);
      expect(deliveries.rows.get("user-1:2026-09-28")?.status).toBe("sent");
    } finally {
      stop();
      log.mockRestore();
      vi.useRealTimers();
    }
  });

  it("allows only one parallel task to send while a claim is in flight", async () => {
    const deliveries = new MemoryDeliveries();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const telegram = {
      async sendMessage() {
        sends += 1;
        await pending;
      },
    } as unknown as TelegramClient;
    const options = deliveryOptions(
      "2026-09-28T15:00:00Z",
      deliveries,
      telegram,
    );
    const first = sendTomorrowSchedule(options);
    const second = sendTomorrowSchedule(options);
    expect(await second).toBe("busy");
    release();
    expect(await first).toBe("sent");
    expect(sends).toBe(1);
  });

  it("uses Almaty calendar dates across Sunday, month and year boundaries", async () => {
    const cases = [
      ["2026-10-04T15:00:00Z", "Понедельник, 5 октября"],
      ["2026-09-30T15:00:00Z", "Четверг, 1 октября"],
      ["2026-12-31T15:00:00Z", "Пятница, 1 января"],
    ] as const;
    for (const [now, expected] of cases) {
      const sent: string[] = [];
      const telegram = {
        async sendMessage(input: { text: string }) {
          sent.push(input.text);
        },
      } as unknown as TelegramClient;
      expect(
        await sendTomorrowSchedule(
          deliveryOptions(now, new MemoryDeliveries(), telegram),
        ),
      ).toBe("sent");
      expect(sent[0]).toContain(expected);
    }
  });
});
