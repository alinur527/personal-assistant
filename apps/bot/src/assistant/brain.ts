import {
  assistantString,
  containsAssistantSecret,
  routeAssistantMessage,
  type AssistantAuditStore,
  type AssistantErrorCode,
  type AssistantMemoryStore,
  type AssistantRoute,
} from "@lifeos/core";
import { buildAssistantContext, type AssistantRequest } from "./context.js";
import { parseModelRoute, type AssistantModelProvider } from "./provider.js";
import { AssistantExecutionError, AssistantToolRegistry } from "./registry.js";

export interface AssistantReply {
  handled: boolean;
  text: string;
  status: "succeeded" | "rejected" | "failed" | "unhandled";
  intent: string | null;
}

const ERRORS: Record<AssistantErrorCode, string> = {
  invalid_input: "Не удалось разобрать запрос. Уточните формулировку и время.",
  unauthorized: "Этот инструмент недоступен вашему профилю.",
  unknown_tool: "Такой инструмент пока недоступен.",
  confirmation_required:
    "Для записи нужна явная команда: например, «Напомни завтра в 19:00 купить воду».",
  handler_error:
    "Не удалось выполнить запрос. Проверьте данные через обычную команду бота.",
  model_error:
    "Не удалось определить действие. Попробуйте уточнить запрос или использовать команду бота.",
  storage_error:
    "Хранилище ассистента недоступно. Обычные команды бота доступны.",
  busy: "Предыдущий запрос ещё обрабатывается. Повторите чуть позже.",
};

export class AssistantBrain {
  private readonly activeUsers = new Set<string>();
  constructor(
    private readonly options: {
      registry: AssistantToolRegistry;
      memories: AssistantMemoryStore;
      audit: AssistantAuditStore;
      provider?: AssistantModelProvider;
      now?: () => Date;
      log?: (event: { requestId: string; code: AssistantErrorCode }) => void;
    },
  ) {}

  async handle(request: AssistantRequest): Promise<AssistantReply> {
    const fail = (code: AssistantErrorCode): AssistantReply => ({
      handled: true,
      text: ERRORS[code],
      status: "rejected",
      intent: null,
    });
    if (
      request.principal.status !== "active" ||
      !request.principal.userId.trim()
    )
      return fail("unauthorized");
    try {
      assistantString(4096).parse(request.message);
      for (const id of [request.requestId, request.conversationId]) {
        assistantString(120).parse(id);
        if (!/^[a-zA-Z0-9:_-]+$/.test(id))
          throw new Error("invalid_identifier");
      }
    } catch {
      return fail("invalid_input");
    }
    if (
      this.activeUsers.has(request.principal.userId) ||
      this.activeUsers.size >= 100
    )
      return fail("busy");
    this.activeUsers.add(request.principal.userId);
    const started = Date.now();
    let claimed = false;
    let route: AssistantRoute | null = routeAssistantMessage(request.message);
    let errorCode: AssistantErrorCode | null = null;
    let reply: AssistantReply = {
      handled: false,
      text: "",
      status: "unhandled",
      intent: null,
    };
    try {
      claimed = await this.options.audit.begin({
        userId: request.principal.userId,
        requestId: request.requestId,
        conversationId: request.conversationId,
        source: request.source,
        messageLength: request.message.length,
      });
      if (!claimed)
        return {
          ...fail("busy"),
          text: "Этот запрос уже принят. Повторное действие не выполнялось; результат записи можно проверить через /reminders или «Покажи память».",
        };
      const context = await buildAssistantContext(
        request,
        this.options.memories,
        this.options.now?.() ?? new Date(),
        route,
        Boolean(this.options.provider),
      );
      if (
        !route &&
        this.options.provider &&
        !containsAssistantSecret(request.message)
      ) {
        try {
          route = parseModelRoute(
            await this.options.provider.classify({
              message: request.message,
              context,
              tools: this.options.registry.describe(context),
            }),
          );
        } catch {
          throw new AssistantExecutionError("model_error");
        }
      }
      if (route) {
        const result = await this.options.registry.execute(
          route.tool,
          context,
          route.arguments,
        );
        reply = {
          handled: true,
          text: result.text,
          status: "succeeded",
          intent: route.intent,
        };
      }
    } catch (error) {
      errorCode =
        error instanceof AssistantExecutionError ? error.code : "storage_error";
      reply = {
        ...fail(errorCode),
        status: "failed",
        intent: route?.intent ?? null,
      };
    } finally {
      if (claimed) {
        try {
          await this.options.audit.finish(
            request.principal.userId,
            request.requestId,
            {
              status: reply.status,
              intent:
                route && this.options.registry.has(route.tool)
                  ? route.intent
                  : null,
              toolName:
                route && this.options.registry.has(route.tool)
                  ? route.tool
                  : null,
              durationMs: Math.min(2147483647, Date.now() - started),
              errorCode,
            },
          );
        } catch {
          // Never throw after a successful mutation: Telegram retries must not repeat it.
          this.options.log?.({
            requestId: request.requestId,
            code: "storage_error",
          });
        }
      }
      this.activeUsers.delete(request.principal.userId);
    }
    return reply;
  }
}
