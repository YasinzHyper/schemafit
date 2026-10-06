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
 * Every schema a document holds. A request body declares several — `tools` for OpenAI and
 * Anthropic, `response_format` for Chat Completions, `text.format` for the Responses API,
 * `output_config.format` for Anthropic's JSON outputs — and so does a bare array of tool
 * definitions, whose entries may also be bare schemas.
 * Any other document holds the one schema `unwrap` finds, so a single file keeps behaving
 * exactly as it did.
 */
export function unwrapAll(document: unknown): UnwrappedSchema[] {
  if (Array.isArray(document)) return document.map((entry, index) => found(entry, [String(index)]));

  if (isJsonSchema(document) && isRequestBody(document)) {
    const schemas: UnwrappedSchema[] = [];
    if (Array.isArray(document.tools)) schemas.push(...unwrapTools(document.tools, ["tools"]));
    for (const keys of FORMAT_SLOTS) {
      const definition = resolvePointer(document, joinPointer("", ...keys));
      if (isJsonSchema(definition)) schemas.push(...unwrapFormat(definition, keys));
    }
    return schemas;
  }

  return [found(document, [])];
}
