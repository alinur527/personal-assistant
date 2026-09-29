import { DateTime } from "luxon";
import {
  assistantEmptyInput,
  assistantFreeWindows,
  assistantTextOutput,
  formatScheduleMessage,
  type AssistantContext,
  type ScheduleService,
} from "@lifeos/core";
import type { LifeOSStore } from "@lifeos/db";
import type { AssistantToolRegistry } from "./registry.js";

const safe = (text: string) =>
  text
    .slice(0, 500)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function registerScheduleTools(
  registry: AssistantToolRegistry,
  options: {
    store: LifeOSStore;
    schedule?: ScheduleService;
    scheduleTimezone: string;
  },
): void {
  const read = (
    name: string,
    description: string,
    execute: (context: AssistantContext) => Promise<{ text: string }>,
    scheduleOnly = true,
  ) =>
    registry.register({
      name,
      description,
      effect: "READ",
      permission: scheduleOnly ? "schedule.read" : "personal.read",
      inputSchema: assistantEmptyInput,
      outputSchema: assistantTextOutput,
      execute,
    });
  const dayFor = (context: AssistantContext) =>
    DateTime.fromISO(context.currentDateTime).setZone(options.scheduleTimezone);
  const calendar = async (context: AssistantContext, day: DateTime) =>
    options.store.listSourceEvents(context.userId, {
      sourceKey: "google_calendar",
      eventType: "event",
      status: "active",
      overlapsAfter: day.startOf("day").toUTC().toISO()!,
      before: day.endOf("day").toUTC().toISO()!,
      limit: 101,
    });
  const eventsText = (
    events: Awaited<ReturnType<typeof calendar>>,
    zone: string,
  ) =>
    events
      .slice(0, 20)
      .map(
        (event) =>
          `• ${event.startsAt ? DateTime.fromISO(event.startsAt).setZone(zone).toFormat("HH:mm") : "Весь день"} — ${safe(event.title ?? "Событие")}`,
      );

  read(
    "calendar.list_events",
    "List today's synced Google Calendar events in the user's timezone. Read-only; does not create events.",
    async (context) => {
      const day = DateTime.fromISO(context.currentDateTime).setZone(
        context.timezone,
      );
      const events = await calendar(context, day);
      return {
        text: [
          `Календарь на ${day.toFormat("dd.MM")} (синхронизированные данные, до 20):`,
          ...eventsText(events, context.timezone),
          ...(events.length ? [] : ["Сохранённых событий нет."]),
        ].join("\n"),
      };
    },
    false,
  );

  for (const tomorrow of [false, true])
    read(
      `schedule.get_${tomorrow ? "tomorrow" : "today"}`,
      `University timetable for ${tomorrow ? "tomorrow" : "today"}; owner only.`,
      async (context) => {
        if (!options.schedule) return { text: "Расписание пока не настроено." };
        const date = dayFor(context)
          .plus({ days: tomorrow ? 1 : 0 })
          .toISODate()!;
        return {
          text: formatScheduleMessage(
            date,
            options.schedule.getLessons(date),
            tomorrow,
          ),
        };
      },
    );

  read(
    "schedule.get_next",
    "The next university lesson starting today or in the next seven days; owner only.",
    async (context) => {
      if (!options.schedule) return { text: "Расписание пока не настроено." };
      const now = dayFor(context);
      for (let offset = 0; offset <= 7; offset++) {
        const day = now.plus({ days: offset });
        const lesson = options.schedule.getLessons(day.toISODate()!).find(
          (item) =>
            DateTime.fromISO(`${day.toISODate()}T${item.startTime}`, {
              zone: options.scheduleTimezone,
            }).toMillis() >= now.toMillis(),
        );
        if (lesson)
          return {
            text: `Следующая пара: ${day.toFormat("dd.MM")} ${lesson.startTime}–${lesson.endTime}\n${safe(lesson.subject)}${lesson.room ? `\n${safe(lesson.room)}` : ""}`,
          };
      }
      return { text: "На ближайшие 7 дней занятий нет." };
    },
  );

  read(
    "schedule.get_week",
    "University timetable for the next seven days; owner only.",
    async (context) => {
      if (!options.schedule) return { text: "Расписание пока не настроено." };
      return {
        text: Array.from({ length: 7 }, (_, offset) => {
          const date = dayFor(context).plus({ days: offset }).toISODate()!;
          const lessons = options.schedule!.getLessons(date);
          return [
            date,
            ...(lessons.length
              ? lessons.map(
                  (item) => `${item.startTime} — ${safe(item.subject)}`,
                )
              : ["Занятий нет."]),
          ].join("\n");
        }).join("\n\n"),
      };
    },
  );

  read(
    "schedule.after_university",
    "Today's synced calendar events after the final university lesson; does not include unplanned tasks or travel.",
    async (context) => {
      if (!options.schedule) return { text: "Расписание пока не настроено." };
      const day = dayFor(context);
      const lessons = options.schedule.getLessons(day.toISODate()!);
      const last = lessons
        .map((item) => item.endTime)
        .sort()
        .at(-1);
      const cutoff = last
        ? DateTime.fromISO(`${day.toISODate()}T${last}`, {
            zone: options.scheduleTimezone,
          })
        : day;
      const events = (await calendar(context, day)).filter(
        (event) =>
          event.startsAt &&
          Date.parse(event.endsAt ?? event.startsAt) > cutoff.toMillis(),
      );
      return {
        text: [
          last ? `Последняя пара заканчивается в ${last}.` : "Сегодня пар нет.",
          "Сохранённые события после этого времени:",
          ...eventsText(events, options.scheduleTimezone),
          ...(events.length
            ? []
            : ["Событий в синхронизированном календаре нет."]),
        ].join("\n"),
      };
    },
  );

  read(
    "schedule.free_time",
    "Today's unoccupied windows between 08:00 and 22:00 from university timetable and synced Google Calendar only. Excludes travel and unscheduled tasks.",
    async (context) => {
      if (!options.schedule) return { text: "Расписание пока не настроено." };
      const day = dayFor(context);
      const events = await calendar(context, day);
      if (events.length > 100)
        return {
          text: "Слишком много событий для надёжного расчёта. Откройте календарь.",
        };
      const millis = (time: string) =>
        DateTime.fromISO(`${day.toISODate()}T${time}`, {
          zone: options.scheduleTimezone,
        }).toMillis();
      const busy = options.schedule
        .getLessons(day.toISODate()!)
        .map((item) => ({
          start: millis(item.startTime),
          end: millis(item.endTime),
        }));
      for (const event of events) {
        if (
          !event.startsAt ||
          !event.endsAt ||
          Date.parse(event.endsAt) <= Date.parse(event.startsAt)
        )
          return {
            text: "В календаре есть событие без точного времени окончания. Проверьте календарь перед планированием.",
          };
        busy.push({
          start: Date.parse(event.startsAt),
          end: Date.parse(event.endsAt),
        });
      }
      const windows = assistantFreeWindows(
        {
          start: Math.max(day.toMillis(), millis("08:00")),
          end: millis("22:00"),
        },
        busy,
      ).filter((item) => item.end - item.start >= 30 * 60000);
      const format = (value: number) =>
        DateTime.fromMillis(value)
          .setZone(options.scheduleTimezone)
          .toFormat("HH:mm");
      return {
        text: [
          "Окна от 30 минут сегодня до 22:00 по расписанию и синхронизированному календарю:",
          ...windows.map(
            (item) => `• ${format(item.start)}–${format(item.end)}`,
          ),
          ...(windows.length ? [] : ["Подходящих окон нет."]),
          "Дорога и задачи без времени здесь не учтены.",
        ].join("\n"),
      };
    },
  );
}
