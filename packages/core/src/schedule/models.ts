export type ScheduleSubgroup = "A" | "B";
export type LessonTypeCode = "-L" | "-P" | "-Lab" | "physical_education";

export interface Lesson {
  dayOfWeek: number; // ISO: Monday = 1, Sunday = 7
  startTime: string;
  endTime: string;
  subject: string;
  lessonType: LessonTypeCode;
  room?: string;
  teacher?: string;
  subgroup: ScheduleSubgroup | null;
  onlineAccessCode?: string;
}

export interface ScheduleProvider {
  getLessons(date: string, group: string): readonly Lesson[];
}
