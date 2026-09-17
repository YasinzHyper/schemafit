import { lint } from "./lint.js";
import { resolvePointer, setPointer } from "./pointer.js";
import type { AppliedFix, Finding, FixResult, JsonSchema, LintOptions } from "./types.js";
import { isJsonSchema } from "./walk.js";

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
    }

    if (!changed) break;
    result = lint(current, options);
  }

  return { schema: current as JsonSchema, applied, findings: result.findings, summary: result.summary };
}
