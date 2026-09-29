import type { MemoryCandidate } from "./contracts.js";
import {
  assistantEnum,
  assistantNumber,
  assistantObject,
  assistantString,
} from "./schema.js";

export const memoryCandidateSchema = assistantObject({
  type: assistantEnum(["preference", "fact", "goal", "constraint", "learning"]),
  key: assistantString(100),
  content: assistantString(500, 8),
  confidence: assistantNumber(0, 1),
  importance: assistantNumber(0, 1),
});

export function containsAssistantSecret(text: string): boolean {
  return /(?:password|парол[ьяюи]|api[ _-]?key|secret|секрет|токен|token|cookie|authorization|bearer|session[ _-]?(?:id|key)|private[ _-]?key|service[ _-]?role|BEGIN .*PRIVATE KEY|sk-[a-z0-9]|eyJ[a-z0-9_-]+\.[a-z0-9_-]+|\d{6,}:[a-z0-9_-]{20,}|https?:\/\/[^\s/]+:[^\s]+@)/iu.test(
    text,
  );
}

export function normalizeMemoryContent(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldRemember(
  candidate: unknown,
): candidate is MemoryCandidate {
  try {
    const memory = memoryCandidateSchema.parse(candidate);
    return (
      /^[a-z][a-z0-9_.-]{1,99}$/.test(memory.key) &&
      memory.confidence >= 0.8 &&
      !containsAssistantSecret(`${memory.key} ${memory.content}`) &&
      !/(?:сегодня|завтра|вчера|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|напомни|оценк[аиуы]|транзакци|баланс сч[её]та|ignore.*instructions|system prompt|игнорируй.*инструкц)/iu.test(
        memory.content,
      ) &&
      !memory.content.endsWith("?")
    );
  } catch {
    return false;
  }
}

// Only explicit opt-in is persisted. Ordinary conversation remains conversation.
// Stable keys handle corrections without two contradictory active versions.
export function extractMemoryCandidate(
  message: string,
): MemoryCandidate | null {
  const match = message.trim().match(/^(?:запомни|remember)\s*[: ,]\s*(.+)$/iu);
  if (!match) return null;
  const content = match[1]!.trim();
  const explicit = content.match(
    /^(preference|fact|goal|constraint|learning)\s+([a-z][a-z0-9_.-]{1,99})\s*:\s*(.+)$/isu,
  );
  if (explicit)
    return {
      type: explicit[1]!.toLowerCase() as MemoryCandidate["type"],
      key: explicit[2]!,
      content: explicit[3]!,
      confidence: 1,
      importance: 0.7,
    };
  const rules: Array<[RegExp, MemoryCandidate["type"], string]> = [
    [
      /(?:кратк|коротк|подробн).*(?:ответ)|(?:ответ).*(?:кратк|коротк|подробн)/iu,
      "preference",
      "response.style",
    ],
    [
      /(?:дорог|доезжа|добира|путь).*(?:минут|час)/iu,
      "fact",
      "commute.duration",
    ],
    [
      /(?:не посещаю|не хожу|не посещает).*подгрупп/iu,
      "constraint",
      "study.subgroup",
    ],
    [/(?:хочу|цель).*(?:спорт|зал|тренир)/iu, "goal", "fitness.goal"],
  ];
  for (const [pattern, type, key] of rules) {
    if (pattern.test(content))
      return { type, key, content, confidence: 1, importance: 0.7 };
  }
  return null;
}

export function memorySearchTerms(query: string): string[] {
  const stop = new Set([
    "что",
    "меня",
    "мне",
    "как",
    "когда",
    "какие",
    "сегодня",
    "завтра",
    "есть",
    "the",
    "and",
  ]);
  return [
    ...new Set(
      normalizeMemoryContent(query)
        .split(" ")
        .filter((term) => term.length >= 3 && !stop.has(term)),
    ),
  ].slice(0, 12);
}
