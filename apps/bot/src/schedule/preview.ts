import {
  formatScheduleMessage,
  ScheduleService,
  StaticScheduleProvider,
} from "@lifeos/core";

const date = process.argv[2];
if (!date) {
  console.error("Usage: pnpm --filter @lifeos/bot schedule:preview YYYY-MM-DD");
  process.exitCode = 1;
} else {
  const schedule = new ScheduleService(
    new StaticScheduleProvider(),
    "25-04",
    "A",
  );
  console.log(formatScheduleMessage(date, schedule.getLessons(date), true));
}
