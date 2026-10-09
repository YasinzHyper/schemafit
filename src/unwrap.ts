import { joinPointer, resolvePointer } from "./pointer.js";
import type { JsonSchema, SchemaKind } from "./types.js";
import { isJsonSchema } from "./walk.js";

export interface Unwrapped {
  schema: unknown;
  /** Which wrapper the schema was found in, or `null` when the document is a bare schema. */
  wrapper: string | null;
  /** The keys leading from the document to the schema. Empty for a bare schema. */
  keys: readonly string[];
  /** What the wrapper declares the schema as. `null` when the document is a bare schema. */
  kind: SchemaKind;
}

/**
 * Schemas are usually written inside a tool or response-format definition.
 * Finds the JSON Schema inside the common wrappers; returns bare schemas untouched.
 */
export function unwrap(document: unknown): Unwrapped {
  if (!isJsonSchema(document)) return { schema: document, wrapper: null, keys: [], kind: null };

  const fn = document.function;
  if (document.type === "function" && isJsonSchema(fn) && "parameters" in fn) {
    return {
      schema: fn.parameters,
      wrapper: "OpenAI Chat Completions tool (function.parameters)",
      keys: ["function", "parameters"],
      kind: "tool",
    };
  }
  if (document.type === "function" && "parameters" in document) {
    return {
      schema: document.parameters,
      wrapper: "OpenAI Responses tool (parameters)",
      keys: ["parameters"],
      kind: "tool",
    };
  }

  const jsonSchema = document.json_schema;
  if (document.type === "json_schema" && isJsonSchema(jsonSchema) && "schema" in jsonSchema) {
    return {
      schema: jsonSchema.schema,
      wrapper: "OpenAI response_format (json_schema.schema)",
      keys: ["json_schema", "schema"],
      kind: "format",
    };
  }
  if (document.type === "json_schema" && "schema" in document) {
    return { schema: document.schema, wrapper: "output format (schema)", keys: ["schema"], kind: "format" };
  }

  if ("input_schema" in document) {
    return {
      schema: document.input_schema,
      wrapper: "Anthropic tool (input_schema)",
      keys: ["input_schema"],
      kind: "tool",
    };
  }
  if ("inputSchema" in document) {
    return { schema: document.inputSchema, wrapper: "MCP tool (inputSchema)", keys: ["inputSchema"], kind: "tool" };
  }

  // { name, schema } and { name, parameters } definitions. A bare schema never has a string "name"
  // alongside these keys, because neither is a JSON Schema keyword.
  if (typeof document.name === "string" && !("properties" in document)) {
    if ("schema" in document) {
      return { schema: document.schema, wrapper: "named schema (schema)", keys: ["schema"], kind: "format" };
    }
    if ("parameters" in document) {
      return {
        schema: document.parameters,
        wrapper: "function definition (parameters)",
        keys: ["parameters"],
        kind: "tool",
      };
    }
  }

  return { schema: document, wrapper: null, keys: [], kind: null };
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

/** One of the schemas a document holds, with where in the document it was found. */
export interface UnwrappedSchema extends Unwrapped {
  /** JSON Pointer from the document to the schema. Empty when the document is the schema. */
  pointer: string;
  /** The name the tool or response-format definition carries, when it has one. */
  name?: string;
  /**
   * What the declaration says about `strict`, when it says anything at all: Anthropic's strict
   * tool use and OpenAI's strict mode are both a `strict` beside the schema, and the limits a
   * provider states per request count the schemas it is set on.
   */
  strict?: boolean;
}

/**
 * What the definition says about `strict`. It sits on the object that holds the schema — the
 * tool itself for Anthropic's `input_schema`, the `function` of a Chat Completions tool, the
 * `json_schema` of a response format — so that is where it is read from.
 */
function strictFlag(definition: unknown, keys: readonly string[]): boolean | undefined {
  let holder: unknown = definition;
  for (const key of keys.slice(0, -1)) {
    if (!isJsonSchema(holder)) return undefined;
    holder = holder[key];
  }
  if (!isJsonSchema(holder) || typeof holder.strict !== "boolean") return undefined;
  return holder.strict;
}

/** The name a tool or response-format definition carries, for the report. */
function definitionName(definition: unknown): string | undefined {
  if (!isJsonSchema(definition)) return undefined;
  for (const nested of [definition.function, definition.json_schema]) {
    if (isJsonSchema(nested) && typeof nested.name === "string") return nested.name;
  }
  return typeof definition.name === "string" ? definition.name : undefined;
}

/** `unwrap` of one entry of a request body, with its keys prefixed and its name attached. */
function found(definition: unknown, prefix: readonly string[]): UnwrappedSchema {
  const { schema, wrapper, keys, kind } = unwrap(definition);
  // A bare schema is its own document: it declares neither a name nor a strictness, and a
  // keyword of its own named "strict" says nothing about how the request sends it.
  const name = wrapper === null ? undefined : definitionName(definition);
  const strict = wrapper === null ? undefined : strictFlag(definition, keys);
  const all = [...prefix, ...keys];
  return {
    schema,
    wrapper,
    keys: all,
    kind,
    pointer: joinPointer("", ...all),
    ...(name ? { name } : {}),
    ...(strict === undefined ? {} : { strict }),
  };
}

/**
 * The slots a request body declares the format of the model's output in: OpenAI's
 * `response_format` (Gemini's spelling too), the Responses API's `text.format`, and Anthropic's
 * `output_config.format`, together with the `output_format` it is deprecating.
 */
const FORMAT_SLOTS: readonly (readonly string[])[] = [
  ["response_format"],
  ["text", "format"],
  ["output_config", "format"],
  ["output_format"],
];

/** Whether `document` declares anything a request body declares a schema in. */
function isRequestBody(document: JsonSchema): boolean {
  if (Array.isArray(document.tools)) return true;
  return FORMAT_SLOTS.some((keys) => isJsonSchema(resolvePointer(document, joinPointer("", ...keys))));
}

/**
 * Every tool in a `tools` array, recursing into the nested `tools` of an OpenAI namespace.
 * A tool `unwrap` finds no wrapper in declares no schema — a server tool such as
 * `{ "type": "web_search_20260209", "name": "web_search" }`, or an OpenAI built-in — and is
 * skipped rather than linted as if the definition itself were a schema.
 */
function unwrapTools(tools: readonly unknown[], prefix: readonly string[]): UnwrappedSchema[] {
  return tools.flatMap((tool, index) => {
    const keys = [...prefix, String(index)];
    if (isJsonSchema(tool) && Array.isArray(tool.tools)) return unwrapTools(tool.tools, [...keys, "tools"]);
    const entry = found(tool, keys);
    return entry.wrapper === null ? [] : [entry];
  });
}

/**
 * The schema an output-format slot declares. `unwrap` knows the OpenAI and Anthropic spellings,
 * both of them a `{ "type": "json_schema", "schema": ... }`; Gemini's is
 * `{ "type": "text", "mime_type": "application/json", "schema": ... }`, a schema under "schema"
 * beside no key `unwrap` recognises on its own, so the slot falls back to that key. A slot that
 * asks for free-form JSON or plain text declares none and yields nothing.
 */
function unwrapFormat(definition: JsonSchema, keys: readonly string[]): UnwrappedSchema[] {
  const entry = found(definition, keys);
  if (entry.wrapper !== null) return [entry];
  if (!("schema" in definition)) return [];

  const name = definitionName(definition);
  const strict = strictFlag(definition, ["schema"]);
  const all = [...keys, "schema"];
  return [
    {
      schema: definition.schema,
      wrapper: "output format (schema)",
      keys: all,
      kind: "format",
      pointer: joinPointer("", ...all),
      ...(name ? { name } : {}),
      ...(strict === undefined ? {} : { strict }),
    },
  ];
}

/**
 * Whether `document` is a JSON-RPC message rather than a schema. Every MCP message "MUST follow
 * the JSON-RPC 2.0 specification", whose `jsonrpc` member must be exactly `"2.0"`, so that
 * member identifies a protocol message captured off the wire. A schema of its own can carry a
 * property named `jsonrpc`, but then the value is a subschema, not the version string.
 */
function isJsonRpcMessage(document: JsonSchema): boolean {
  return document.jsonrpc === "2.0";
}

/**
 * Which of the message shapes the JSON-RPC 2.0 specification defines a document is.
 * `other` is a message that is none of them, which the specification makes invalid: a Response
 * must include "either the result member or error member", and a Request must name a `method`.
 */
export type JsonRpcKind = "request" | "notification" | "result" | "error" | "other";

/** A JSON-RPC message, as much of it as a report needs to say which message it is. */
export interface JsonRpcMessage {
  kind: JsonRpcKind;
  /** The `method` a request or a notification names. */
  method?: string;
  /** The `code` an error response carries, "a Number that indicates the error type". */
  code?: number;
  /** The error's `message`, "a String providing a short description of the error". */
  message?: string;
}

/**
 * The JSON-RPC message a document is, or `undefined` when it is not one. A message that
 * declares no schema is not an empty file, and this is what a report says it is instead: an
 * error response names the `code` and `message` of the call that failed, a request and a
 * notification name the `method` they call.
 *
 * The shapes come from the JSON-RPC 2.0 specification: `error` is "REQUIRED on error" and
 * "MUST NOT exist if there was no error", `result` is the same on success and the two "MUST
 * NOT" both appear, so either one identifies a response on its own; a request names a `method`,
 * and one whose `id` "is not included ... is assumed to be a notification".
 */
export function jsonRpcMessage(document: unknown): JsonRpcMessage | undefined {
  if (!isJsonSchema(document) || !isJsonRpcMessage(document)) return undefined;

  const error = document.error;
  if (isJsonSchema(error)) {
    const { code, message } = error;
    return {
      kind: "error",
      ...(typeof code === "number" ? { code } : {}),
      ...(typeof message === "string" ? { message } : {}),
    };
  }
  if ("error" in document) return { kind: "error" };
  if ("result" in document) return { kind: "result" };
  if (typeof document.method === "string") {
    return { kind: "id" in document ? "request" : "notification", method: document.method };
  }
  return { kind: "other" };
}

/**
 * The schemas inside a JSON-RPC envelope, which is how an MCP `tools/list` response arrives
 * when it is read straight off the wire: `{ "jsonrpc": "2.0", "id": 1, "result": { "tools":
 * [...] } }`. A result response carries its payload under `result` and nowhere else, so that is
 * the only place in an envelope a schema can sit, and `result` holds the `tools` array the MCP
 * spelling of a request body already declares. A request, a notification, an error response,
 * and the result of a method that returns no tools declare no schema and yield nothing.
 * Nothing in an envelope is read as a bare schema: a protocol payload is not one, so a result
 * no wrapper is recognised in is reported as holding no schema instead of linted as a schema.
 */
function unwrapEnvelope(message: JsonSchema, prefix: readonly string[]): UnwrappedSchema[] {
  const result = message.result;
  if (!isJsonSchema(result)) return [];
  return unwrapDocument(result, [...prefix, "result"]).filter((entry) => entry.wrapper !== null);
}

/** `unwrapAll` for a document that may sit inside a wrapper, with the keys leading to it. */
function unwrapDocument(document: unknown, prefix: readonly string[]): UnwrappedSchema[] {
  if (Array.isArray(document)) return document.map((entry, index) => found(entry, [...prefix, String(index)]));

  if (isJsonSchema(document)) {
    if (isJsonRpcMessage(document)) return unwrapEnvelope(document, prefix);

    if (isRequestBody(document)) {
      const schemas: UnwrappedSchema[] = [];
      if (Array.isArray(document.tools)) schemas.push(...unwrapTools(document.tools, [...prefix, "tools"]));
      for (const keys of FORMAT_SLOTS) {
        const definition = resolvePointer(document, joinPointer("", ...keys));
        if (isJsonSchema(definition)) schemas.push(...unwrapFormat(definition, [...prefix, ...keys]));
      }
      return schemas;
    }
  }

  return [found(document, prefix)];
}

/**
 * Every schema a document holds. A request body declares several — `tools` for OpenAI and
 * Anthropic, `response_format` for Chat Completions, `text.format` for the Responses API,
 * `output_config.format` for Anthropic's JSON outputs — and so does a bare array of tool
 * definitions, whose entries may also be bare schemas. An MCP `tools/list` response is that
 * body one level down, inside the JSON-RPC envelope it arrives in.
 * Any other document holds the one schema `unwrap` finds, so a single file keeps behaving
 * exactly as it did.
 */
export function unwrapAll(document: unknown): UnwrappedSchema[] {
  return unwrapDocument(document, []);
}
