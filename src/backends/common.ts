import { ApiError, type JsonSchema } from "../types.js";

export function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const str = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", description, ...extra });
export const num = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "number", description, ...extra });
export const int = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "integer", description, ...extra });
export const bool = (description: string): JsonSchema => ({ type: "boolean", description });
export const strList = (description: string): JsonSchema => ({ type: "array", items: { type: "string" }, description });
export const idSchema = (description: string): JsonSchema => ({ type: ["string", "integer"], description });

export const IDEMPOTENCY_KEY: JsonSchema = {
  type: "string",
  description: "Optional. Repeating a write with the same key returns the first result instead of writing again.",
};

/** Fail closed: a missing or empty required parameter is an error, not a silent no-op. */
export function required<T = unknown>(input: Record<string, unknown> | undefined, ...keys: string[]): T {
  for (const key of keys) {
    const value = input?.[key];
    if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0)) {
      return value as T;
    }
  }
  throw new ApiError(422, "invalid_request", `Missing required parameter: ${keys[0]}`);
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

export function stringList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String).filter((s) => s !== "");
  return String(value)
    .split(/[\s,]+/)
    .filter((s) => s !== "");
}
