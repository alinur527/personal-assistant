// Small strict schemas, matching the project's dependency-free parser style.
// The same schemas describe provider output and validate it at execution time.
export interface AssistantSchema<T> {
  jsonSchema: Record<string, unknown>;
  parse(value: unknown): T;
}

export class AssistantValidationError extends Error {
  constructor() {
    super("Invalid assistant input");
    this.name = "AssistantValidationError";
  }
}

export function assistantString(
  maxLength = 500,
  minLength = 1,
): AssistantSchema<string> {
  return {
    jsonSchema: { type: "string", minLength, maxLength },
    parse(value) {
      if (
        typeof value !== "string" ||
        value.trim().length < minLength ||
        value.length > maxLength ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
      ) {
        throw new AssistantValidationError();
      }
      return value.trim();
    },
  };
}

export function assistantEnum<const T extends readonly string[]>(
  values: T,
): AssistantSchema<T[number]> {
  return {
    jsonSchema: { type: "string", enum: [...values] },
    parse(value) {
      if (typeof value !== "string" || !values.includes(value))
        throw new AssistantValidationError();
      return value as T[number];
    },
  };
}

export function assistantNumber(
  min: number,
  max: number,
): AssistantSchema<number> {
  return {
    jsonSchema: { type: "number", minimum: min, maximum: max },
    parse(value) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max
      )
        throw new AssistantValidationError();
      return value;
    },
  };
}

export function assistantNullable<T>(
  schema: AssistantSchema<T>,
): AssistantSchema<T | null> {
  return {
    jsonSchema: { anyOf: [schema.jsonSchema, { type: "null" }] },
    parse: (value) => (value === null ? null : schema.parse(value)),
  };
}

export function assistantObject<
  T extends Record<string, AssistantSchema<unknown>>,
>(shape: T): AssistantSchema<{ [K in keyof T]: ReturnType<T[K]["parse"]> }> {
  return {
    jsonSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(shape).map(([key, schema]) => [key, schema.jsonSchema]),
      ),
      required: Object.keys(shape),
      additionalProperties: false,
    },
    parse(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new AssistantValidationError();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((key) => !Object.hasOwn(shape, key)))
        throw new AssistantValidationError();
      return Object.fromEntries(
        Object.entries(shape).map(([key, schema]) => [
          key,
          schema.parse(record[key]),
        ]),
      ) as { [K in keyof T]: ReturnType<T[K]["parse"]> };
    },
  };
}

export const assistantEmptyInput = assistantObject({});
export const assistantTextOutput = assistantObject({
  text: assistantString(12000),
});
