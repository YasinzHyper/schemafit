/**
 * Where a fix moved the entries of the subschema it rewrote, so what points into a schema — a
 * comment read off a YAML file — can follow the rewrite. A fix that folds a keyword into
 * `description` moves what was said about the keyword there, since that is where the constraint
 * now lives, and one that lists `renames` moves the entries it names. A fix not named here leaves
 * every entry it keeps where it was, or takes it out, and a pointer to it is returned as it is.
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
  if (applied.renames !== undefined && applied.renames.length > 0) {
    const pairs = applied.renames.map(([from, to]) => [at + from, at + to] as const);
    return (pointer) => {
      // The first rename that holds the entry moves it, so no entry is moved twice.
      for (const [from, to] of pairs) {
        if (within(pointer, from)) return to + pointer.slice(from.length);
      }
      return pointer;
    };
  }
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

/**
 * The pointer of the schema whose entries `applied`, a fix to the schema at `schema`, moves in
 * under a new key, which is the root `openai/root-object` wraps, or undefined for any other fix.
 * No line a file wrote that schema on stays as it was: every entry that says what it accepts ends
 * up nested two levels deeper, and its definitions and document keywords stay behind.
 */
export function rewrappedRoot(schema: string, applied: AppliedFix): string | undefined {
  return applied.ruleId === "openai/root-object" ? schema + applied.path : undefined;
}

function within(pointer: string, entry: string): boolean {
  return pointer === entry || pointer.startsWith(`${entry}/`);
}

function renamed(pointer: string, from: string, to: string): string {
  return within(pointer, from) ? to + pointer.slice(from.length) : pointer;
}
