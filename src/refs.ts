import { joinPointer, resolvePointer } from "./pointer.js";
import type { JsonSchema } from "./types.js";
import { children, isJsonSchema } from "./walk.js";

/** The keywords whose value names another schema. */
const REF_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef"];

export interface ReferenceSite {
  /** JSON Pointer of the object holding the keyword. */
  path: string;
  keyword: string;
  /** The value found there, a string in a valid schema but not necessarily one here. */
  value: unknown;
}

/**
 * Every reference keyword in `document`, wherever it sits.
 *
 * The document is traversed as plain JSON rather than as a tree of subschemas, so a reference
 * under a keyword `walk()` does not know - draft-07 `dependencies`, `contentSchema`, whatever a
 * later draft adds - is found all the same. Anything deciding what a schema no longer needs has
 * to see the whole reference graph, and a graph built from the walker's keyword list loses an
 * edge, silently, every time a draft grows one.
 *
 * The price is that anything else spelling one of these keywords is reported as a site too: a
 * `$ref` inside `default` or `examples`, which is instance data, or a property *named* `$ref`.
 * Callers use a site to hold a definition in place, never to remove one, so a site that is not
 * a reference can only ever keep something that could have gone.
 */
export function referenceSites(document: unknown, path = ""): ReferenceSite[] {
  if (Array.isArray(document)) {
    return document.flatMap((item, index) => referenceSites(item, joinPointer(path, index)));
  }
  if (!isJsonSchema(document)) return [];

  const sites: ReferenceSite[] = [];
  for (const [keyword, value] of Object.entries(document)) {
    if (REF_KEYWORDS.includes(keyword)) sites.push({ path, keyword, value });
    else sites.push(...referenceSites(value, joinPointer(path, keyword)));
  }
  return sites;
}

/** The target `site` names, when it is a reference that resolves inside `root`. */
export function referenceTarget(root: JsonSchema, site: ReferenceSite): { path: string; schema: JsonSchema } | undefined {
  return typeof site.value === "string" ? resolveLocalRef(root, site.value) : undefined;
}

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

/** The `$ref` of a subschema that is nothing but a reference, so inlining it loses nothing. */
export function refOnly(schema: JsonSchema): string | null {
  const keywords = Object.keys(schema);
  return keywords.length === 1 && keywords[0] === "$ref" && typeof schema.$ref === "string" ? schema.$ref : null;
}

/** True when the subschema at `path` refers back to itself, directly or through another definition. */
function refersToItself(root: JsonSchema, path: string): boolean {
  const seen = new Set<string>([path]);

  const visit = (schema: JsonSchema, at: string): boolean => {
    const reachable = [...children(schema, at)];
    if (typeof schema.$ref === "string") {
      const target = resolveLocalRef(root, schema.$ref);
      if (target?.path === path) return true;
      if (target) reachable.push({ schema: target.schema, path: target.path, parentKeyword: "$ref" });
    }
    for (const next of reachable) {
      if (seen.has(next.path)) continue;
      seen.add(next.path);
      if (visit(next.schema, next.path)) return true;
    }
    return false;
  };

  const start = resolvePointer(root, path);
  return isJsonSchema(start) ? visit(start, path) : false;
}

/**
 * How many references in the document point at `path`. Counted over every reference keyword
 * wherever it sits, so a definition a `$ref` under a keyword `walk()` does not visit still needs
 * is seen as shared and copied rather than moved out from under it.
 */
function refCount(root: JsonSchema, path: string): number {
  return referenceSites(root).filter((site) => referenceTarget(root, site)?.path === path).length;
}

/**
 * The definition a bare `$ref` names, as a deep copy, when putting it in the reference's place
 * is safe: the definition must not refer back to itself, which cannot be inlined at all, and
 * must not be the root. `shared` says other subschemas reference it too, so the original has to
 * stay where it is and what the caller inlines is a second copy of it.
 *
 * Copying is the better trade wherever the alternative is leaving a construct the API rejects
 * and no fix can resolve: a copy only costs size, which the property, nesting, and string-size
 * rules measure again over the fixed schema. Either way the fix names the definition in
 * `prunes`, and the engine drops it once nothing references it any more.
 */
export function inlinableRef(
  root: JsonSchema,
  ref: string,
): { schema: JsonSchema; path: string; shared: boolean } | null {
  const target = resolveLocalRef(root, ref);
  if (!target || target.path === "") return null;
  if (refersToItself(root, target.path)) return null;
  return {
    schema: structuredClone(target.schema),
    path: target.path,
    shared: refCount(root, target.path) > 1,
  };
}
