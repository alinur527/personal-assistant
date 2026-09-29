import { DateTime } from "luxon";
import { parseReminderArgs } from "../telegram/commands.js";

// Translate the small supported NL grammar into the existing reminder parser.
// An absent time never silently becomes midnight or a guessed hour.
export function parseAssistantReminder(
  request: string,
  now: Date,
  timezone: string,
): ReturnType<typeof parseReminderArgs> {
  const help = {
    ok: false as const,
    error:
      "Укажите день и точное время, например: «Напомни завтра в 19:00 купить воду». Можно также: «Напомни через 30 минут сделать перерыв».",
  };
  const text = request.trim().replace(/^(?:напомни|remind me)\s+/iu, "");
  const relative = text.match(
    /^через\s+(\d{1,4})\s+(минут(?:у|ы)?|час(?:а|ов)?)\s+(.+)$/iu,
  );
  if (relative)
    return parseReminderArgs(
      `${relative[3]} in:${relative[1]}${relative[2]!.toLowerCase().startsWith("час") ? "h" : "m"}`,
      now,
      timezone,
    );
  const local = DateTime.fromJSDate(now).setZone(timezone);
  const timed = text.match(
    /^(сегодня|завтра)\s+(?:в\s+)?(\d{1,2}:\d{2})\s+(.+)$/iu,
  );
  if (timed) {
    const date = local
      .plus({ days: timed[1]!.toLowerCase() === "завтра" ? 1 : 0 })
      .toISODate();
    try {
      return parseReminderArgs(
        `${timed[3]} at:${date} ${timed[2]}`,
        now,
        timezone,
      );
    } catch {
      return help;
    }
  }
  // Existing explicit command grammar is also accepted after "Напомни".
  try {
    const parsed = parseReminderArgs(text, now, timezone);
    return parsed.ok ? parsed : help;
  } catch {
    return help;
  }
}
