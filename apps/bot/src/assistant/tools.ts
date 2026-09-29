import { DateTime } from "luxon";
import {
  assistantEmptyInput,
  assistantEnum,
  assistantNullable,
  assistantObject,
  assistantString,
  assistantTextOutput,
  containsAssistantSecret,
  extractMemoryCandidate,
  memoryCandidateSchema,
  shouldRemember,
  type AssistantContext,
  type AssistantMemoryStore,
  type ScheduleService,
} from "@lifeos/core";
import type { LifeOSStore } from "@lifeos/db";
import { AssistantToolRegistry } from "./registry.js";
import { registerScheduleTools } from "./schedule-tools.js";
import { parseAssistantReminder } from "./reminder-input.js";

export function escapeAssistantHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Keep each list field bounded after HTML escaping, without cutting an entity.
const safe = (text: string) => {
  let result = "";
  for (const char of text) {
    const escaped = escapeAssistantHtml(char);
    if (result.length + escaped.length > 200) return `${result}…`;
    result += escaped;
  }
  return result;
};
const localTime = (context: AssistantContext, timestamp: string) =>
  DateTime.fromISO(timestamp).setZone(context.timezone).toFormat("dd.MM HH:mm");

export function createAssistantTools(options: {
  store: LifeOSStore;
  memories: AssistantMemoryStore;
  schedule?: ScheduleService;
  scheduleTimezone: string;
}): AssistantToolRegistry {
  const { store, memories } = options;
  const registry = new AssistantToolRegistry();
  registerScheduleTools(registry, options);
  const read = (
    name: string,
    description: string,
    execute: (context: AssistantContext) => Promise<{ text: string }>,
  ) =>
    registry.register({
      name,
      description,
      effect: "READ",
      permission: "personal.read",
      inputSchema: assistantEmptyInput,
      outputSchema: assistantTextOutput,
      execute,
    });

  registry.register({
    name: "tasks.list",
    description:
      "List up to 20 open local tasks and 20 synced Google Tasks. period=today includes overdue and unscheduled tasks but excludes future deadlines; period=open includes all open tasks.",
    effect: "READ",
    permission: "personal.read",
    inputSchema: assistantObject({ period: assistantEnum(["today", "open"]) }),
    outputSchema: assistantTextOutput,
    async execute(context, input) {
      const mode = await store.resolveCurrentMode(context.userId);
      const dueBeforeOrUnscheduled =
        input.period === "today"
          ? DateTime.fromISO(context.currentDateTime)
              .setZone(context.timezone)
              .endOf("day")
              .toUTC()
              .toISO()!
          : undefined;
      const [local, google] = await Promise.all([
        store.listModeAwareFocusItems({
          userId: context.userId,
          mode: mode.mode,
          limit: 20,
          dueBeforeOrUnscheduled,
        }),
        store.listSourceEvents(context.userId, {
          sourceKey: "google_tasks",
          eventType: "task",
          status: "active",
          limit: 20,
          dueBeforeOrUnscheduled,
        }),
      ]);
      const items = [
        ...local.map((item) => ({ title: item.title, dueAt: item.dueAt })),
        ...google.map((item) => ({
          title: `[Google] ${item.title ?? "Задача"}`,
          dueAt: item.dueAt,
        })),
      ];
      return {
        text: [
          input.period === "today"
            ? "Задачи на сегодня, просроченные и без срока (до 20 из каждого источника):"
            : "Открытые задачи (до 20 из каждого источника):",
          ...items.map(
            (item) =>
              `• ${safe(item.title)}${item.dueAt ? ` — ${localTime(context, item.dueAt)}` : " — без срока"}`,
          ),
          ...(items.length ? [] : ["Открытых задач нет."]),
        ].join("\n"),
      };
    },
  });

  read(
    "platonus.get_grades",
    "Read the most recently synced Platonus grade entries. Never contacts university credentials or the university website.",
    async (context) => {
      const events = await store.listSourceEvents(context.userId, {
        sourceKey: "university_platform",
        eventType: "academic_grade",
        externalIdPrefix: "academic:platonus:",
        status: "active",
        recentFirst: true,
        limit: 20,
      });
      // Grade values live in academic_records. The existing store owns their mapping.
      const records = await store.listAcademicRecords(
        context.userId,
        events.map((event) => event.id),
      );
      const ids = new Set(events.map((event) => event.id));
      const rows = records.filter(
        (item) => item.sourceEventId && ids.has(item.sourceEventId),
      );
      return {
        text: [
          "Сохранённые оценки Platonus (до 20):",
          ...rows.map(
            (item) =>
              `• ${safe(item.courseTitle)} — ${safe(item.title)}: ${safe(item.valueText ?? String(item.score ?? "—"))}`,
          ),
          ...(rows.length
            ? []
            : ["Сохранённых оценок нет. Проверьте синхронизацию Platonus."]),
        ].join("\n"),
      };
    },
  );

  read(
    "platonus.get_new_grades",
    "Read actual Platonus grade-change notifications from the last 7 days (including already delivered). Not an unread inbox.",
    async (context) => {
      if (!store.listGradeChanges)
        return { text: "История изменений оценок пока недоступна." };
      const since = DateTime.fromISO(context.currentDateTime)
        .minus({ days: 7 })
        .toUTC()
        .toISO()!;
      const rows = await store.listGradeChanges(context.userId, since, 20);
      return {
        text: [
          "Изменения оценок Platonus за последние 7 дней (до 20, включая уже отправленные):",
          ...rows.map(
            (item) =>
              `• ${safe(item.courseTitle)} — ${safe(item.title)}: ${safe(item.score)}${item.maxScore ? `/${safe(item.maxScore)}` : ""} (${localTime(context, item.changedAt)})`,
          ),
          ...(rows.length
            ? []
            : [
                "Новых записанных изменений нет. Это не проверка Platonus в реальном времени.",
              ]),
        ].join("\n"),
      };
    },
  );

  read(
    "reminder.list",
    "List the next 10 pending reminders.",
    async (context) => {
      const rows = await store.listUpcomingReminders(context.userId, 10);
      return {
        text: rows.length
          ? [
              "Ближайшие напоминания:",
              ...rows.map(
                (item) =>
                  `• ${localTime(context, item.remindAt)} — ${safe(item.message)}`,
              ),
            ].join("\n")
          : "Ближайших напоминаний нет.",
      };
    },
  );

  registry.register({
    name: "reminder.create",
    description:
      "Create a reminder from an explicit user request with an exact future time.",
    effect: "WRITE",
    permission: "reminder.write",
    inputSchema: assistantObject({ request: assistantString(1000) }),
    outputSchema: assistantTextOutput,
    async execute(context, input) {
      if (containsAssistantSecret(input.request))
        return { text: "Не сохраняю пароли, ключи и токены в напоминаниях." };
      const now = new Date(context.currentDateTime);
      const parsed = parseAssistantReminder(
        input.request,
        now,
        context.timezone,
      );
      if (!parsed.ok) return { text: parsed.error };
      const due = Date.parse(parsed.remindAt);
      if (
        !Number.isFinite(due) ||
        due <= now.getTime() ||
        due > now.getTime() + 366 * 86400000
      )
        return { text: "Укажите время в будущем, не дальше чем на год." };
      const reminder = await store.createReminder({
        userId: context.userId,
        message: parsed.message,
        remindAt: parsed.remindAt,
        channel: "telegram",
        metadataJson: { source: "assistant", request_id: context.requestId },
      });
      return {
        text: `Напоминание создано: ${localTime(context, reminder.remindAt)} (${safe(context.timezone)}).\n${safe(reminder.message)}`,
      };
    },
  });

  read(
    "memory.list",
    "List up to 20 active personal memories, not operational app records.",
    async (context) => {
      const rows = await memories.retrieve(context.userId, {
        query: "",
        limit: 20,
      });
      return {
        text: rows.length
          ? [
              "Память (до 20 записей; «Забудь ключ» архивирует запись):",
              ...rows
                .filter((item) => item.userId === context.userId)
                .map((item) => `• ${safe(item.key)}: ${safe(item.content)}`),
            ].join("\n")
          : "Память пока пуста.",
      };
    },
  );

  registry.register({
    name: "memory.remember",
    description:
      "Validate an explicit remember request and replace the memory with the same semantic key.",
    effect: "WRITE",
    permission: "memory.write",
    inputSchema: assistantObject({
      request: assistantString(1000),
      candidate: assistantNullable(memoryCandidateSchema),
    }),
    outputSchema: assistantTextOutput,
    async execute(context, input) {
      const candidate = extractMemoryCandidate(input.request);
      if (!candidate)
        return {
          text: "Укажите тип и постоянный ключ: «Запомни: preference response.style: Предпочитаю краткие ответы». Типы: preference, fact, goal, constraint, learning.",
        };
      if (!shouldRemember(candidate))
        return {
          text: "Не сохранил: память предназначена для устойчивых предпочтений, фактов и целей, без секретов и текущих событий.",
        };
      const saved = await memories.remember(
        context.userId,
        candidate,
        context.source,
      );
      return {
        text: `Запомнил (${safe(saved.key)}): ${escapeAssistantHtml(saved.content)}`,
      };
    },
  });
  registry.register({
    name: "memory.archive",
    description: "Reversibly archive the explicitly named personal memory.",
    effect: "WRITE",
    permission: "memory.write",
    inputSchema: assistantObject({ key: assistantString(100) }),
    outputSchema: assistantTextOutput,
    async execute(context, input) {
      const archived = await memories.archive(context.userId, input.key);
      return {
        text: archived
          ? "Запись исключена из активной памяти."
          : "Активной записи с таким ключом нет.",
      };
    },
  });
  return registry;
}
