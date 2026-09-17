import { isJsonSchema } from "./walk.js";

export interface Unwrapped {
  schema: unknown;
  /** Which wrapper the schema was found in, or `null` when the document is a bare schema. */
  wrapper: string | null;
}

/**
 * Schemas are usually written inside a tool or response-format definition.
 * Finds the JSON Schema inside the common wrappers; returns bare schemas untouched.
 */
export function unwrap(document: unknown): Unwrapped {
  if (!isJsonSchema(document)) return { schema: document, wrapper: null };

  const fn = document.function;
  if (document.type === "function" && isJsonSchema(fn) && "parameters" in fn) {
    return { schema: fn.parameters, wrapper: "OpenAI Chat Completions tool (function.parameters)" };
  }
  if (document.type === "function" && "parameters" in document) {
    return { schema: document.parameters, wrapper: "OpenAI Responses tool (parameters)" };
  }

  const jsonSchema = document.json_schema;
  if (document.type === "json_schema" && isJsonSchema(jsonSchema) && "schema" in jsonSchema) {
    return { schema: jsonSchema.schema, wrapper: "OpenAI response_format (json_schema.schema)" };
  }
  if (document.type === "json_schema" && "schema" in document) {
    return { schema: document.schema, wrapper: "output format (schema)" };
  }

  if ("input_schema" in document) {
    return { schema: document.input_schema, wrapper: "Anthropic tool (input_schema)" };
  }
  if ("inputSchema" in document) {
    return { schema: document.inputSchema, wrapper: "MCP tool (inputSchema)" };
  }

  // { name, schema } and { name, parameters } definitions. A bare schema never has a string "name"
  // alongside these keys, because neither is a JSON Schema keyword.
  if (typeof document.name === "string" && !("properties" in document)) {
    if ("schema" in document) return { schema: document.schema, wrapper: "named schema (schema)" };
    if ("parameters" in document) return { schema: document.parameters, wrapper: "function definition (parameters)" };
  }

  return { schema: document, wrapper: null };
}
