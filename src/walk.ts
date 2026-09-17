import { joinPointer } from "./pointer.js";
import type { JsonSchema, SchemaNode } from "./types.js";

/** Keywords whose value is a map of name -> subschema. */
const MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/** Keywords whose value is a single subschema. */
const SCHEMA_KEYWORDS = [
  "additionalProperties",
  "items",
  "additionalItems",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
];

/** Keywords whose value is a list of subschemas. `items` is here too for draft-07 tuples. */
const LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems", "items"];

export function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The direct subschemas of `schema`. Boolean schemas are skipped. */
export function children(schema: JsonSchema, path: string): SchemaNode[] {
  const result: SchemaNode[] = [];

  for (const keyword of MAP_KEYWORDS) {
    const map = schema[keyword];
    if (!isJsonSchema(map)) continue;
    for (const [name, child] of Object.entries(map)) {
      if (isJsonSchema(child)) {
        result.push({ schema: child, path: joinPointer(path, keyword, name), parentKeyword: keyword });
      }
    }
  }

  for (const keyword of SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (isJsonSchema(child)) {
      result.push({ schema: child, path: joinPointer(path, keyword), parentKeyword: keyword });
    }
  }

  for (const keyword of LIST_KEYWORDS) {
    const list = schema[keyword];
    if (!Array.isArray(list)) continue;
    list.forEach((child, index) => {
      if (isJsonSchema(child)) {
        result.push({ schema: child, path: joinPointer(path, keyword, index), parentKeyword: keyword });
      }
    });
  }

  return result;
}

/**
 * Every object-form subschema reachable from `root`, in document order, root first.
 * `$ref`s are not followed: a referenced definition is visited once, where it is defined.
 */
export function walk(root: JsonSchema): SchemaNode[] {
  const nodes: SchemaNode[] = [];
  const visit = (node: SchemaNode): void => {
    nodes.push(node);
    for (const child of children(node.schema, node.path)) visit(child);
  };
  visit({ schema: root, path: "", parentKeyword: null });
  return nodes;
}

export function typesOf(schema: JsonSchema): string[] {
  const { type } = schema;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

/** True when the schema describes an object: declared via `type`, or implied by `properties`. */
export function isObjectSchema(schema: JsonSchema): boolean {
  return typesOf(schema).includes("object") || isJsonSchema(schema.properties);
}
