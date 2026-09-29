import { vi } from "vitest";
import {
  ScheduleService,
  StaticScheduleProvider,
  resolveCurrentMode,
  type AssistantAuditStore,
  type AssistantMemory,
  type AssistantMemoryStore,
} from "@lifeos/core";
import type { LifeOSStore, ReminderRecord } from "@lifeos/db";
import { AssistantBrain } from "./brain.js";
import type { AssistantRequest } from "./context.js";
import { createAssistantTools } from "./tools.js";
import type { AssistantModelProvider } from "./provider.js";

export const NOW = new Date("2026-09-28T05:00:00Z");
export const schedule = new ScheduleService(
  new StaticScheduleProvider(),
  "25-04",
  "A",
);
export const request = (
  message: string,
  id = "1",
  userId = "user-a",
): AssistantRequest => ({
  principal: {
    userId,
    status: "active",
    timezone: "Asia/Qyzylorda",
    locale: "ru",
    permissions: [
      "personal.read",
      "schedule.read",
      "reminder.write",
      "memory.write",
    ],
  },
  message,
  source: "telegram",
  conversationId: `chat:${userId}`,
  requestId: `request:${id}`,
});

export function harness(provider?: AssistantModelProvider) {
  const records = new Map<string, AssistantMemory>();
  const memories: AssistantMemoryStore = {
    retrieve: vi.fn(async (userId, query) =>
      [...records.values()]
        .filter((row) => row.userId === userId && !row.archivedAt)
        .slice(0, query.limit),
    ),
    remember: vi.fn(async (userId, candidate, source) => {
      const key = `${userId}:${candidate.key}`;
      const previous = records.get(key);
      const row: AssistantMemory = {
        ...candidate,
        id: key,
        userId,
        source,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        lastAccessedAt: null,
        archivedAt: null,
      };
      records.set(key, row);
      return row;
    }),
    archive: vi.fn(async (userId, key) => {
      const row = records.get(`${userId}:${key}`);
      if (!row || row.archivedAt) return false;
      row.archivedAt = NOW.toISOString();
      return true;
    }),
  };
  const claims = new Set<string>();
  const audit: AssistantAuditStore = {
    begin: vi.fn(async (action) => {
      const key = `${action.userId}:${action.requestId}`;
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    }),
    finish: vi.fn(async () => {}),
  };
  const reminders: ReminderRecord[] = [];
  const store = {
    resolveCurrentMode: vi.fn(async (userId: string) =>
      resolveCurrentMode(userId, { now: NOW, defaultMode: "semester" }),
    ),
    listModeAwareFocusItems: vi.fn<LifeOSStore["listModeAwareFocusItems"]>(
      async () => [],
    ),
    listSourceEvents: vi.fn<LifeOSStore["listSourceEvents"]>(async () => []),
    listAcademicRecords: vi.fn<LifeOSStore["listAcademicRecords"]>(
      async () => [],
    ),
    listGradeChanges: vi.fn<NonNullable<LifeOSStore["listGradeChanges"]>>(
      async () => [],
    ),
    listUpcomingReminders: vi.fn(async () => reminders),
    createReminder: vi.fn(async (input) => {
      const row = {
        ...input,
        id: String(reminders.length + 1),
        status: "pending",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      } as ReminderRecord;
      reminders.push(row);
      return row;
    }),
  } satisfies Partial<LifeOSStore>;
  const registry = createAssistantTools({
    store: store as unknown as LifeOSStore,
    memories,
    schedule,
    scheduleTimezone: "Asia/Qyzylorda",
  });
  const log = vi.fn();
  const brain = new AssistantBrain({
    registry,
    memories,
    audit,
    provider,
    now: () => NOW,
    log,
  });
  return { brain, registry, memories, audit, store, records, reminders, log };
}
