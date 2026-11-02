import type { JsonSchema, RequestSchema } from "./types.js";
import { jsonRpcBatch, unwrapAll } from "./unwrap.js";
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

/** The schemas of one request, and where in the document the request sits. */
export interface RequestGroup {
  /** JSON Pointer from the document to the request. `""` when the document is the request. */
  pointer: string;
  schemas: RequestSchema[];
}

/**
 * The requests a document holds, each with the schemas it sends strictly. A document is one
 * request, except a JSON-RPC batch: the server answers it with "an Array containing the
 * corresponding Response objects", one per call, which "MAY be returned in any order", so each
 * `tools/list` response in it is the tool set of its own call rather than a share of one request
 * with the others. Each message is a request of its own, then, measured on its own and placed at
 * its index in the batch. A message that declares no schema holds no request and is left out.
 */
export function requestGroups(document: unknown): RequestGroup[] {
  if (jsonRpcBatch(document) === undefined) return [{ pointer: "", schemas: requestSchemas(document) }];
  const groups = new Map<string, RequestSchema[]>();
  for (const schema of requestSchemas(document)) {
    const pointer = schema.pointer.slice(0, schema.pointer.indexOf("/", 1));
    groups.set(pointer, [...(groups.get(pointer) ?? []), schema]);
  }
  return [...groups].map(([pointer, schemas]) => ({ pointer, schemas }));
}
