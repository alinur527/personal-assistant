import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./types.js";
import { SupabaseAssistantStore } from "./assistant-store.js";
import { SupabaseLifeOSStore } from "./lifeos-store.js";

const row = {
  id: "memory-1",
  user_id: "user-a",
  memory_key: "commute.duration",
  type: "fact",
  content: "Дорога занимает час",
  confidence: 1,
  importance: 0.7,
  source: "telegram",
  revision: 1,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  last_accessed_at: null,
  archived_at: null,
};
const candidate = {
  type: "fact" as const,
  key: "commute.duration",
  content: row.content,
  confidence: 1,
  importance: 0.7,
};

function fixture(responses: Array<{ body: unknown; status?: number }>) {
  const calls: Array<{
    url: URL;
    method: string;
    body: Record<string, unknown>;
  }> = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, options?: RequestInit) => {
      calls.push({
        url: new URL(String(input)),
        method: options?.method ?? "GET",
        body: options?.body ? JSON.parse(String(options.body)) : {},
      });
      const response = responses.shift() ?? { body: null };
      return new Response(JSON.stringify(response.body), {
        status: response.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const client = createClient<Database>(
    "https://test.invalid",
    "local-test-placeholder",
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetcher },
    },
  );
  return {
    calls,
    fetcher,
    store: new SupabaseAssistantStore(client),
    operational: new SupabaseLifeOSStore(client),
  };
}

