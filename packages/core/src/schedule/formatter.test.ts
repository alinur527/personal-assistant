import { describe, expect, it } from "vitest";
import { formatScheduleMessage } from "./formatter.js";
import type { Lesson } from "./models.js";
import { ScheduleService } from "./service.js";
import { StaticScheduleProvider } from "./static-provider.js";

const schedule = new ScheduleService(
  new StaticScheduleProvider(),
  "25-04",
  "A",
);

const lesson = (overrides: Partial<Lesson> = {}): Lesson => ({
  dayOfWeek: 2,
  startTime: "12:00",
  endTime: "12:50",
  subject: "Python тілінде программалау (А)",
  lessonType: "-Lab",
  room: "2405",
  teacher: "Таберхан Р.",
  subgroup: "A",
  ...overrides,
});

describe("Telegram schedule formatter", () => {
  it("matches the complete Tuesday message and keeps a blank line between lessons", () => {
    expect(
      formatScheduleMessage(
        "2026-09-29",
        schedule.getLessons("2026-09-29"),
        true,
      ),
    ).toBe(
      [
        "📅 Расписание на завтра",
        "🗓 Вторник, 29 сентября",
        "📚 Пар: 2",
        "",
        "🕐 12:00–12:50",
        "📘 C / C ++ машиналық - бағытталған бағдарламалау",
        "🧪 Лабораторная",
        "📍 Аудитория: 2408",
        "👨‍🏫 Жумасеитова С.Д",
        "",
        "🕐 13:00–13:50",
        "📘 C / C ++ машиналық - бағытталған бағдарламалау",
        "🧪 Лабораторная",
        "📍 Аудитория: 2408",
        "👨‍🏫 Жумасеитова С.Д",
      ].join("\n"),
    );
  });

  it("shows today's heading, five slots, classroom and gym labels, without subgroup text", () => {
    const message = formatScheduleMessage(
      "2026-09-28",
      schedule.getLessons("2026-09-28"),
      false,
    );
    expect(message).toMatch(
      /^📅 Расписание на сегодня\n🗓 Понедельник, 28 сентября\n📚 Пар: 5\n\n🕐 08:00–08:50/,
    );
    expect(message).toContain(
      "🎓 Лекция\n📍 Аудитория: 1227\n👨‍🏫 Кеулимжаева Ж.А",
    );
    expect(message).toContain(
      "🏃 Физическая культура\n📍 Спорт зал Потанина 16/1",
    );
    expect(message).not.toMatch(/\([АБ]\)|-Lab|-L|subgroup=/);
  });

  it("formats the Wednesday online lesson without a classroom label", () => {
    const message = formatScheduleMessage(
      "2026-09-30",
      schedule.getLessons("2026-09-30"),
      true,
    );
    expect(message).toContain(
      [
        "🕐 20:00–20:50",
        "📘 Кәсіпкерліктегі экономика, құқық және қаржы",
        "🎓 Лекция",
        "🌐 Онлайн",
        "🔗 468 928 1041",
        "🔑 Код: 2211",
        "👨‍🏫 Амерханова И.К",
      ].join("\n"),
    );
    expect(message).not.toContain("📍 Онлайн");
  });

  it("uses friendly text for an empty day in both contexts", () => {
    expect(formatScheduleMessage("2026-10-03", [], true)).toBe(
      "📅 Расписание на завтра\n🗓 Суббота, 3 октября\n\n🎉 Завтра занятий нет.\nМожно отдыхать 😎",
    );
    expect(formatScheduleMessage("2026-10-03", [], false)).toBe(
      "📅 Расписание на сегодня\n🗓 Суббота, 3 октября\n\n🎉 Сегодня занятий нет.\nМожно отдыхать 😎",
    );
  });

  it("sorts before formatting and counts distinct time slots", () => {
    const message = formatScheduleMessage(
      "2026-09-29",
      [
        lesson({ startTime: "13:00", endTime: "13:50" }),
        lesson({ startTime: "12:00", endTime: "12:50" }),
        lesson({
          startTime: "12:00",
          endTime: "12:50",
          subject: "Другое занятие",
        }),
      ],
      true,
    );
    expect(message).toContain("📚 Пар: 2");
    expect(message.indexOf("🕐 12:00–12:50")).toBeLessThan(
      message.indexOf("🕐 13:00–13:50"),
    );
  });

  it("omits absent room and teacher, and keeps unknown types readable", () => {
    const message = formatScheduleMessage(
      "2026-09-29",
      [
        lesson({
          lessonType: "Семинар" as Lesson["lessonType"],
          room: " ",
          teacher: "",
        }),
      ],
      true,
    );
    expect(message).toContain("📚 Семинар");
    expect(message).not.toContain("📍");
    expect(message).not.toContain("👨‍🏫");
    expect(message).not.toContain("(А)");
    expect(
      formatScheduleMessage(
        "2026-09-29",
        [lesson({ lessonType: "СРСП" as Lesson["lessonType"] })],
        true,
      ),
    ).toContain("📚 СРСП");
  });

  it("escapes external HTML fields for Telegram's HTML parse mode", () => {
    const message = formatScheduleMessage(
      "2026-09-29",
      [
        lesson({
          subject: "C / C ++ <алгоритмы> & данные (А)",
          room: "зал <1> & 2",
          teacher: "А & Б <тест>",
        }),
      ],
      true,
    );
    expect(message).toContain("📘 C / C ++ &lt;алгоритмы&gt; &amp; данные");
    expect(message).toContain("📍 зал &lt;1&gt; &amp; 2");
    expect(message).toContain("👨‍🏫 А &amp; Б &lt;тест&gt;");
    expect(message).not.toContain("(А)");
  });

  it("escapes online credentials and does not create empty online labels", () => {
    const message = formatScheduleMessage(
      "2026-09-29",
      [
        lesson({
          room: "Онлайн: <meeting> & 42",
          onlineAccessCode: "p<1>&2",
          teacher: undefined,
        }),
      ],
      true,
    );
    expect(message).toContain(
      "🌐 Онлайн\n🔗 &lt;meeting&gt; &amp; 42\n🔑 Код: p&lt;1&gt;&amp;2",
    );
    expect(message).not.toContain("👨‍🏫");
  });
});
