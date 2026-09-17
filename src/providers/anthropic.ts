import { findRecursiveRefs, isLocalRef } from "../refs.js";
import type { Provider, Rule, RuleMeta } from "../types.js";
import { isJsonSchema } from "../walk.js";
import { additionalPropertiesFalse, allowedFormats, forbiddenKeywords } from "./shared.js";

const DOCS = "https://platform.claude.com/docs/en/build-with-claude/structured-outputs";
const LIMITATIONS = `${DOCS}#json-schema-limitations`;
const COMPLEXITY = `${DOCS}#schema-complexity-limits`;
const INVALID_OUTPUTS = `${DOCS}#invalid-outputs`;
const VERIFIED = "2026-09-17";

const MAX_OPTIONAL_PARAMETERS = 24;
const MAX_UNION_PARAMETERS = 16;

const SUPPORTED_FORMATS = [
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
];

function meta(
  name: string,
  rest: Omit<RuleMeta, "id" | "provider" | "source" | "verified"> & { source?: string },
): RuleMeta {
  return { id: `anthropic/${name}`, provider: "anthropic", source: LIMITATIONS, verified: VERIFIED, ...rest };
}

const noRecursion: Rule = {
  ...meta("no-recursive-schemas", {
    severity: "error",
    summary: "Recursive schemas are not supported.",
  }),
  check(ctx) {
    for (const { path, ref } of findRecursiveRefs(ctx.root)) {
      ctx.report({
        path,
        message: `"$ref": "${ref}" makes the schema recursive.`,
        hint: "Unroll the recursion to a fixed depth, or flatten the tree into a list of nodes with parent ids.",
      });
    }
  },
};

const noExternalRef: Rule = {
  ...meta("no-external-ref", {
    severity: "error",
    summary: 'External "$ref"s are not supported.',
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const ref = node.schema.$ref;
      if (typeof ref !== "string" || isLocalRef(ref)) continue;
      ctx.report({
        path: node.path,
        message: `"$ref": "${ref}" points outside this document.`,
        hint: 'Inline the referenced schema under "$defs" and reference it as "#/$defs/<name>".',
      });
    }
  },
};

const enumPrimitives: Rule = {
  ...meta("enum-primitives", {
    severity: "error",
    summary: "Enum values must be strings, numbers, booleans, or null.",
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const values = node.schema.enum;
      if (!Array.isArray(values)) continue;
      if (values.some((value) => typeof value === "object" && value !== null)) {
        ctx.report({
          path: node.path,
          message: "Enum contains object or array values.",
          hint: 'Model each variant as an object schema under "anyOf", or enumerate a string key instead.',
        });
      }
    }
  },
};

const noNumericConstraints = forbiddenKeywords(
  meta("no-numeric-constraints", {
    severity: "error",
    summary: "Numerical constraints (minimum, maximum, multipleOf, ...) are not supported.",
  }),
  ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  (keyword) => ({
    message: `Numerical constraint "${keyword}" is not supported.`,
    hint: `Remove "${keyword}", state the range in "description", and validate the value in your code.`,
  }),
);

const noStringLength = forbiddenKeywords(
  meta("no-string-length", {
    severity: "error",
    summary: "String length constraints (minLength, maxLength) are not supported.",
  }),
  ["minLength", "maxLength"],
  (keyword) => ({
    message: `String constraint "${keyword}" is not supported.`,
    hint: `Remove "${keyword}", state the limit in "description", and validate the value in your code.`,
  }),
);

const arrayConstraints: Rule = {
  ...meta("array-constraints", {
    severity: "error",
    summary: 'The only supported array constraint is "minItems" of 0 or 1.',
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const { minItems } = node.schema;
      if (minItems !== undefined && minItems !== 0 && minItems !== 1) {
        ctx.report({
          path: node.path,
          message: `"minItems": ${JSON.stringify(minItems)} is not supported; only 0 and 1 are.`,
          hint: 'Use "minItems": 1 and state the real minimum in "description".',
        });
      }
      for (const keyword of ["maxItems", "uniqueItems"]) {
        if (keyword in node.schema) {
          ctx.report({
            path: node.path,
            message: `Array constraint "${keyword}" is not supported.`,
            hint: `Remove "${keyword}", state the constraint in "description", and validate in your code.`,
          });
        }
      }
    }
  },
};

const allOfRef: Rule = {
  ...meta("allof-ref", {
    severity: "error",
    summary: '"allOf" may not contain "$ref".',
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      if (node.parentKeyword === "allOf" && "$ref" in node.schema) {
        ctx.report({
          path: node.path,
          message: '"allOf" combined with "$ref" is not supported.',
          hint: 'Inline the referenced schema into the "allOf" branch.',
        });
      }
    }
  },
};

