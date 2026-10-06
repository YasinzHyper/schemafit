import type { JsonSchema, RequestSchema } from "./types.js";
import { unwrapAll } from "./unwrap.js";
import { isJsonSchema, walk } from "./walk.js";

/**
 * Every schema a document sends under strict decoding, in document order, as the request-wide
 * rules see it. A declaration that sets `strict: false` is left out, because the limits a
 * provider states per request count the strict schemas only. One that says nothing about
 * `strict` is counted: a schema file says nothing either, and the rules are there for the
 * schemas you mean to send strictly. A declaration whose schema is not a JSON object is
 * skipped rather than counted as an empty one; `lint` is what reports it.
 */
export function requestSchemas(document: unknown): RequestSchema[] {
  const schemas: RequestSchema[] = [];
  for (const found of unwrapAll(document)) {
    if (found.strict === false || !isJsonSchema(found.schema)) continue;
    schemas.push({
      pointer: found.pointer,
      ...(found.name ? { name: found.name } : {}),
      schema: found.schema as JsonSchema,
      nodes: walk(found.schema as JsonSchema),
      kind: found.kind,
      ...(found.strict === undefined ? {} : { strict: found.strict }),
    });
  }
  return schemas;
}
