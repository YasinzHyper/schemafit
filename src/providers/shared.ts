import type { Rule, RuleContext, RuleMeta, SchemaNode } from "../types.js";
import { isObjectSchema } from "../walk.js";

/** Calls `visit` for every node that uses one of `keywords`, once per keyword used. */
export function forEachKeyword(
  ctx: RuleContext,
  keywords: readonly string[],
  visit: (node: SchemaNode, keyword: string) => void,
): void {
  for (const node of ctx.nodes) {
    for (const keyword of keywords) {
      if (keyword in node.schema) visit(node, keyword);
    }
  }
}

/** Rule: every object schema must set `additionalProperties: false`. */
export function additionalPropertiesFalse(meta: RuleMeta): Rule {
  return {
    ...meta,
    check(ctx) {
      for (const node of ctx.nodes) {
        if (!isObjectSchema(node.schema) || node.schema.additionalProperties === false) continue;
        const current = node.schema.additionalProperties;
        ctx.report({
          path: node.path,
          message:
            current === undefined
              ? 'Object does not set "additionalProperties": false.'
              : '"additionalProperties" must be exactly false.',
          hint: 'Add "additionalProperties": false to this object.',
        });
      }
    },
  };
}

/** Rule: string `format` must be one of `allowed`. */
export function allowedFormats(meta: RuleMeta, allowed: readonly string[]): Rule {
  return {
    ...meta,
    check(ctx) {
      for (const node of ctx.nodes) {
        const { format } = node.schema;
        if (typeof format !== "string" || allowed.includes(format)) continue;
        ctx.report({
          path: node.path,
          message: `String format "${format}" is not one of the documented formats.`,
          hint: `Documented formats: ${allowed.join(", ")}. Otherwise drop "format" and describe the shape in "description".`,
        });
      }
    },
  };
}

/** Rule: none of `keywords` may appear. */
export function forbiddenKeywords(
  meta: RuleMeta,
  keywords: readonly string[],
  describe: (keyword: string) => { message: string; hint?: string },
): Rule {
  return {
    ...meta,
    check(ctx) {
      forEachKeyword(ctx, keywords, (node, keyword) => {
        ctx.report({ path: node.path, ...describe(keyword) });
      });
    },
  };
}
