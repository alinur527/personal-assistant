import type {
  AssistantActionStatus,
  AssistantMemoryType,
  AssistantSource,
} from "@lifeos/core";

export type AssistantMemoryRow = {
  id: string;
  user_id: string;
  memory_key: string;
  type: AssistantMemoryType;
  content: string;
  confidence: number;
  importance: number;
  source: AssistantSource;
  revision: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  archived_at: string | null;
};

export type AssistantActionRow = {
  id: string;
  user_id: string;
  request_id: string;
  conversation_id: string;
  source: AssistantSource;
  message_length: number;
  status: AssistantActionStatus;
  intent: string | null;
  tool_name: string | null;
  duration_ms: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

type Table<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};
export type AssistantMemoryTable = Table<
  AssistantMemoryRow,
  Pick<
    AssistantMemoryRow,
    | "user_id"
    | "memory_key"
    | "type"
    | "content"
    | "confidence"
    | "importance"
    | "source"
  > &
    Partial<AssistantMemoryRow>
>;
export type AssistantActionTable = Table<
  AssistantActionRow,
  Pick<
    AssistantActionRow,
    "user_id" | "request_id" | "conversation_id" | "source" | "message_length"
  > &
    Partial<AssistantActionRow>
>;
