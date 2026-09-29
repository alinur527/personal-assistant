import { describe, expect, it, vi } from "vitest";
import type { SourceEventRecord } from "@lifeos/db";
import { assistantFreeWindows } from "@lifeos/core";
import { parseAssistantReminder } from "./reminder-input.js";
import { harness, request } from "./test-helpers.js";

const event = (overrides: Partial<SourceEventRecord>): SourceEventRecord => ({
  id: "hidden-id",
  userId: "user-a",
  sourceKey: "google_calendar",
  externalId: null,
  eventType: "event",
  title: "Meeting",
  description: null,
  location: null,
  startsAt: "2026-09-28T08:00:00Z",
  endsAt: "2026-09-28T09:00:00Z",
  dueAt: null,
  status: "active",
  rawJson: {},
  normalizedEntityId: null,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
  ...overrides,
});

describe("existing-service adapters", () => {
  it("does not mix other university providers into Platonus grades", async () => {
    const h = harness();
    await h.brain.handle(request("Покажи оценки"));
    expect(h.store.listSourceEvents).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({
        externalIdPrefix: "academic:platonus:",
        status: "active",
      }),
    );
    expect(h.store.listAcademicRecords).toHaveBeenCalledWith("user-a", []);
  });
  it("queries today's task boundary in the user's timezone", async () => {
    const h = harness();
    await h.brain.handle(request("Какие у меня задачи сегодня?"));
    expect(h.store.listModeAwareFocusItems).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-a",
        dueBeforeOrUnscheduled: "2026-09-28T18:59:59.999Z",
      }),
    );
    expect(h.store.listSourceEvents).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ sourceKey: "google_tasks", status: "active" }),
    );
  });
  it("uses the change ledger for new grades, not all stored grades", async () => {
    const h = harness();
    const reply = await h.brain.handle(request("Есть новые оценки?"));
    expect(reply.text).toContain("7 дней");
    expect(h.store.listGradeChanges).toHaveBeenCalledWith(
      "user-a",
      "2026-09-21T05:00:00.000Z",
      20,
    );
    expect(h.store.listAcademicRecords).not.toHaveBeenCalled();
  });
  it("formats only safe calendar fields, excluding raw provider data", async () => {
    const h = harness();
    vi.mocked(h.store.listSourceEvents).mockResolvedValue([
      event({
        id: "hidden-id",
        userId: "user-a",
        title: "<b>meeting</b>",
        startsAt: "2026-09-28T08:00:00Z",
        endsAt: "2026-09-28T09:00:00Z",
        rawJson: { access_token: "hidden-token" },
      }),
    ]);
    const reply = await h.brain.handle(request("Покажи календарь"));
    expect(reply.text).toContain("&lt;b&gt;meeting&lt;/b&gt;");
    expect(reply.text).not.toContain("hidden-");
    expect(h.store.listSourceEvents).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ overlapsAfter: "2026-09-27T19:00:00.000Z" }),
    );
  });
  it("refuses confident availability when calendar data has no ending", async () => {
    const h = harness();
    h.store.listSourceEvents.mockResolvedValue([event({ endsAt: null })]);
    expect(
      (await h.brain.handle(request("Когда у меня свободное время?"))).text,
    ).toContain("без точного времени окончания");
  });
  it("merges overlapping busy intervals before computing free time", () => {
    expect(
      assistantFreeWindows({ start: 0, end: 100 }, [
        { start: -5, end: 10 },
        { start: 20, end: 60 },
        { start: 30, end: 40 },
        { start: 50, end: 70 },
        { start: 90, end: 200 },
      ]),
    ).toEqual([
      { start: 10, end: 20 },
      { start: 70, end: 90 },
    ]);
  });
  it("uses calendar days across DST instead of adding 24 hours", () => {
    expect(
      parseAssistantReminder(
        "Напомни завтра в 09:00 прочесть письмо",
        new Date("2026-10-24T22:30:00Z"),
        "Europe/Berlin",
      ),
    ).toMatchObject({ ok: true, remindAt: "2026-10-26T08:00:00.000Z" });
  });
});
