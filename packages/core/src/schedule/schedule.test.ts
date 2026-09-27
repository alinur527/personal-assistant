import { describe, expect, it } from "vitest";
import { formatScheduleMessage } from "./formatter.js";
import { ScheduleService } from "./service.js";
import { StaticScheduleProvider } from "./static-provider.js";

const schedule = new ScheduleService(
  new StaticScheduleProvider(),
  "25-04",
  "A",
);
const times = (date: string) =>
  schedule.getLessons(date).map((item) => item.startTime);

describe("25-04 schedule for subgroup A", () => {
  it("includes common lessons without a subgroup, including Friday's Python lecture", () => {
    const friday = schedule.getLessons("2026-10-02");
    expect(friday).toHaveLength(2);
    expect(friday[1]).toMatchObject({
      startTime: "16:00",
      subject: "Python тілінде программалау",
      lessonType: "-L",
      subgroup: null,
    });
  });

  it("includes subgroup A and excludes subgroup B", () => {
    const provider = new StaticScheduleProvider();
    expect(provider.getLessons("2026-10-01", "25-04")).toContainEqual(
      expect.objectContaining({
        subject: "Python тілінде программалау",
        subgroup: "B",
        startTime: "12:00",
      }),
    );
    expect(schedule.getLessons("2026-09-28")).toContainEqual(
      expect.objectContaining({
        subject: "Python тілінде программалау",
        subgroup: "A",
        startTime: "10:00",
      }),
    );
    expect(
      schedule.getLessons("2026-10-01").every((item) => item.subgroup !== "B"),
    ).toBe(true);
  });

  it("returns Tuesday's 12:00 and 13:00 lessons, never B's 14:00–16:00", () => {
    expect(times("2026-09-29")).toEqual(["12:00", "13:00"]);
  });

  it("keeps Thursday's four common lessons and excludes both Python B labs", () => {
    expect(times("2026-10-01")).toEqual(["08:00", "09:00", "10:00", "11:00"]);
    expect(
      schedule.getLessons("2026-10-01").map((item) => item.subject),
    ).toEqual([
      "Философия",
      "C / C ++ машиналық - бағытталған бағдарламалау",
      "Кәсіпкерліктегі экономика, құқық және қаржы",
      "Кәсіпкерліктегі экономика, құқық және қаржы",
    ]);
  });

  it("does not turn Friday's Excel value 23 into a lesson", () => {
    expect(times("2026-10-02")).toEqual(["15:00", "16:00"]);
    expect(
      formatScheduleMessage(
        "2026-10-02",
        schedule.getLessons("2026-10-02"),
        false,
      ),
    ).not.toContain("17:00");
  });

  it("returns no lessons on Saturday or Sunday", () => {
    expect(times("2026-10-03")).toEqual([]);
    expect(times("2026-10-04")).toEqual([]);
    expect(formatScheduleMessage("2026-10-03", [], true)).toContain(
      "🎉 Завтра занятий нет.",
    );
  });

  it("formats normalized lesson types, location and online access", () => {
    const monday = formatScheduleMessage(
      "2026-09-28",
      schedule.getLessons("2026-09-28"),
      false,
    );
    expect(monday).toContain("Лекция");
    expect(monday).toContain("Лабораторная");
    expect(monday).toContain("Физическая культура");
    expect(monday).not.toContain("(А)");
    const wednesday = formatScheduleMessage(
      "2026-09-30",
      schedule.getLessons("2026-09-30"),
      false,
    );
    expect(wednesday).toContain("468 928 1041");
    expect(wednesday).toContain("2211");
  });
});