describe("Supabase assistant persistence boundaries", () => {
  it("retrieves a bounded, active, user-scoped slice and scopes access touches", async () => {
    const h = fixture([{ body: [row] }, { body: null }]);
    const result = await h.store.retrieve("user-a", {
      query: "дорога,or(user_id.eq.other)",
      types: ["fact"],
      limit: 999,
    });
    expect(result[0]).toMatchObject({ userId: "user-a", key: candidate.key });
    const query = h.calls[0]!.url.searchParams;
    expect(query.get("user_id")).toBe("eq.user-a");
    expect(query.get("archived_at")).toBe("is.null");
    expect(query.get("limit")).toBe("20");
    expect(query.get("type")).toBe("in.(fact)");
    expect(query.get("or")).not.toContain("user_id.eq.other");
    expect(h.calls[1]!.url.searchParams.get("user_id")).toBe("eq.user-a");
    expect(h.calls[1]!.url.searchParams.get("archived_at")).toBe("is.null");
  });
  it("uses a different ownership predicate for User B", async () => {
    const h = fixture([{ body: [] }, { body: [] }]);
    await h.store.retrieve("user-a", { query: "", limit: 4 });
    await h.store.retrieve("user-b", { query: "", limit: 4 });
    expect(h.calls.map((call) => call.url.searchParams.get("user_id"))).toEqual(
      ["eq.user-a", "eq.user-b"],
    );
  });
  it("creates/updates atomically on the user's semantic key", async () => {
    const h = fixture([{ body: row }]);
    await h.store.remember("user-a", candidate, "telegram");
    expect(h.calls[0]!.url.searchParams.get("on_conflict")).toBe(
      "user_id,memory_key",
    );
    expect(h.calls[0]!.body).toMatchObject({
      user_id: "user-a",
      memory_key: "commute.duration",
      content: candidate.content,
      archived_at: null,
    });
  });
  it("rejects unsafe candidates before any DB request", async () => {
    const h = fixture([]);
    await expect(
      h.store.remember(
        "user-a",
        { ...candidate, content: "мой пароль hunter2" },
        "telegram",
      ),
    ).rejects.toThrow("rejected");
    await expect(
      h.store.retrieve("", { query: "", limit: 5 }),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("archives only the requested owner's active row", async () => {
    const h = fixture([{ body: [] }, { body: [{ id: "memory-1" }] }]);
    expect(await h.store.archive("user-b", "commute.duration")).toBe(false);
    expect(await h.store.archive("user-a", "commute.duration")).toBe(true);
    expect(h.calls[0]!.url.searchParams.get("user_id")).toBe("eq.user-b");
    expect(h.calls[1]!.url.searchParams.get("memory_key")).toBe(
      "eq.commute.duration",
    );
  });
  it("handles action claim conflicts without accepting a second execution", async () => {
    const h = fixture([
      { body: null },
      { status: 409, body: { code: "23505" } },
    ]);
    const action = {
      userId: "user-a",
      requestId: "telegram:1:1",
      conversationId: "telegram:1",
      source: "telegram" as const,
      messageLength: 20,
    };
    expect(await h.store.begin(action)).toBe(true);
    expect(await h.store.begin(action)).toBe(false);
    expect(h.calls[0]!.body).not.toHaveProperty("message");
    expect(h.calls[0]!.body).not.toHaveProperty("arguments");
  });
  it("fails closed for non-conflict DB errors and hides details", async () => {
    const h = fixture([
      {
        status: 401,
        body: { code: "42501", message: "service-role-key=secret" },
      },
    ]);
    await expect(
      h.store.begin({
        userId: "user-a",
        requestId: "1",
        conversationId: "1",
        source: "telegram",
        messageLength: 1,
      }),
    ).rejects.toThrow("assistant_audit_write_failed");
  });
  it("scopes audit completion by owner, request and running status", async () => {
    const h = fixture([]);
    await h.store.finish("user-a", "telegram:1:1", {
      status: "succeeded",
      toolName: "schedule.get_today",
      intent: "schedule.today",
      durationMs: 3,
      errorCode: null,
    });
    expect(Object.fromEntries(h.calls[0]!.url.searchParams)).toEqual({
      user_id: "eq.user-a",
      request_id: "eq.telegram:1:1",
      status: "eq.running",
    });
  });
});

describe("assistant extensions to existing operational store", () => {
  it("gets real Platonus changes from the notification ledger scoped to user/time", async () => {
    const h = fixture([
      {
        body: [
          {
            created_at: "2026-09-29T00:00:00Z",
            metadata_json: {
              course_title: "Math",
              assessment_title: "Lab",
              score: "90",
              max_score: "100",
              raw_secret: "never return",
            },
          },
        ],
      },
    ]);
    const result = await h.operational.listGradeChanges(
      "user-a",
      "2026-09-22T00:00:00Z",
      20,
    );
    expect(result).toEqual([
      {
        courseTitle: "Math",
        title: "Lab",
        score: "90",
        maxScore: "100",
        changedAt: "2026-09-29T00:00:00Z",
      },
    ]);
    expect(h.calls[0]!.url.searchParams.get("user_id")).toBe("eq.user-a");
    expect(h.calls[0]!.url.searchParams.get("reminder_policy_key")).toBe(
      "eq.platonus_grade",
    );
    expect(h.calls[0]!.url.searchParams.get("created_at")).toBe(
      "gte.2026-09-22T00:00:00Z",
    );
  });
  it("filters academic rows by source event before limiting results", async () => {
    const h = fixture([{ body: [] }]);
    await h.operational.listAcademicRecords("user-a", ["grade-1"]);
    expect(h.calls[0]!.url.searchParams.get("source_event_id")).toBe(
      "in.(grade-1)",
    );
    expect(h.calls[0]!.url.searchParams.get("user_id")).toBe("eq.user-a");
  });
  it("includes overlapping calendar events and excludes other users", async () => {
    const h = fixture([{ body: [] }]);
    await h.operational.listSourceEvents("user-a", {
      sourceKey: "google_calendar",
      status: "active",
      overlapsAfter: "2026-09-28T19:00:00Z",
      before: "2026-09-29T19:00:00Z",
    });
    const query = h.calls[0]!.url.searchParams;
    expect(query.get("user_id")).toBe("eq.user-a");
    expect(query.getAll("or").join(" ")).toContain(
      "ends_at.gt.2026-09-28T19:00:00.000Z",
    );
    expect(query.get("source_key")).toBe("eq.google_calendar");
  });
  it("filters the grade provider before applying a limit", async () => {
    const h = fixture([{ body: [] }]);
    await h.operational.listSourceEvents("user-a", {
      sourceKey: "university_platform",
      externalIdPrefix: "academic:platonus:",
      recentFirst: true,
      limit: 20,
    });
    expect(h.calls[0]!.url.searchParams.get("external_id")).toBe(
      "like.academic:platonus:%",
    );
  });
  it("applies today's task filter before query limits", async () => {
    const h = fixture([{ body: [] }]);
    await h.operational.listModeAwareFocusItems({
      userId: "user-a",
      mode: "semester",
      dueBeforeOrUnscheduled: "2026-09-29T19:00:00Z",
    });
    expect(h.calls[0]!.url.searchParams.get("or")).toContain(
      "due_at.is.null,due_at.lte.2026-09-29T19:00:00.000Z",
    );
    expect(h.calls[0]!.url.searchParams.get("user_id")).toBe("eq.user-a");
  });
});
