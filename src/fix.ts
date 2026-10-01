import { lint } from "./lint.js";
import { displayPointer, joinPointer, resolvePointer, setPointer, unescapeToken } from "./pointer.js";
import { referenceSites, referenceTarget } from "./refs.js";
import type { AppliedFix, Finding, FixOptions, FixResult, JsonSchema } from "./types.js";
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
 * True when something outside `pointer` still reaches it with a local reference, counting a
 * reference to anything inside it. References from within `pointer` itself do not count:
 * a definition that only refers to itself is unreachable once its last use is gone.
 *
 * Every reference in the document counts, wherever it sits, not only the ones under a keyword
 * `walk()` visits: a definition removed while a `$ref` the walker never saw still names it
 * leaves a schema that does not resolve.
 */
function isReferenced(root: JsonSchema, pointer: string): boolean {
  return referenceSites(root).some((site) => {
    if (within(site.path, pointer)) return false;
    const target = referenceTarget(root, site);
    return target !== undefined && within(target.path, pointer);
  });
}

/** True when `pointer` names a subschema of `root`, i.e. a path `walk()` yields. */
function isSubschemaPath(root: JsonSchema, pointer: string): boolean {
  return walk(root).some((node) => node.path === pointer);
}

/**
 * Deletes the definition at `pointer` from `root`, in place, along with the map it leaves
 * empty. Only an entry of a `$defs` or `definitions` map is removed: a local `$ref` may point
 * at any subschema, and a property nothing else references is still part of what the schema
 * accepts. Returns false when the pointer names anything else, or nothing at all.
 *
 * The last two tokens spelling `$defs`/`definitions` and a name is not enough to make one: a
 * property *named* `$defs` reads exactly the same. What separates them is the map's owner. A
 * definition map belongs to a subschema without being one, so `walk()` yields
 * `/properties/x/$defs/user` and `/properties/x`, never `/properties/x/$defs`. Requiring the
 * owner to be a path `walk()` yields therefore accepts `/$defs/user` and
 * `/properties/x/$defs/user`, owned by the root and by `/properties/x`, and rejects
 * `/properties/$defs/items`, whose owner `/properties` is a map of names, not a subschema.
 */
function removeDefinition(root: JsonSchema, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;

  const tokens = pointer.slice(1).split("/").map(unescapeToken);
  const name = tokens.pop() as string;
  const keyword = tokens[tokens.length - 1];
  if (keyword !== "$defs" && keyword !== "definitions") return false;
  if (!isSubschemaPath(root, joinPointer("", ...tokens.slice(0, -1)))) return false;

  const map = resolvePointer(root, joinPointer("", ...tokens));
  if (!isJsonSchema(map) || !(name in map)) return false;

  delete map[name];
  if (Object.keys(map).length > 0) return true;

  const owner = resolvePointer(root, joinPointer("", ...tokens.slice(0, -1)));
  if (isJsonSchema(owner)) delete owner[keyword];
  return true;
}

/** Every `$defs` / `definitions` entry in `root`, as JSON Pointers, outermost map first. */
function definitionPointers(root: JsonSchema): string[] {
  const pointers: string[] = [];
  for (const node of walk(root)) {
    for (const keyword of ["$defs", "definitions"]) {
      const map = node.schema[keyword];
      if (!isJsonSchema(map)) continue;
      for (const name of Object.keys(map)) pointers.push(joinPointer(node.path, keyword, name));
    }
  }
  return pointers;
}

/**
 * True when every reference in `root` can be followed to a subschema of `root`. Pruning reads
 * the reference graph to decide what nothing needs any more, so a reference it cannot follow
 * has to stop it: the definition behind an anchor (`"$ref": "#user"`), a `$dynamicRef`, or a
 * URL would look unreferenced and go.
 *
 * "Every reference" means every one in the document, found by reading the document as plain
 * JSON, and not only the ones under a keyword `walk()` visits. A reference the walker does not
 * reach is invisible twice over - it neither looks unfollowable here nor holds its definition
 * in place in `isReferenced` - so the schema would come back with a `$ref` pointing at nothing.
 * Requiring each reference to sit at a path `walk()` yields keeps that from depending on the
 * walker growing a keyword later: today a `$ref` under draft-07 `dependencies` or in a
 * `contentSchema` stops pruning outright, and if the walker learns those keywords, the same
 * reference starts holding its definition in place instead.
 *
 * A nested `$id` stops pruning too, because it re-bases the references below it, so a pointer
 * that resolves here may name something else there. Looking for one on the subschemas `walk()`
 * yields is enough: a reference that passes the test above sits on one of them, and so does
 * every subschema enclosing it.
 */
function referencesAreComplete(root: JsonSchema): boolean {
  const subschemas = new Set<string>();
  for (const node of walk(root)) {
    if (node.path !== "" && node.schema.$id !== undefined) return false;
    subschemas.add(node.path);
  }

  return referenceSites(root).every(
    (site) => subschemas.has(site.path) && referenceTarget(root, site) !== undefined,
  );
}

/**
 * Removes every definition of `root` that no `$ref` reaches, in place, and reports what went.
 * Repeated to a fixpoint, because removing a definition can orphan the one it referenced.
 * Each round removes at least one entry of a finite set, so it terminates.
 */
function pruneUnusedDefs(root: JsonSchema): AppliedFix[] {
  const removed: AppliedFix[] = [];
  if (!referencesAreComplete(root)) return removed;

  for (;;) {
    let changed = false;
    for (const pointer of definitionPointers(root)) {
      if (isReferenced(root, pointer) || !removeDefinition(root, pointer)) continue;
      removed.push({ path: pointer, title: `Remove ${displayPointer(pointer)}, which nothing references.` });
      changed = true;
    }
    if (!changed) return removed;
  }
}

/**
 * Lints `schema` and applies every fix the findings carry, repeating until nothing
 * changes. The input is left untouched; the rewritten schema is returned.
 * Throws a TypeError when `schema` is not a JSON object.
 *
 * Several providers may be selected at once: every one of their fixes is applied to the
 * same schema, and the result is the most portable one the rules can reach, the schema all
 * of them accept. The schema is re-linted after each pass, so a rewrite that exposes
 * another provider's finding is fixed in the next one. Pass a single provider to keep the
 * constraints the others do not support, which a portable rewrite has to give up.
 *
 * `pruneUnusedDefs` additionally removes the definitions the input itself left unreferenced.
 */
export function fix(schema: unknown, options: FixOptions = {}): FixResult {
  if (!isJsonSchema(schema)) {
    throw new TypeError("Schema must be a JSON object.");
  }

  let current = structuredClone(schema);
  const applied: AppliedFix[] = [];
  // Before the first lint, so no fix is spent rewriting a definition that is about to go.
  if (options.pruneUnusedDefs) applied.push(...pruneUnusedDefs(current));
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

    // A rewrite can orphan a definition no `prunes` named, such as one that only the
    // definition it just inlined referenced.
    if (options.pruneUnusedDefs) {
      const pruned = pruneUnusedDefs(current);
      applied.push(...pruned);
      changed ||= pruned.length > 0;
    }

    if (!changed) break;
    result = lint(current, options);
  }

  return { schema: current as JsonSchema, applied, findings: result.findings, summary: result.summary };
}
