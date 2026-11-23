/**
 * Where a fix moved the entries of the subschema it rewrote, so what points into a schema — a
 * comment read off a YAML file — can follow the rewrite. A fix that folds a keyword into
 * `description` moves what was said about the keyword there, since that is where the constraint
 * now lives. A fix not named here leaves every entry it keeps where it was, or takes it out, and
 * a pointer to it is returned as it is.
 */

import { joinPointer, unescapeToken } from "./pointer.js";
import { UNWRAPPED_KEYWORDS, WRAPPER_KEY } from "./providers/openai.js";
import { foldedKeyword } from "./providers/shared.js";
import type { AppliedFix } from "./types.js";

/**
 * Where the entry at `pointer` is after `applied`, a fix to the schema at `schema` in the same
 * document. Both pointers are from the document's root, and `applied.path` from the schema's.
 */
export function movedPointer(pointer: string, schema: string, applied: AppliedFix): string {
  return pointerMover(schema, applied)?.(pointer) ?? pointer;
}

/**
 * `movedPointer` for one fix, worked out once for every pointer it is asked about, or undefined
 * for a fix that moves no entry at all, so a caller following many pointers through many fixes
 * can pass over those.
 */
export function pointerMover(schema: string, applied: AppliedFix): ((pointer: string) => string) | undefined {
  const at = schema + applied.path;
  const folded = foldedKeyword(applied.title);
  if (folded !== undefined) {
    const [from, to] = [joinPointer(at, folded), joinPointer(at, "description")];
    return (pointer) => renamed(pointer, from, to);
  }
  if (applied.ruleId === "openai/no-one-of") return (pointer) => renamed(pointer, `${at}/oneOf`, `${at}/anyOf`);
  if (applied.ruleId !== "openai/root-object") return undefined;
  const wrapper = joinPointer(at, "properties", WRAPPER_KEY);
  return (pointer) => {
    if (!pointer.startsWith(`${at}/`)) return pointer;
    // Everything the root said about its value moved into the wrapper's one property.
    const [keyword = ""] = pointer.slice(at.length + 1).split("/");
    return UNWRAPPED_KEYWORDS.includes(unescapeToken(keyword)) ? pointer : wrapper + pointer.slice(at.length);
  };
}

function renamed(pointer: string, from: string, to: string): string {
  return pointer === from || pointer.startsWith(`${from}/`) ? to + pointer.slice(from.length) : pointer;
}
