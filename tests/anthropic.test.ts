import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/index.js";
import { unsupportedRegexFeatures } from "../src/providers/anthropic.js";
import { findingsFor, ruleIds, strictObject } from "./helpers.js";

const ids = (schema: JsonSchema): string[] => ruleIds("anthropic", schema);

describe("anthropic", () => {
  it("accepts a schema that follows every rule", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Z][a-z]+( [A-Z][a-z]+)*$" },
        website: { type: "string", format: "uri" },
        plan: { enum: ["free", "pro", null] },
        tags: { type: "array", items: { type: "string" }, minItems: 1 },
        address: { allOf: [{ type: "object", properties: {}, additionalProperties: false }] },
        billing: { $ref: "#/$defs/address" },
      },
      required: ["name"],
      additionalProperties: false,
      $defs: { address: strictObject({ city: { type: "string", default: "Berlin" } }) },
    };
    expect(findingsFor("anthropic", schema)).toEqual([]);
  });

  it("additional-properties-false applies to every object", () => {
    const schema = strictObject({ inner: { type: "object", properties: {} } });
    expect(findingsFor("anthropic", schema).map((finding) => [finding.ruleId, finding.path])).toEqual([
      ["anthropic/additional-properties-false", "/properties/inner"],
    ]);
  });

  it("no-recursive-schemas points at the $ref that closes the cycle", () => {
    const schema = strictObject({ children: { type: "array", items: { $ref: "#" } } });
    expect(findingsFor("anthropic", schema).map((finding) => [finding.ruleId, finding.path])).toEqual([
      ["anthropic/no-recursive-schemas", "/properties/children/items"],
    ]);
  });

  it("no-external-ref rejects refs to other documents", () => {
    expect(ids(strictObject({ a: { $ref: "https://example.com/address.json" } }))).toEqual(["anthropic/no-external-ref"]);
    expect(ids(strictObject({ a: { $ref: "common.json#/$defs/address" } }))).toEqual(["anthropic/no-external-ref"]);
  });

  it("enum-primitives rejects objects and arrays inside enum", () => {
    expect(ids(strictObject({ a: { enum: [{ x: 1 }] } }))).toEqual(["anthropic/enum-primitives"]);
    expect(ids(strictObject({ a: { enum: [["x"]] } }))).toEqual(["anthropic/enum-primitives"]);
    expect(ids(strictObject({ a: { enum: ["x", 1, true, null] } }))).toEqual([]);
  });

  it("no-numeric-constraints reports each keyword", () => {
    const found = findingsFor("anthropic", strictObject({ n: { type: "number", minimum: 0, exclusiveMaximum: 1, multipleOf: 0.1 } }));
    expect(found.map((finding) => finding.ruleId)).toEqual(Array(3).fill("anthropic/no-numeric-constraints"));
  });

  it("no-string-length rejects minLength and maxLength", () => {
    expect(ids(strictObject({ s: { type: "string", minLength: 1, maxLength: 5 } }))).toEqual(["anthropic/no-string-length"]);
  });

  it("array-constraints allows only minItems 0 and 1", () => {
    expect(ids(strictObject({ a: { type: "array", items: {}, minItems: 0 } }))).toEqual([]);
    expect(ids(strictObject({ a: { type: "array", items: {}, minItems: 1 } }))).toEqual([]);
    expect(ids(strictObject({ a: { type: "array", items: {}, minItems: 2 } }))).toEqual(["anthropic/array-constraints"]);
    expect(ids(strictObject({ a: { type: "array", items: {}, maxItems: 3 } }))).toEqual(["anthropic/array-constraints"]);
    expect(ids(strictObject({ a: { type: "array", items: {}, uniqueItems: true } }))).toEqual(["anthropic/array-constraints"]);
  });

  it("attaches a fix that restates the constraint in the description", () => {
    const [finding] = findingsFor("anthropic", strictObject({ n: { type: "integer", maximum: 9 } }));
    expect(finding?.fix?.title).toBe('Remove "maximum" and state it in "description".');
    expect(finding?.fix?.rewrite({ type: "integer", maximum: 9 })).toEqual({
      type: "integer",
      description: "Must be at most 9.",
    });
  });

  it("unsupported-format accepts uri, unlike OpenAI", () => {
    expect(ids(strictObject({ a: { type: "string", format: "uri" } }))).toEqual([]);
    expect(ids(strictObject({ a: { type: "string", format: "regex" } }))).toEqual(["anthropic/unsupported-format"]);
  });

  it("unsupported-format names a format it has no wording for instead of inventing one", () => {
    const [finding] = findingsFor("anthropic", strictObject({ a: { type: "string", format: "int64" } }));
    expect(finding?.fix?.title).toBe('Remove "format": "int64" and state it in "description".');
    expect(finding?.fix?.rewrite({ type: "string", format: "int64", description: "An id." })).toEqual({
      type: "string",
      description: 'An id. Must be a string in the "int64" format.',
    });
  });

  it("allof-ref rejects $ref inside allOf", () => {
    const schema = strictObject({ a: { allOf: [{ $ref: "#/$defs/base" }] } }, { $defs: { base: strictObject({}) } });
    expect(findingsFor("anthropic", schema).map((finding) => [finding.ruleId, finding.path])).toEqual([
      ["anthropic/allof-ref", "/properties/a/allOf/0"],
    ]);
  });

  describe("regex-features", () => {
    it.each([
      ["(a)\\1", ["backreference"]],
      ["(?<word>a)\\k<word>", ["backreference"]],
      ["^(?=.*\\d).+$", ["lookahead assertion"]],
      ["(?<!un)happy", ["lookbehind assertion"]],
      ["\\bword\\b", ["word boundary (\\b)"]],
    ])("detects unsupported features in %s", (pattern, expected) => {
      expect(unsupportedRegexFeatures(pattern)).toEqual(expected);
    });

    it.each(["^\\d{3}-\\d{4}$", "[\\b\\1]+", "\\\\b", "(?:a|b)+", "(?<name>a)", "^[^()]*$"])(
      "accepts %s",
      (pattern) => {
        expect(unsupportedRegexFeatures(pattern)).toEqual([]);
      },
    );

    it("reports the pattern's location", () => {
      const [finding] = findingsFor("anthropic", strictObject({ a: { type: "string", pattern: "\\bfoo" } }));
      expect(finding?.ruleId).toBe("anthropic/regex-features");
      expect(finding?.path).toBe("/properties/a");
    });
  });

  it("optional-parameters-limit allows 24 optional parameters and rejects 25", () => {
    const optional = (count: number): JsonSchema => ({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { type: "string" }])),
      required: [],
      additionalProperties: false,
    });
    expect(ids(optional(24))).toEqual([]);
    expect(ids(optional(25))).toEqual(["anthropic/optional-parameters-limit"]);
  });

  it("union-parameters-limit counts anyOf and type-array parameters", () => {
    const unions = (count: number): JsonSchema =>
      strictObject(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `p${i}`,
            i % 2 === 0 ? { type: ["string", "null"] } : { anyOf: [{ type: "string" }, { type: "null" }] },
          ]),
        ),
      );
    expect(ids(unions(16))).toEqual([]);
    expect(ids(unions(17))).toEqual(["anthropic/union-parameters-limit"]);
  });

  it("enum-casing warns about values that differ only in capitalization", () => {
    const [finding] = findingsFor("anthropic", strictObject({ a: { enum: ["Topic one", "Topic One", "other"] } }));
    expect(finding?.ruleId).toBe("anthropic/enum-casing");
    expect(finding?.severity).toBe("warn");
    expect(ids(strictObject({ a: { enum: ["same", "same", "Other"] } }))).toEqual([]);
  });
});
