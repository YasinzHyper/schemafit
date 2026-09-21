import type { JsonSchema, Report, Rule, RuleContext, RuleMeta, SchemaFix, SchemaNode } from "../types.js";
import { isObjectSchema } from "../walk.js";

/** `schema` with `note` added as the last sentence of its description. */
export function withNote(schema: JsonSchema, note: string): JsonSchema {
  const existing = typeof schema.description === "string" ? schema.description.trim() : "";
  return { ...schema, description: existing.length > 0 ? `${existing} ${note}` : note };
}

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
    fixable: true,
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
          fix: {
            title: 'Set "additionalProperties": false.',
            rewrite: (schema) => ({ ...schema, additionalProperties: false }),
          },
        });
      }
    },
  };
}

/**
 * What a dropped `format` becomes in `description`, one entry per format the JSON Schema
 * format vocabulary defines. Anything else — `binary`, `int64`, whatever a generator
 * invented — falls back to naming the format itself, which is all the schema said.
 */
const FORMAT_NOTES: Record<string, string> = {
  "date-time": "Must be a date and time, such as 2026-09-21T14:30:00Z.",
  date: "Must be a date, such as 2026-09-21.",
  time: "Must be a time of day, such as 14:30:00Z.",
  duration: "Must be a duration, such as P3DT12H.",
  email: "Must be an email address.",
  "idn-email": "Must be an email address, which may use non-ASCII characters.",
  hostname: "Must be a hostname.",
  "idn-hostname": "Must be a hostname, which may use non-ASCII characters.",
  ipv4: "Must be an IPv4 address.",
  ipv6: "Must be an IPv6 address.",
  uri: "Must be an absolute URI, such as https://example.com/a.",
  "uri-reference": "Must be a URI, absolute or relative.",
  iri: "Must be an absolute URI, which may use non-ASCII characters.",
  "iri-reference": "Must be a URI, absolute or relative, which may use non-ASCII characters.",
  "uri-template": "Must be a URI template, such as https://example.com/{id}.",
  uuid: "Must be a UUID.",
  regex: "Must be a regular expression.",
  "json-pointer": "Must be a JSON Pointer, such as /items/0/name.",
  "relative-json-pointer": "Must be a relative JSON Pointer, such as 1/name.",
};

/** Removes `format` and says what it required in `description`, so the requirement survives. */
function dropFormat(format: string): SchemaFix {
  const note = FORMAT_NOTES[format] ?? `Must be a string in the "${format}" format.`;
  return {
    title: `Remove "format": "${format}" and state it in "description".`,
    rewrite(current) {
      // The node may have been rewritten since the finding was reported.
      if (current.format !== format) return current;
      const { format: _dropped, ...rest } = current;
      return withNote(rest, note);
    },
  };
}

/**
 * Rule: string `format` must be one of `allowed`. A rule that declares itself `fixable`
 * attaches the rewrite the provider SDKs apply: drop the format, state it in `description`.
 * A rule for a provider that merely leaves the format undocumented should not, because
 * dropping a format that may well work would give up a constraint for nothing.
 */
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
          ...(meta.fixable ? { fix: dropFormat(format) } : {}),
        });
      }
    },
  };
}

/**
 * Rule: none of `keywords` may appear. `describe` receives the node as well, so a rule
 * can attach a `fix` only to the occurrences it knows how to rewrite.
 */
export function forbiddenKeywords(
  meta: RuleMeta,
  keywords: readonly string[],
  describe: (keyword: string, node: SchemaNode) => Omit<Report, "path">,
): Rule {
  return {
    ...meta,
    check(ctx) {
      forEachKeyword(ctx, keywords, (node, keyword) => {
        ctx.report({ path: node.path, ...describe(keyword, node) });
      });
    },
  };
}
