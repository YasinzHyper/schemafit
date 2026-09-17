import type { Provider, RuleMeta } from "../types.js";
import { allowedFormats, forbiddenKeywords } from "./shared.js";

const SOURCE = "https://ai.google.dev/gemini-api/docs/structured-output#json_schema_support";
const VERIFIED = "2026-09-17";

/**
 * Validation keywords outside the documented subset, which is: type, title, description,
 * properties, required, additionalProperties, enum, format, minimum, maximum, items,
 * prefixItems, minItems, maxItems. The docs' examples also use anyOf and $ref.
 */
const UNDOCUMENTED_KEYWORDS = [
  "pattern",
  "minLength",
  "maxLength",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "const",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
];

function meta(name: string, rest: Omit<RuleMeta, "id" | "provider" | "source" | "verified">): RuleMeta {
  return { id: `gemini/${name}`, provider: "gemini", source: SOURCE, verified: VERIFIED, ...rest };
}

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  mode: "Structured output (JSON Schema)",
  rules: [
    forbiddenKeywords(
      meta("undocumented-keyword", {
        severity: "warn",
        summary: "Validation keywords outside the documented JSON Schema subset.",
        notes:
          "Gemini documents a supported subset rather than a list of rejected keywords, so everything here is a warning: " +
          "the keyword may be ignored (the constraint silently does nothing) or the schema may be rejected.",
      }),
      UNDOCUMENTED_KEYWORDS,
      (keyword) => ({
        message: `"${keyword}" is outside the documented subset; it may be ignored or rejected.`,
        hint:
          keyword === "oneOf"
            ? 'Use "anyOf", which the docs demonstrate.'
            : `State the constraint in "description" and validate the value in your code.`,
      }),
    ),
    allowedFormats(
      meta("undocumented-format", {
        severity: "warn",
        summary: 'String "format" values other than date-time, date, and time are undocumented.',
        notes: 'The docs introduce the list with "such as", so it may not be exhaustive.',
      }),
      ["date-time", "date", "time"],
    ),
  ],
};
