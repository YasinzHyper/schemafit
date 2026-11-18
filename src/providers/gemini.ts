import type { Provider, RuleMeta } from "../types.js";
import { allowedFormats, forbiddenKeywords, moveToDescription, optionalFix } from "./shared.js";

const DOCS = "https://ai.google.dev/gemini-api/docs/structured-output";
const SOURCE = `${DOCS}#json-schema-support`;
const LIMITATIONS = `${DOCS}#limitations`;
const VERIFIED = "2026-11-18";

/**
 * The constraints the docs list under "Unenforced constraints": the API strips them from the
 * schema during request normalization instead of rejecting it.
 */
const UNENFORCED_KEYWORDS = [
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
];

/**
 * Validation keywords outside the documented subset, which is: type, title, description,
 * properties, required, additionalProperties, enum, format, minimum, maximum, items,
 * prefixItems, minItems, maxItems. The docs' examples also use anyOf and $ref.
 */
const UNDOCUMENTED_KEYWORDS = [
  "pattern",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "const",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
];

function meta(
  name: string,
  rest: Omit<RuleMeta, "id" | "provider" | "source" | "verified"> & { source?: string },
): RuleMeta {
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
          "Gemini documents a supported subset and the constraints it strips (gemini/unenforced-constraint), but says " +
          "nothing about these keywords, so everything here is a warning: the keyword may be ignored (the constraint " +
          "silently does nothing) or the schema may be rejected.",
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
    forbiddenKeywords(
      meta("unenforced-constraint", {
        severity: "warn",
        source: LIMITATIONS,
        summary: "Constraints the API strips instead of enforcing (minLength, maxLength, uniqueItems, ...).",
        fixable: true,
        notes:
          'The docs list these as unsupported and say the API "automatically strips and ignores them during request ' +
          'normalization rather than returning an error", so the schema is accepted and the constraint silently does ' +
          "nothing. That makes this a warning: nothing is rejected. The fix removes the keyword and states the constraint " +
          'in "description", which the docs recommend for rules the output grammar does not carry, so the model still ' +
          'sees it; validate the response in your code as well. "contains", "minContains", and "maxContains" are ' +
          "reported without a fix, because what they require cannot be put in a sentence of the description reliably.",
      }),
      UNENFORCED_KEYWORDS,
      (keyword, node) => ({
        message: `"${keyword}" is not enforced; the API strips it from the schema without an error.`,
        hint: `Remove "${keyword}", state the constraint in "description", and validate the value in your code.`,
        ...optionalFix(moveToDescription(keyword, node.schema)),
      }),
    ),
    allowedFormats(
      meta("undocumented-format", {
        severity: "warn",
        summary: 'String "format" values other than date-time, date, and time are undocumented.',
        notes:
          'The docs introduce the list with "such as", so it may not be exhaustive. For the same reason there is no ' +
          "fix: dropping a format that is only undocumented, and may well work, would give up a constraint for nothing.",
      }),
      ["date-time", "date", "time"],
    ),
  ],
};
