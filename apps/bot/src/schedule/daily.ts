import { DateTime } from "luxon";
import { formatScheduleMessage, type ScheduleService } from "@lifeos/core";
import type { LifeOSStore, ScheduleDeliveryStore } from "@lifeos/db";
import type { TelegramClient } from "../telegram/types.js";

export interface DailyScheduleOptions {
  sendTime: string;
  timezone: string;
  ownerTelegramId: number;
  schedule: ScheduleService;
  store: LifeOSStore;
  deliveries: ScheduleDeliveryStore;
  telegram: TelegramClient;
  now?: () => Date;
}

export type ScheduleSendResult = "sent" | "already_sent" | "busy";
const SCHEDULE_SEND_TIMEOUT_MS = 30_000;
const SCHEDULE_RETRY_DELAY_MS = 5 * 60 * 1000;

export function nextScheduleRunAt(
  now: Date,
  sendTime: string,
  timezone: string,
): Date {
  const local = DateTime.fromJSDate(now).setZone(timezone);
  const [hour, minute] = sendTime.split(":").map(Number);
  let next = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (next.toMillis() <= local.toMillis()) {
    next = next.plus({ days: 1 });
  }
  return next.toJSDate();
}

export async function sendTomorrowSchedule(
  options: DailyScheduleOptions,
): Promise<ScheduleSendResult> {
  const local = DateTime.fromJSDate(options.now?.() ?? new Date()).setZone(
    options.timezone,
  );
  const sendOn = local.toISODate()!;
  const tomorrow = local.plus({ days: 1 }).toISODate()!;
  const owner = await options.store.resolveTelegramUser(
    options.ownerTelegramId,
  );
  if (!owner || owner.status !== "active") {
    throw new Error("Schedule owner is not an active Telegram user");
  }
  const text = formatScheduleMessage(
    tomorrow,
    options.schedule.getLessons(tomorrow),
    true,
  );
  const claim = await options.deliveries.claim(owner.userId, sendOn);
  if (claim.status !== "claimed") {
    return claim.status === "sent" ? "already_sent" : "busy";
  }
  try {
    await options.telegram.sendMessage({
      chatId: options.ownerTelegramId,
      text,
      timeoutMs: SCHEDULE_SEND_TIMEOUT_MS,
    });
  } catch (error) {
    try {
      await options.deliveries.mark(
        owner.userId,
        sendOn,
        claim.token,
        "failed",
      );
    } catch (markError) {
      throw new AggregateError(
        [error, markError],
        "Telegram send and delivery status update failed",
      );
    }
    throw error;
  }
  await options.deliveries.mark(owner.userId, sendOn, claim.token, "sent");
  return "sent";
}

export function startDailySchedule(options: DailyScheduleOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const runStartedAt = options.now?.() ?? new Date();
    const startedOn = DateTime.fromJSDate(runStartedAt)
      .setZone(options.timezone)
      .toISODate();
    try {
      const result = await sendTomorrowSchedule({
        ...options,
        now: () => runStartedAt,
      });
      if (result !== "busy") return;
    } catch (error) {
      console.error("[schedule] daily delivery failed", {
        errorType: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : undefined,
      });
    }
    if (stopped) return;
    const now = DateTime.fromJSDate(options.now?.() ?? new Date()).setZone(
      options.timezone,
    );
    if (
      now.toISODate() !== startedOn ||
      now.plus({ milliseconds: SCHEDULE_RETRY_DELAY_MS }).toISODate() !==
        startedOn
    )
      return;
    retryTimer = setTimeout(() => void run(), SCHEDULE_RETRY_DELAY_MS);
  };
  const arm = (at?: Date) => {
    if (stopped) return;
    const now = at ?? options.now?.() ?? new Date();
    const next = nextScheduleRunAt(now, options.sendTime, options.timezone);
    timer = setTimeout(() => {
      arm();
      void run();
    }, next.getTime() - now.getTime());
  };
  const startedAt = options.now?.() ?? new Date();
  arm(startedAt);
  const local = DateTime.fromJSDate(startedAt).setZone(options.timezone);
  const [hour, minute] = options.sendTime.split(":").map(Number);
  if (local.hour * 60 + local.minute >= hour * 60 + minute) {
    void run(); // Catch up after downtime; the persistent claim prevents a duplicate.
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
  };
}
