import { resolvePointer } from "./pointer.js";
import type { JsonSchema } from "./types.js";
import { children, isJsonSchema } from "./walk.js";

export function isLocalRef(ref: string): boolean {
  return ref.startsWith("#");
}

/** Resolves a same-document `$ref` (`#`, `#/$defs/x`) to its target path and schema. */
export function resolveLocalRef(
  root: JsonSchema,
  ref: string,
): { path: string; schema: JsonSchema } | undefined {
  if (!isLocalRef(ref)) return undefined;

  let path: string;
  try {
    path = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }

  const target = resolvePointer(root, path);
  return isJsonSchema(target) ? { path, schema: target } : undefined;
}

export interface RecursiveRef {
  /** Path of the subschema holding the `$ref`. */
  path: string;
  ref: string;
}

/**
 * Finds every `$ref` that closes a cycle, i.e. points at a schema that is still being expanded.
 * Standard three-color DFS over the graph formed by subschema and `$ref` edges.
 */
export function findRecursiveRefs(root: JsonSchema): RecursiveRef[] {
  const found: RecursiveRef[] = [];
  const inProgress = new Set<string>();
  const done = new Set<string>();

  const visit = (schema: JsonSchema, path: string): void => {
    if (done.has(path) || inProgress.has(path)) return;
    inProgress.add(path);

    for (const child of children(schema, path)) visit(child.schema, child.path);

    if (typeof schema.$ref === "string") {
      const target = resolveLocalRef(root, schema.$ref);
      if (target) {
        if (inProgress.has(target.path)) found.push({ path, ref: schema.$ref });
        else visit(target.schema, target.path);
      }
    }

    inProgress.delete(path);
    done.add(path);
  };

  visit(root, "");
  return found;
}
