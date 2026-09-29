import type { AssistantSchema } from "./schema.js";

export type AssistantSource = "telegram" | "tma" | "web";
export type AssistantEffect = "READ" | "WRITE" | "DESTRUCTIVE" | "SENSITIVE";
export type AssistantPermission =
  | "personal.read"
  | "reminder.write"
  | "memory.write"
  | "schedule.read";
export type AssistantMemoryType =
  | "preference"
  | "fact"
  | "goal"
  | "constraint"
  | "learning";

export interface MemoryCandidate {
  type: AssistantMemoryType;
  key: string;
  content: string;
  confidence: number;
  importance: number;
}

export interface AssistantMemory extends MemoryCandidate {
  id: string;
  userId: string;
  source: AssistantSource;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  archivedAt: string | null;
}

export interface MemoryQuery {
  query: string;
  types?: AssistantMemoryType[];
  limit: number;
}

// A future vector retriever can implement this port without changing the Brain.
export interface AssistantMemoryStore {
  retrieve(userId: string, query: MemoryQuery): Promise<AssistantMemory[]>;
  remember(
    userId: string,
    candidate: MemoryCandidate,
    source: AssistantSource,
  ): Promise<AssistantMemory>;
  archive(userId: string, key: string): Promise<boolean>;
}

export type AssistantActionStatus =
  | "running"
  | "succeeded"
  | "rejected"
  | "failed"
  | "unhandled";
export type AssistantErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "unknown_tool"
  | "confirmation_required"
  | "handler_error"
  | "model_error"
  | "storage_error"
  | "busy";

export interface AssistantAuditStart {
  userId: string;
  requestId: string;
  conversationId: string;
  source: AssistantSource;
  messageLength: number;
}

export interface AssistantAuditFinish {
  status: Exclude<AssistantActionStatus, "running">;
  intent: string | null;
  toolName: string | null;
  durationMs: number;
  errorCode: AssistantErrorCode | null;
}

export interface AssistantAuditStore {
  // Atomic unique insert. A duplicate must never re-execute a write.
  begin(action: AssistantAuditStart): Promise<boolean>;
  finish(
    userId: string,
    requestId: string,
    result: AssistantAuditFinish,
  ): Promise<void>;
}

export interface AssistantPrincipal {
  userId: string;
  status: "active" | "pending" | "blocked";
  timezone: string;
  locale: string;
  permissions: readonly AssistantPermission[];
}

export interface AssistantContext extends AssistantPrincipal {
  source: AssistantSource;
  conversationId: string;
  requestId: string;
  currentDateTime: string;
  relevantMemories: readonly AssistantMemory[];
  // Derived by the server from an explicit deterministic request, never a model.
  authorizedWrite: { tool: string; arguments: Record<string, unknown> } | null;
}

export interface AssistantTool<I, O> {
  name: string;
  description: string;
  effect: AssistantEffect;
  permission: AssistantPermission;
  inputSchema: AssistantSchema<I>;
  outputSchema: AssistantSchema<O>;
  execute(context: AssistantContext, input: I): Promise<O>;
}

export interface AssistantRoute {
  intent: string;
  tool: string;
  confidence: number;
  arguments: Record<string, unknown>;
  via: "rules" | "model";
}
