import { lint } from "./lint.js";
import { displayPointer, joinPointer, resolvePointer, setPointer, unescapeToken } from "./pointer.js";
import { resolveLocalRef } from "./refs.js";
import type { AppliedFix, Finding, FixResult, JsonSchema, LintOptions } from "./types.js";
import { isJsonSchema, walk } from "./walk.js";

/**
 * Applying a fix can expose a finding that was hidden behind it, so the schema is
 * re-linted after each pass. The bound stops a fix that reports itself as applied
 * without ever settling.
 */
const MAX_PASSES = 10;

function depth(pointer: string): number {
  return pointer.split("/").length;
}

/** Deepest subschema first, so rewriting a parent already sees its fixed children. */
function deepestFirst(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => depth(b.path) - depth(a.path));
}

/** True when `pointer` is `ancestor` or sits inside it. */
function within(pointer: string, ancestor: string): boolean {
  return pointer === ancestor || pointer.startsWith(`${ancestor}/`);
}

/**
 * True when a subschema outside `pointer` still reaches it with a local `$ref`, counting a
 * reference to anything inside it. References from within `pointer` itself do not count:
 * a definition that only refers to itself is unreachable once its last use is gone.
 */
function isReferenced(root: JsonSchema, pointer: string): boolean {
  return walk(root).some((node) => {
    if (within(node.path, pointer)) return false;
    const { $ref } = node.schema;
    if (typeof $ref !== "string") return false;
    const target = resolveLocalRef(root, $ref);
    return target !== undefined && within(target.path, pointer);
  });
}

/**
 * Deletes the definition at `pointer` from `root`, in place, along with the map it leaves
 * empty. Only an entry of a `$defs` or `definitions` map is removed: a local `$ref` may point
 * at any subschema, and a property nothing else references is still part of what the schema
 * accepts. Returns false when the pointer names anything else, or nothing at all.
 */
function removeDefinition(root: JsonSchema, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;

  const tokens = pointer.slice(1).split("/").map(unescapeToken);
  const name = tokens.pop() as string;
  const keyword = tokens[tokens.length - 1];
  if (keyword !== "$defs" && keyword !== "definitions") return false;

  const map = resolvePointer(root, joinPointer("", ...tokens));
  if (!isJsonSchema(map) || !(name in map)) return false;

  delete map[name];
  if (Object.keys(map).length > 0) return true;

  const owner = resolvePointer(root, joinPointer("", ...tokens.slice(0, -1)));
  if (isJsonSchema(owner)) delete owner[keyword];
  return true;
}

/**
 * Lints `schema` and applies every fix the findings carry, repeating until nothing
 * changes. The input is left untouched; the rewritten schema is returned.
 * Throws a TypeError when `schema` is not a JSON object.
 *
 * Fixes for different providers can contradict each other, so pass a single provider
 * unless the schema is meant to satisfy all of them at once.
 */
export function fix(schema: unknown, options: LintOptions = {}): FixResult {
  if (!isJsonSchema(schema)) {
    throw new TypeError("Schema must be a JSON object.");
  }

  let current = structuredClone(schema);
  const applied: AppliedFix[] = [];
  let result = lint(current, options);

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let changed = false;

    for (const finding of deepestFirst(result.findings)) {
      if (!finding.fix) continue;
      // Re-read the node: an earlier fix in this pass may already have rewritten it.
      const target = resolvePointer(current, finding.path);
      if (!isJsonSchema(target)) continue;

      const rewritten = finding.fix.rewrite(target);
      if (JSON.stringify(rewritten) === JSON.stringify(target)) continue;
      if (finding.path === "") current = rewritten;
      else if (!setPointer(current, finding.path, rewritten)) continue;

      applied.push({
        ruleId: finding.ruleId,
        provider: finding.provider,
        path: finding.path,
        title: finding.fix.title,
      });
      changed = true;

      // The rewrite may have been the last use of a definition. An orphan is not free: its
      // name and its property names still count toward the OpenAI size limits.
      for (const pointer of finding.fix.prunes ?? []) {
        if (isReferenced(current, pointer) || !removeDefinition(current, pointer)) continue;
        applied.push({
          ruleId: finding.ruleId,
          provider: finding.provider,
          path: pointer,
          title: `Remove ${displayPointer(pointer)}, which nothing references any more.`,
        });
      }
    }

    if (!changed) break;
    result = lint(current, options);
  }

  return { schema: current as JsonSchema, applied, findings: result.findings, summary: result.summary };
}
