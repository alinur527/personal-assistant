import { isDeepStrictEqual } from "node:util";
import {
  AssistantValidationError,
  type AssistantContext,
  type AssistantErrorCode,
  type AssistantTool,
} from "@lifeos/core";

export class AssistantExecutionError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
  }
}

export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface RegisteredTool {
  descriptor: ToolDescription;
  available(context: AssistantContext): boolean;
  isRead: boolean;
  run(context: AssistantContext, input: unknown): Promise<{ text: string }>;
}

export class AssistantToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register<I, O extends { text: string }>(tool: AssistantTool<I, O>): this {
    if (!/^[a-z][a-z0-9_.]{0,79}$/.test(tool.name) || this.tools.has(tool.name))
      throw new Error("Invalid or duplicate tool name");
    const available = (context: AssistantContext) =>
      context.status === "active" &&
      context.permissions.includes(tool.permission) &&
      tool.effect !== "DESTRUCTIVE" &&
      tool.effect !== "SENSITIVE";
    this.tools.set(tool.name, {
      descriptor: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema.jsonSchema,
      },
      available,
      isRead: tool.effect === "READ",
      async run(context, rawInput) {
        let input: I;
        try {
          input = tool.inputSchema.parse(rawInput);
        } catch {
          throw new AssistantExecutionError("invalid_input");
        }
        if (!available(context))
          throw new AssistantExecutionError("unauthorized");
        if (
          tool.effect === "WRITE" &&
          (context.authorizedWrite?.tool !== tool.name ||
            !isDeepStrictEqual(context.authorizedWrite.arguments, rawInput))
        ) {
          throw new AssistantExecutionError("confirmation_required");
        }
        try {
          return tool.outputSchema.parse(await tool.execute(context, input));
        } catch (error) {
          if (error instanceof AssistantExecutionError) throw error;
          if (error instanceof AssistantValidationError)
            throw new AssistantExecutionError("invalid_input");
          throw new AssistantExecutionError("handler_error");
        }
      },
    });
    return this;
  }

  describe(context: AssistantContext): ToolDescription[] {
    // Phase 1 model classification is read-only. Explicit rules authorize writes.
    return [...this.tools.values()]
      .filter((tool) => tool.isRead && tool.available(context))
      .map((tool) => tool.descriptor);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    context: AssistantContext,
    input: unknown,
  ): Promise<{ text: string }> {
    const tool = this.tools.get(name);
    if (!tool) throw new AssistantExecutionError("unknown_tool");
    return tool.run(context, input);
  }
}