/** Regex constructs the docs list as unsupported, found by a single left-to-right scan. */
export function unsupportedRegexFeatures(pattern: string): string[] {
  const found = new Set<string>();
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];

    if (char === "\\") {
      if (next !== undefined && !inClass) {
        if (/[1-9]/.test(next) || next === "k") found.add("backreference");
        if (next === "b" || next === "B") found.add(`word boundary (\\${next})`);
      }
      i++; // skip the escaped character
    } else if (inClass) {
      if (char === "]") inClass = false;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "(" && next === "?") {
      const lookaround = /^\(\?<?[=!]/.exec(pattern.slice(i, i + 4));
      if (lookaround) found.add(`${lookaround[0].includes("<") ? "lookbehind" : "lookahead"} assertion`);
    }
  }

  return [...found];
}

const regexFeatures: Rule = {
  ...meta("regex-features", {
    severity: "error",
    summary: 'Patterns may not use backreferences, lookahead/lookbehind, or word boundaries.',
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const { pattern } = node.schema;
      if (typeof pattern !== "string") continue;
      const features = unsupportedRegexFeatures(pattern);
      if (features.length === 0) continue;
      ctx.report({
        path: node.path,
        message: `Pattern uses unsupported regex features: ${features.join(", ")}.`,
        hint: "Rewrite the pattern with plain groups, character classes, and simple quantifiers.",
      });
    }
  },
};

const optionalParametersLimit: Rule = {
  ...meta("optional-parameters-limit", {
    severity: "error",
    source: COMPLEXITY,
    summary: `At most ${MAX_OPTIONAL_PARAMETERS} optional parameters across all strict schemas in a request.`,
    notes:
      "The limit is request-wide. schemafit checks one schema at a time, so this only fires when a single schema already exceeds it.",
  }),
  check(ctx) {
    let optional = 0;
    for (const { schema } of ctx.nodes) {
      if (!isJsonSchema(schema.properties)) continue;
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      optional += Object.keys(schema.properties).filter((key) => !required.has(key)).length;
    }
    if (optional <= MAX_OPTIONAL_PARAMETERS) return;
    ctx.report({
      path: "",
      message: `The schema has ${optional} optional parameters; the request-wide limit is ${MAX_OPTIONAL_PARAMETERS}.`,
      hint: 'List more properties in "required". Each optional parameter roughly doubles part of the compiled grammar.',
    });
  },
};

const unionParametersLimit: Rule = {
  ...meta("union-parameters-limit", {
    severity: "error",
    source: COMPLEXITY,
    summary: `At most ${MAX_UNION_PARAMETERS} parameters may use anyOf or type arrays across all strict schemas in a request.`,
    notes:
      "The limit is request-wide. schemafit checks one schema at a time, so this only fires when a single schema already exceeds it.",
  }),
  check(ctx) {
    const unions = ctx.nodes.filter(
      ({ schema, parentKeyword }) =>
        parentKeyword === "properties" && ("anyOf" in schema || Array.isArray(schema.type)),
    );
    if (unions.length <= MAX_UNION_PARAMETERS) return;
    ctx.report({
      path: "",
      message: `The schema has ${unions.length} parameters with union types; the request-wide limit is ${MAX_UNION_PARAMETERS}.`,
      hint: "Replace nullable unions with required fields, or split the schema across requests.",
    });
  },
};

const enumCasing: Rule = {
  ...meta("enum-casing", {
    severity: "warn",
    source: INVALID_OUTPUTS,
    summary: "Enum values that differ only in capitalization can be returned with the wrong casing.",
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const values = node.schema.enum;
      if (!Array.isArray(values)) continue;

      const byLowercase = new Map<string, string[]>();
      for (const value of values) {
        if (typeof value !== "string") continue;
        const group = byLowercase.get(value.toLowerCase()) ?? [];
        group.push(value);
        byLowercase.set(value.toLowerCase(), group);
      }

      for (const group of byLowercase.values()) {
        if (new Set(group).size < 2) continue;
        ctx.report({
          path: node.path,
          message: `Enum values differ only in capitalization: ${group.map((v) => JSON.stringify(v)).join(", ")}.`,
          hint: "Make the values distinct beyond casing; the model may return either spelling.",
        });
      }
    }
  },
};

export const anthropic: Provider = {
  id: "anthropic",
  name: "Anthropic",
  mode: "Structured outputs (output_config.format and strict tool use)",
  rules: [
    additionalPropertiesFalse(
      meta("additional-properties-false", {
        severity: "error",
        summary: 'Every object must set "additionalProperties": false.',
      }),
    ),
    noRecursion,
    noExternalRef,
    enumPrimitives,
    noNumericConstraints,
    noStringLength,
    arrayConstraints,
    allowedFormats(
      meta("unsupported-format", {
        severity: "error",
        summary: 'String "format" must be one of the documented formats.',
      }),
      SUPPORTED_FORMATS,
    ),
    allOfRef,
    regexFeatures,
    optionalParametersLimit,
    unionParametersLimit,
    enumCasing,
  ],
};
