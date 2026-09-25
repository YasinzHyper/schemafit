import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/index.js";
import { findingsFor, ruleIds, strictObject } from "./helpers.js";

const ids = (schema: JsonSchema): string[] => ruleIds("openai", schema);

describe("openai", () => {
  it("accepts a schema that follows every rule", () => {
    const schema = strictObject({
      name: { type: "string", pattern: "^@[a-z]+$" },
      email: { type: "string", format: "email" },
      unit: { type: ["string", "null"], enum: ["F", "C"] },
      temperature: { type: "number", minimum: -130, maximum: 130 },
      steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1, maxItems: 10 },
    });
    schema.$defs = { step: strictObject({ output: { type: "string" }, next: { anyOf: [{ $ref: "#/$defs/step" }, { type: "null" }] } }) };
    expect(findingsFor("openai", schema)).toEqual([]);
  });

  describe("root-object", () => {
    it("rejects a root anyOf", () => {
      expect(ids({ anyOf: [strictObject({}), strictObject({})] })).toEqual(["openai/root-object"]);
    });

    it("rejects a non-object root", () => {
      expect(ids({ type: "array", items: { type: "string" } })).toEqual(["openai/root-object"]);
    });
  });

  describe("all-required", () => {
    it("lists the properties missing from required", () => {
      const schema = strictObject({ a: { type: "string" }, b: { type: "string" }, c: { type: "string" } }, { required: ["a"] });
      const [finding] = findingsFor("openai", schema);
      expect(finding?.ruleId).toBe("openai/all-required");
      expect(finding?.message).toContain("b, c");
    });

    it("checks nested objects and definitions", () => {
      const inner = { type: "object", properties: { x: { type: "string" } }, additionalProperties: false };
      const schema = strictObject({ inner }, { $defs: { other: inner } });
      expect(findingsFor("openai", schema).map((finding) => finding.path)).toEqual(["/properties/inner", "/$defs/other"]);
    });
  });

  describe("additional-properties-false", () => {
    it("flags objects without it, and objects that set it to anything else", () => {
      const schema = strictObject({
        missing: { type: "object", properties: {}, required: [] },
        open: { type: "object", properties: {}, required: [], additionalProperties: { type: "string" } },
      });
      const found = findingsFor("openai", schema);
      expect(found.map((finding) => finding.ruleId)).toEqual([
        "openai/additional-properties-false",
        "openai/additional-properties-false",
      ]);
      expect(found.map((finding) => finding.path)).toEqual(["/properties/missing", "/properties/open"]);
    });

    it("applies to nullable objects", () => {
      const schema = strictObject({ maybe: { type: ["object", "null"], properties: {}, required: [] } });
      expect(ids(schema)).toEqual(["openai/additional-properties-false"]);
    });
  });

  it("unsupported-composition flags allOf, not, and if/then/else", () => {
    const schema = strictObject({
      merged: { allOf: [{ type: "string" }] },
      negated: { not: { type: "null" } },
      conditional: { if: { type: "string" }, then: { type: "string" }, else: { type: "number" } },
    });
    const found = findingsFor("openai", schema);
    expect(new Set(found.map((finding) => finding.ruleId))).toEqual(new Set(["openai/unsupported-composition"]));
    expect(found).toHaveLength(5);
  });

  it("unsupported-composition offers to merge an allOf of plain objects", () => {
    const schema = strictObject({
      ticket: {
        allOf: [
          { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          { type: "object", properties: { opened_at: { type: "string" } }, required: ["opened_at"] },
        ],
      },
    });
    const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
    expect(merge?.path).toBe("/properties/ticket");
    expect(merge?.fix?.title).toBe('Merge the 2 "allOf" branches into the object.');
  });

  it("unsupported-composition inlines an allOf branch that is only a $ref", () => {
    // The shape Pydantic emits for a field that has both a model type and a description.
    const schema = strictObject(
      { reporter: { allOf: [{ $ref: "#/$defs/user" }], description: "Who filed it." } },
      { $defs: { user: strictObject({ name: { type: "string" } }) } },
    );
    const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
    expect(merge?.fix?.title).toBe('Merge the "allOf" branch into the object, inlining #/$defs/user.');
    const reporter = (schema.properties as Record<string, JsonSchema>).reporter as JsonSchema;
    expect(merge?.fix?.rewrite(reporter)).toEqual({
      description: "Who filed it.",
      ...strictObject({ name: { type: "string" } }),
    });
  });

  it("unsupported-composition copies a $ref branch whose definition is used elsewhere", () => {
    const schema = strictObject(
      { reporter: { allOf: [{ $ref: "#/$defs/user" }] }, assignee: { $ref: "#/$defs/user" } },
      { $defs: { user: strictObject({ name: { type: "string" } }) } },
    );
    const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
    expect(merge?.fix?.title).toBe(
      'Merge the "allOf" branch into the object, copying #/$defs/user, which stays under "$defs" because the schema references it elsewhere too.',
    );
    const reporter = (schema.properties as Record<string, JsonSchema>).reporter as JsonSchema;
    expect(merge?.fix?.rewrite(reporter)).toEqual(strictObject({ name: { type: "string" } }));
  });

  it("unsupported-composition offers no merge for a $ref branch that refers back to itself", () => {
    const direct = strictObject(
      { tree: { allOf: [{ $ref: "#/$defs/node" }] } },
      { $defs: { node: strictObject({ child: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] } }) } },
    );
    const mutual = strictObject(
      { start: { allOf: [{ $ref: "#/$defs/a" }] } },
      {
        $defs: {
          a: strictObject({ b: { $ref: "#/$defs/b" } }),
          b: strictObject({ a: { anyOf: [{ $ref: "#/$defs/a" }, { type: "null" }] } }),
        },
      },
    );
    for (const schema of [direct, mutual]) {
      const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
      expect(merge?.fix).toBeUndefined();
    }
  });

  it("unsupported-composition offers no merge for a $ref that is external or carries siblings", () => {
    const external = strictObject({ user: { allOf: [{ $ref: "https://example.com/user.json" }] } });
    const siblings = strictObject(
      { reporter: { allOf: [{ $ref: "#/$defs/user", description: "Who filed it." }] } },
      { $defs: { user: strictObject({ name: { type: "string" } }) } },
    );
    for (const schema of [external, siblings]) {
      const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
      expect(merge?.fix).toBeUndefined();
    }
  });

  it("unsupported-composition offers no merge when two branches disagree about a property", () => {
    const schema = strictObject({
      ticket: {
        allOf: [
          { type: "object", properties: { id: { type: "string" } } },
          { type: "object", properties: { id: { type: "integer" } } },
        ],
      },
    });
    const merge = findingsFor("openai", schema).find((f) => f.ruleId === "openai/unsupported-composition");
    expect(merge?.fix).toBeUndefined();
    expect(merge?.hint).toContain("by hand");
  });

  it("no-one-of asks for anyOf instead", () => {
    const schema = strictObject({ value: { oneOf: [{ type: "string" }, { type: "number" }] } });
    const [finding] = findingsFor("openai", schema);
    expect(finding?.ruleId).toBe("openai/no-one-of");
    expect(finding?.hint).toContain("anyOf");
    expect(finding?.fix?.title).toBe('Rename "oneOf" to "anyOf".');
  });

  it("no-one-of offers no fix when the schema already has an anyOf", () => {
    const schema = strictObject({
      value: { anyOf: [{ type: "string" }], oneOf: [{ type: "number" }] },
    });
    const [finding] = findingsFor("openai", schema);
    expect(finding?.ruleId).toBe("openai/no-one-of");
    expect(finding?.fix).toBeUndefined();
  });

  it("unsupported-format rejects formats outside the documented list", () => {
    expect(ids(strictObject({ url: { type: "string", format: "uri" } }))).toEqual(["openai/unsupported-format"]);
    expect(ids(strictObject({ id: { type: "string", format: "uuid" } }))).toEqual([]);
  });

  it("unsupported-format offers to move the format into the description", () => {
    const [finding] = findingsFor("openai", strictObject({ url: { type: "string", format: "uri" } }));
    expect(finding?.fix?.title).toBe('Remove "format": "uri" and state it in "description".');
    expect(finding?.fix?.rewrite({ type: "string", format: "uri" })).toEqual({
      type: "string",
      description: "Must be an absolute URI, such as https://example.com/a.",
    });
  });

  it("undocumented-keyword warns instead of failing", () => {
    const [finding] = findingsFor("openai", strictObject({ name: { type: "string", minLength: 1 } }));
    expect(finding?.ruleId).toBe("openai/undocumented-keyword");
    expect(finding?.severity).toBe("warn");
  });

  describe("nesting-depth", () => {
    const nest = (levels: number): JsonSchema => {
      let schema: JsonSchema = strictObject({ leaf: { type: "string" } });
      for (let i = 0; i < levels; i++) schema = strictObject({ child: schema });
      return schema;
    };

    it("allows 10 levels below the root and rejects 11", () => {
      expect(ids(nest(10))).toEqual([]);
      expect(ids(nest(11))).toEqual(["openai/nesting-depth"]);
    });

    it("measures depth through $ref and survives recursion", () => {
      const schema = strictObject({ tree: { $ref: "#/$defs/node" } });
      schema.$defs = { node: strictObject({ deep: nest(10), children: { type: "array", items: { $ref: "#/$defs/node" } } }) };
      expect(ids(schema)).toEqual(["openai/nesting-depth"]);
    });
  });

  it("max-properties counts properties across the whole schema", () => {
    const properties = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`p${i}`, { type: "string" }]));
    expect(ids(strictObject(properties))).toEqual(["openai/max-properties"]);
  });

  describe("enum-limits", () => {
    it("caps the total number of enum values", () => {
      const values = Array.from({ length: 501 }, (_, i) => `v${i}`);
      const schema = strictObject({ a: { type: "string", enum: values }, b: { type: "string", enum: values } });
      expect(ids(schema)).toEqual(["openai/enum-limits"]);
    });

    it("caps the characters of one large enum", () => {
      const values = Array.from({ length: 251 }, (_, i) => `${i}`.padEnd(60, "x"));
      const [finding] = findingsFor("openai", strictObject({ a: { type: "string", enum: values } }));
      expect(finding?.ruleId).toBe("openai/enum-limits");
      expect(finding?.path).toBe("/properties/a");
    });
  });

  it("string-budget adds up names, enum values, and const values", () => {
    const schema = strictObject({ a: { type: "string", const: "x".repeat(120_001) } });
    expect(ids(schema)).toEqual(["openai/string-budget"]);
  });
});
