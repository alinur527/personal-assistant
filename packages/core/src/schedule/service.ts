import type { Lesson, ScheduleProvider, ScheduleSubgroup } from "./models.js";

export class ScheduleService {
  constructor(
    private readonly provider: ScheduleProvider,
    readonly group: string,
    readonly subgroup: ScheduleSubgroup,
  ) {}

  getLessons(date: string): Lesson[] {
    return this.provider
      .getLessons(date, this.group)
      .filter(
        (lesson) =>
          lesson.subgroup === null || lesson.subgroup === this.subgroup,
      )
      .sort((left, right) => left.startTime.localeCompare(right.startTime));
  }
}
