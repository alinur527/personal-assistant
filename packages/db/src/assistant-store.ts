import type { SupabaseClient } from "@supabase/supabase-js";
import {
  memorySearchTerms,
  shouldRemember,
  type AssistantAuditFinish,
  type AssistantAuditStart,
  type AssistantAuditStore,
  type AssistantMemory,
  type AssistantMemoryStore,
  type AssistantSource,
  type MemoryCandidate,
  type MemoryQuery,
} from "@lifeos/core";
import type { Database } from "./types.js";
import type { AssistantMemoryRow } from "./assistant-tables.js";

function memory(row: AssistantMemoryRow): AssistantMemory {
  return {
    id: row.id,
    userId: row.user_id,
    key: row.memory_key,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    importance: row.importance,
    source: row.source,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    archivedAt: row.archived_at,
  };
}

function assertUser(userId: string): void {
  if (!userId.trim()) throw new Error("assistant_user_required");
}

// Separate from the large operational store; no second copy of app data.
export class SupabaseAssistantStore
  implements AssistantMemoryStore, AssistantAuditStore
{
  constructor(private readonly client: SupabaseClient<Database>) {}

  async retrieve(
    userId: string,
    input: MemoryQuery,
  ): Promise<AssistantMemory[]> {
    assertUser(userId);
    const limit = Math.max(1, Math.min(20, Math.trunc(input.limit) || 6));
    let query = this.client
      .from("assistant_memories")
      .select("*")
      .eq("user_id", userId)
      .is("archived_at", null);
    if (input.types?.length) query = query.in("type", input.types);
    const terms = memorySearchTerms(input.query);
    if (terms.length) {
      // Only Unicode letters/digits reach the PostgREST filter grammar.
      query = query.or(
        terms.map((term) => `content.ilike.%${term}%`).join(","),
      );
    }
    const { data, error } = await query
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error("assistant_memory_read_failed");
    if (data.length) {
      const { error: touchError } = await this.client
        .from("assistant_memories")
        .update({ last_accessed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("archived_at", null)
        .in(
          "id",
          data.map((row) => row.id),
        );
      if (touchError) throw new Error("assistant_memory_touch_failed");
    }
    return data.map(memory);
  }

  async remember(
    userId: string,
    candidate: MemoryCandidate,
    source: AssistantSource,
  ): Promise<AssistantMemory> {
    assertUser(userId);
    if (!shouldRemember(candidate))
      throw new Error("assistant_memory_rejected");
    const { data, error } = await this.client
      .from("assistant_memories")
      .upsert(
        {
          user_id: userId,
          memory_key: candidate.key,
          type: candidate.type,
          content: candidate.content.trim(),
          confidence: candidate.confidence,
          importance: candidate.importance,
          source,
          archived_at: null,
        },
        { onConflict: "user_id,memory_key" },
      )
      .select("*")
      .single();
    if (error) throw new Error("assistant_memory_write_failed");
    return memory(data);
  }

  async archive(userId: string, key: string): Promise<boolean> {
    assertUser(userId);
    const { data, error } = await this.client
      .from("assistant_memories")
      .update({ archived_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("memory_key", key)
      .is("archived_at", null)
      .select("id");
    if (error) throw new Error("assistant_memory_archive_failed");
    return data.length > 0;
  }

  async begin(action: AssistantAuditStart): Promise<boolean> {
    assertUser(action.userId);
    const { error } = await this.client.from("assistant_actions").insert({
      user_id: action.userId,
      request_id: action.requestId,
      conversation_id: action.conversationId,
      source: action.source,
      message_length: action.messageLength,
      status: "running",
    });
    if (error?.code === "23505") return false;
    if (error) throw new Error("assistant_audit_write_failed");
    return true;
  }

  async finish(
    userId: string,
    requestId: string,
    result: AssistantAuditFinish,
  ): Promise<void> {
    assertUser(userId);
    const { error } = await this.client
      .from("assistant_actions")
      .update({
        status: result.status,
        intent: result.intent,
        tool_name: result.toolName,
        duration_ms: result.durationMs,
        error_code: result.errorCode,
      })
      .eq("user_id", userId)
      .eq("request_id", requestId)
      .eq("status", "running");
    if (error) throw new Error("assistant_audit_update_failed");
  }
}
