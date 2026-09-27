import type {
  Lesson,
  LessonTypeCode,
  ScheduleProvider,
  ScheduleSubgroup,
} from "./models.js";

function lesson(
  dayOfWeek: number,
  startTime: string,
  subject: string,
  lessonType: LessonTypeCode,
  room: string | undefined,
  teacher: string | undefined,
  subgroup: ScheduleSubgroup | null = null,
  onlineAccessCode?: string,
): Lesson {
  return {
    dayOfWeek,
    startTime,
    endTime: `${startTime.slice(0, 2)}:50`,
    subject,
    lessonType,
    room,
    teacher,
    subgroup,
    onlineAccessCode,
  };
}

const statistics = "Компьютерлік ғылымдарындағы ықтималдық пен статистика";
const python = "Python тілінде программалау";
const cpp = "C / C ++ машиналық - бағытталған бағдарламалау";
const economics = "Кәсіпкерліктегі экономика, құқық және қаржы";
const gym = "Спорт зал Потанина 16/1";

// Current source of truth supplied for group 25-04. The numeric 23 in Friday's
// 17:00 Excel cell is deliberately absent because it is not a lesson.
const LESSONS: readonly Lesson[] = [
  lesson(1, "08:00", statistics, "-L", "1227", "Кеулимжаева Ж.А"),
  lesson(1, "10:00", python, "-Lab", "2405", "Таберхан Р.", "A"),
  lesson(1, "11:00", python, "-Lab", "2405", "Таберхан Р.", "A"),
  lesson(
    1,
    "18:00",
    "Дене шынықтыру",
    "physical_education",
    gym,
    "Елемесов А.Ж",
  ),
  lesson(
    1,
    "19:00",
    "Дене шынықтыру",
    "physical_education",
    gym,
    "Елемесов А.Ж",
  ),
  lesson(2, "12:00", cpp, "-Lab", "2408", "Жумасеитова С.Д", "A"),
  lesson(2, "13:00", cpp, "-Lab", "2408", "Жумасеитова С.Д", "A"),
  lesson(2, "14:00", cpp, "-Lab", undefined, undefined, "B"),
  lesson(2, "15:00", cpp, "-Lab", undefined, undefined, "B"),
  lesson(2, "16:00", cpp, "-Lab", undefined, undefined, "B"),
  lesson(3, "08:00", statistics, "-P", "2404", "Кеулимжаева Ж.А"),
  lesson(3, "09:00", statistics, "-P", "2404", "Кеулимжаева Ж.А"),
  lesson(3, "10:00", "Философия", "-P", "2414", "Ракимжанова С.К"),
  lesson(3, "11:00", "Философия", "-P", "2414", "Ракимжанова С.К"),
  lesson(
    3,
    "20:00",
    economics,
    "-L",
    "Онлайн: 468 928 1041",
    "Амерханова И.К",
    null,
    "2211",
  ),
  lesson(4, "08:00", "Философия", "-L", "1227", "Ракимжанова С.К"),
  lesson(4, "09:00", cpp, "-L", "1227", "Багисов Ж."),
  lesson(
    4,
    "10:00",
    economics,
    "-P",
    "1425",
    "Тлегенова Ж.К / Амирова А / Тлеужанова Д.",
  ),
  lesson(
    4,
    "11:00",
    economics,
    "-P",
    "1425",
    "Тлегенова Ж.К / Амирова А / Тлеужанова Д.",
  ),
  lesson(4, "12:00", python, "-Lab", "2510", undefined, "B"),
  lesson(4, "13:00", python, "-Lab", "2510", undefined, "B"),
  lesson(5, "15:00", cpp, "-Lab", "2501", "Жумасеитова С.Д", "A"),
  lesson(5, "16:00", python, "-L", "1227", "Таберхан Р."),
];

export class StaticScheduleProvider implements ScheduleProvider {
  getLessons(date: string, group: string): readonly Lesson[] {
    if (group !== "25-04") {
      throw new Error(`No static schedule for group ${group}`);
    }
    const day = new Date(`${date}T00:00:00Z`);
    if (
      Number.isNaN(day.getTime()) ||
      day.toISOString().slice(0, 10) !== date
    ) {
      throw new Error(`Invalid schedule date: ${date}`);
    }
    const dayOfWeek = day.getUTCDay() || 7;
    return LESSONS.filter((item) => item.dayOfWeek === dayOfWeek);
  }
}
