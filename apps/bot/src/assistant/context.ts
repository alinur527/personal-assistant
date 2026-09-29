import { DateTime } from "luxon";
import type {
  AssistantContext,
  AssistantMemoryStore,
  AssistantPrincipal,
  AssistantRoute,
  AssistantSource,
} from "@lifeos/core";

export interface AssistantRequest {
  principal: AssistantPrincipal;
  message: string;
  source: AssistantSource;
  conversationId: string;
  requestId: string;
}

export async function buildAssistantContext(
  request: AssistantRequest,
  memories: AssistantMemoryStore,
  now: Date,
  route: AssistantRoute | null,
  retrieveMemory = true,
): Promise<AssistantContext> {
  const local = DateTime.fromJSDate(now).setZone(request.principal.timezone);
  if (!local.isValid) throw new Error("invalid_timezone");
  // Reads with fixed service answers need no personal-memory retrieval.
  // Unknown requests get a small relevant slice for classification only.
  const relevantMemories =
    route || !retrieveMemory
      ? []
      : (
          await memories.retrieve(request.principal.userId, {
            query: request.message,
            limit: 4,
          })
        )
          .filter(
            (memory) =>
              memory.userId === request.principal.userId && !memory.archivedAt,
          )
          .slice(0, 4);
  return {
    ...request.principal,
    source: request.source,
    conversationId: request.conversationId,
    requestId: request.requestId,
    currentDateTime: local.toISO()!,
    relevantMemories,
    authorizedWrite:
      route?.via === "rules"
        ? { tool: route.tool, arguments: route.arguments }
        : null,
  };
}
