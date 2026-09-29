import type { AssistantRoute } from "./contracts.js";
import { extractMemoryCandidate } from "./memory.js";

export const ASSISTANT_READ_ROUTES = [
  {
    intent: "schedule.tomorrow",
    tool: "schedule.get_tomorrow",
    patterns: [
      /^(?:что (?:у меня )?)?завтра$/u,
      /^(?:что у меня|какие пары|расписание)(?: на)? завтра$/u,
    ],
  },
  {
    intent: "schedule.today",
    tool: "schedule.get_today",
    patterns: [/^(?:что у меня|какие пары|расписание)(?: на)? сегодня$/u],
  },
  {
    intent: "schedule.next",
    tool: "schedule.get_next",
    patterns: [/^(?:какая|когда)(?: у меня)? следующая пара$/u],
  },
  {
    intent: "schedule.week",
    tool: "schedule.get_week",
    patterns: [/^расписание(?: на)? неделю$/u],
  },
  {
    intent: "schedule.free_time",
    tool: "schedule.free_time",
    patterns: [/^(?:когда у меня|какое у меня) свободное время$/u],
  },
  {
    intent: "schedule.after_university",
    tool: "schedule.after_university",
    patterns: [/^что у меня после (?:университета|пар)$/u],
  },
  {
    intent: "platonus.new_grades",
    tool: "platonus.get_new_grades",
    patterns: [
      /^(?:есть |покажи )?(?:ли )?новые оценки$/u,
      /^есть ли новые оценки$/u,
    ],
  },
  {
    intent: "platonus.grades",
    tool: "platonus.get_grades",
    patterns: [/^(?:покажи |какие у меня )?оценки(?: в platonus)?$/u],
  },
  {
    intent: "tasks.list",
    tool: "tasks.list",
    patterns: [
      /^(?:какие (?:у меня )?задачи (?:сегодня|остались)|покажи задачи|мои задачи)$/u,
    ],
  },
  {
    intent: "calendar.list",
    tool: "calendar.list_events",
    patterns: [
      /^(?:покажи календарь|события на сегодня|что в календаре сегодня)$/u,
    ],
  },
  {
    intent: "reminder.list",
    tool: "reminder.list",
    patterns: [/^(?:покажи |мои )?напоминания$/u],
  },
  {
    intent: "memory.list",
    tool: "memory.list",
    patterns: [/^(?:что ты (?:обо мне )?помнишь|покажи память)$/u],
  },
] as const;

export function routeAssistantMessage(message: string): AssistantRoute | null {
  const text = message
    .trim()
    .toLowerCase()
    .replace(/[?!.]+$/u, "")
    .replace(/\s+/g, " ");
  const read = ASSISTANT_READ_ROUTES.find((route) =>
    route.patterns.some((pattern) => pattern.test(text)),
  );
  if (read)
    return {
      intent: read.intent,
      tool: read.tool,
      confidence: 1,
      arguments:
        read.tool === "tasks.list"
          ? { period: text.includes("сегодня") ? "today" : "open" }
          : {},
      via: "rules",
    };
  if (/^(?:напомни|remind me)\s/iu.test(message.trim())) {
    return {
      intent: "reminder.create",
      tool: "reminder.create",
      confidence: 1,
      arguments: { request: message.trim() },
      via: "rules",
    };
  }
  if (/^(?:запомни|remember)(?:\s|:|,|$)/iu.test(message.trim())) {
    const candidate = extractMemoryCandidate(message);
    return {
      intent: "memory.remember",
      tool: "memory.remember",
      confidence: 1,
      arguments: { request: message.trim(), candidate },
      via: "rules",
    };
  }
  const forget = text.match(/^(?:забудь|forget)\s+([a-z][a-z0-9_.-]{1,99})$/u);
  if (forget)
    return {
      intent: "memory.archive",
      tool: "memory.archive",
      confidence: 1,
      arguments: { key: forget[1]! },
      via: "rules",
    };
  return null;
}
