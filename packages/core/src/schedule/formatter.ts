import type { Lesson } from "./models.js";

const TYPE_LABELS: Record<string, readonly [string, string]> = {
  "-L": ["🎓", "Лекция"],
  "-P": ["📝", "Практика"],
  "-Lab": ["🧪", "Лабораторная"],
  СРСП: ["📚", "СРСП"],
  physical_education: ["🏃", "Физическая культура"],
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function formatScheduleMessage(
  date: string,
  lessons: readonly Lesson[],
  tomorrow: boolean,
): string {
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    timeZone: "UTC",
  }).format(day);
  const dayAndMonth = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(day);
  const title = [
    `📅 Расписание на ${tomorrow ? "завтра" : "сегодня"}`,
    `🗓 ${weekday[0]?.toUpperCase()}${weekday.slice(1)}, ${dayAndMonth}`,
  ];
  const sortedLessons = [...lessons].sort(
    (left, right) =>
      left.startTime.localeCompare(right.startTime) ||
      left.endTime.localeCompare(right.endTime),
  );
  if (sortedLessons.length === 0) {
    return `${title.join("\n")}\n\n🎉 ${tomorrow ? "Завтра" : "Сегодня"} занятий нет.\nМожно отдыхать 😎`;
  }
  const slots = new Set(
    sortedLessons.map((item) => `${item.startTime}–${item.endTime}`),
  );
  title.push(`📚 Пар: ${slots.size}`);
  const blocks = sortedLessons.map((item) => {
    const [icon, type] = TYPE_LABELS[item.lessonType] ?? [
      "📚",
      item.lessonType,
    ];
    const subject = item.subject.replace(/\s*\([АAБB]\)\s*$/u, "").trim();
    const room = item.room?.trim();
    const teacher = item.teacher?.trim();
    const accessCode = item.onlineAccessCode?.trim();
    const isOnline =
      Boolean(room?.match(/^Онлайн(?:\s*:|$)/iu)) ||
      Boolean(accessCode && !room);
    const onlineMeeting = room?.replace(/^Онлайн\s*:?\s*/iu, "").trim();
    return [
      `🕐 ${escapeHtml(item.startTime)}–${escapeHtml(item.endTime)}`,
      `📘 ${escapeHtml(subject)}`,
      `${icon} ${escapeHtml(type)}`,
      ...(isOnline
        ? [
            "🌐 Онлайн",
            ...(onlineMeeting ? [`🔗 ${escapeHtml(onlineMeeting)}`] : []),
            ...(accessCode ? [`🔑 Код: ${escapeHtml(accessCode)}`] : []),
          ]
        : room
          ? [`📍 ${/^\d+$/.test(room) ? "Аудитория: " : ""}${escapeHtml(room)}`]
          : []),
      ...(teacher ? [`👨‍🏫 ${escapeHtml(teacher)}`] : []),
    ].join("\n");
  });
  return [title.join("\n"), ...blocks].join("\n\n");
}
