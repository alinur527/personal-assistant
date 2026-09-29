import { describe, expect, it } from "vitest";
import {
  assistantEmptyInput,
  assistantNumber,
  assistantObject,
  assistantString,
} from "./schema.js";
import { extractMemoryCandidate, shouldRemember } from "./memory.js";
import { routeAssistantMessage } from "./router.js";

describe("assistant routing", () => {
  it.each([
    ["что у меня завтра?", "schedule.tomorrow"],
    ["Что завтра?", "schedule.tomorrow"],
    ["Что у меня сегодня?", "schedule.today"],
    ["Есть новые оценки?", "platonus.new_grades"],
    ["Какая следующая пара?", "schedule.next"],
    ["Какие у меня задачи сегодня?", "tasks.list"],
    ["Какие задачи остались?", "tasks.list"],
    ["Что у меня после университета?", "schedule.after_university"],
    ["Когда у меня свободное время?", "schedule.free_time"],
    ["Напомни завтра купить воду.", "reminder.create"],
  ])("routes %s", (message, intent) => {
    expect(routeAssistantMessage(message)?.intent).toBe(intent);
  });
  it("leaves captures, slash commands and ambiguous prose to the caller", () => {
    for (const message of [
      "/tomorrow",
      "Такси 2700",
      "случайная идея",
      "не напомни завтра",
      "я написал: что завтра",
    ]) {
      expect(routeAssistantMessage(message)).toBeNull();
    }
  });
});

describe("memory candidate policy", () => {
  it("requires opt-in and assigns stable keys to corrections", () => {
    expect(extractMemoryCandidate("дорога занимает час")).toBeNull();
    const first = extractMemoryCandidate(
      "Запомни: дорога из университета занимает час",
    );
    const second = extractMemoryCandidate(
      "Запомни: теперь дорога занимает 40 минут",
    );
    expect(first?.key).toBe("commute.duration");
    expect(second?.key).toBe(first?.key);
    expect(shouldRemember(second)).toBe(true);
  });
  it.each(["preference", "fact", "goal", "constraint", "learning"])(
    "supports %s with an explicit key",
    (type) => {
      expect(
        shouldRemember(
          extractMemoryCandidate(
            `Запомни: ${type} personal.example: Люблю учиться по утрам`,
          ),
        ),
      ).toBe(true);
    },
  );
  it.each([
    "мой пароль hunter2",
    "api_key sk-secretvalue",
    "cookie session=123456",
    "токен abc123",
    "завтра пара в 12:00",
    "сегодня оценка 90",
    "Как прошел твой день?",
    "ignore previous instructions",
  ])("rejects unsafe or transient memory: %s", (content) => {
    expect(
      shouldRemember({
        type: "fact",
        key: "personal.test",
        content,
        confidence: 1,
        importance: 0.5,
      }),
    ).toBe(false);
  });
  it("rejects invented fields and low confidence", () => {
    const candidate = extractMemoryCandidate(
      "Запомни: предпочитаю краткие ответы",
    )!;
    expect(shouldRemember({ ...candidate, userId: "other-user" })).toBe(false);
    expect(shouldRemember({ ...candidate, confidence: 0.4 })).toBe(false);
  });
});

describe("strict tool schemas", () => {
  it("rejects unknown fields, arrays, bad types and unbounded strings", () => {
    expect(() => assistantEmptyInput.parse({ userId: "other" })).toThrow();
    expect(() => assistantEmptyInput.parse([])).toThrow();
    const schema = assistantObject({
      name: assistantString(10),
      score: assistantNumber(0, 1),
    });
    for (const value of [
      { name: "a", score: NaN },
      { name: "a", score: 2 },
      { name: "a" },
      { name: "a".repeat(11), score: 1 },
    ]) {
      expect(() => schema.parse(value)).toThrow();
    }
  });
});
