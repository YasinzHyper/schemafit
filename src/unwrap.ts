import type { JsonSchema } from "./types.js";
import { isJsonSchema } from "./walk.js";

export interface Unwrapped {
  schema: unknown;
  /** Which wrapper the schema was found in, or `null` when the document is a bare schema. */
  wrapper: string | null;
  /** The keys leading from the document to the schema. Empty for a bare schema. */
  keys: readonly string[];
}

/**
 * Schemas are usually written inside a tool or response-format definition.
 * Finds the JSON Schema inside the common wrappers; returns bare schemas untouched.
 */
export function unwrap(document: unknown): Unwrapped {
  if (!isJsonSchema(document)) return { schema: document, wrapper: null, keys: [] };

  const fn = document.function;
  if (document.type === "function" && isJsonSchema(fn) && "parameters" in fn) {
    return {
      schema: fn.parameters,
      wrapper: "OpenAI Chat Completions tool (function.parameters)",
      keys: ["function", "parameters"],
    };
  }
  if (document.type === "function" && "parameters" in document) {
    return { schema: document.parameters, wrapper: "OpenAI Responses tool (parameters)", keys: ["parameters"] };
  }

  const jsonSchema = document.json_schema;
  if (document.type === "json_schema" && isJsonSchema(jsonSchema) && "schema" in jsonSchema) {
    return {
      schema: jsonSchema.schema,
      wrapper: "OpenAI response_format (json_schema.schema)",
      keys: ["json_schema", "schema"],
    };
  }
  if (document.type === "json_schema" && "schema" in document) {
    return { schema: document.schema, wrapper: "output format (schema)", keys: ["schema"] };
  }

  if ("input_schema" in document) {
    return { schema: document.input_schema, wrapper: "Anthropic tool (input_schema)", keys: ["input_schema"] };
  }
  if ("inputSchema" in document) {
    return { schema: document.inputSchema, wrapper: "MCP tool (inputSchema)", keys: ["inputSchema"] };
  }

  // { name, schema } and { name, parameters } definitions. A bare schema never has a string "name"
  // alongside these keys, because neither is a JSON Schema keyword.
  if (typeof document.name === "string" && !("properties" in document)) {
    if ("schema" in document) return { schema: document.schema, wrapper: "named schema (schema)", keys: ["schema"] };
    if ("parameters" in document) {
      return { schema: document.parameters, wrapper: "function definition (parameters)", keys: ["parameters"] };
    }
  }

  return { schema: document, wrapper: null, keys: [] };
}

/**
 * Puts a rewritten `schema` back where `unwrap` found it, so a fixed tool definition
 * keeps its name, description, and the rest of its fields. Returns a new document.
 */
export function rewrap(document: unknown, keys: readonly string[], schema: JsonSchema): unknown {
  if (keys.length === 0) return schema;

  const clone = structuredClone(document);
  let container = clone as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) container = container[key] as Record<string, unknown>;
  container[keys[keys.length - 1] as string] = schema;
  return clone;
}
