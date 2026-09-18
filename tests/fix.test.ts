import { describe, expect, it } from "vitest";
import { fix, lint, rewrap, unwrap } from "../src/index.js";
import { resolvePointer, setPointer } from "../src/pointer.js";

describe("setPointer", () => {
  it("replaces a nested value in place", () => {
    const root = { properties: { name: { type: "string" } } };
    expect(setPointer(root, "/properties/name", { type: "number" })).toBe(true);
    expect(root.properties.name).toEqual({ type: "number" });
  });

  it("replaces an array element", () => {
    const root = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(setPointer(root, "/anyOf/1", { type: "null" })).toBe(true);
    expect(root.anyOf[1]).toEqual({ type: "null" });
  });

  it("refuses the root pointer and pointers that do not resolve", () => {
    const root = { properties: {} };
    expect(setPointer(root, "", { type: "string" })).toBe(false);
    expect(setPointer(root, "/nowhere/deep", 1)).toBe(false);
    expect(setPointer({ anyOf: [] }, "/anyOf/3", 1)).toBe(false);
  });
});

describe("fix", () => {
  const nested = {
    type: "object",
    properties: {
      user: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    required: ["user"],
  };

  it("adds additionalProperties: false at every level", () => {
    const result = fix(nested, { providers: ["openai"] });
    expect(result.schema).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["user"],
      additionalProperties: false,
    });
    expect(result.applied.map((item) => item.path)).toEqual(["/properties/user", ""]);
    expect(result.applied[0]).toMatchObject({ ruleId: "openai/additional-properties-false", provider: "openai" });
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(nested);
    fix(nested, { providers: ["openai"] });
    expect(JSON.stringify(nested)).toBe(before);
  });

  it("produces a schema that no longer reports the fixed rule", () => {
    const { schema } = fix(nested, { providers: ["anthropic"] });
    const ruleIds = lint(schema, { providers: ["anthropic"] }).findings.map((finding) => finding.ruleId);
    expect(ruleIds).not.toContain("anthropic/additional-properties-false");
  });

  it("replaces an additionalProperties subschema with false", () => {
    const { schema } = fix(
      { type: "object", properties: {}, additionalProperties: { type: "string" } },
      { providers: ["openai"] },
    );
    expect(schema.additionalProperties).toBe(false);
  });

  it("reports the findings it cannot fix and applies nothing for them", () => {
    const result = fix(
      {
        type: "object",
        properties: { id: { oneOf: [{ type: "string" }, { type: "integer" }] } },
        required: ["id"],
      },
      { providers: ["openai"] },
    );
    const remaining = result.findings.map((finding) => finding.ruleId);
    expect(remaining).toContain("openai/no-one-of");
    expect(remaining).not.toContain("openai/additional-properties-false");
    expect(result.summary[0]?.errors).toBe(remaining.length);
  });

  it("requires every property and keeps the missing ones optional with null", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          score: { type: ["integer", "string"] },
          owner: { anyOf: [{ type: "string" }, { type: "integer" }] },
          reply: { $ref: "#/$defs/reply", description: "The last reply." },
        },
        required: ["id"],
        $defs: {
          reply: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
        },
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      id: { type: "string" },
      score: { type: ["integer", "string", "null"] },
      owner: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      reply: { description: "The last reply.", anyOf: [{ $ref: "#/$defs/reply" }, { type: "null" }] },
    });
    expect(schema.required).toEqual(["id", "score", "owner", "reply"]);
    expect(applied).toEqual([
      {
        ruleId: "openai/all-required",
        provider: "openai",
        path: "",
        title: 'Add score, owner, reply to "required", and "null" to the type of score, owner, reply.',
      },
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a property it cannot make nullable alone, and says so in the title", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: { kind: { enum: ["a", "b"] }, at: { type: ["string", "null"] } },
        required: [],
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({ kind: { enum: ["a", "b"] }, at: { type: ["string", "null"] } });
    expect(schema.required).toEqual(["kind", "at"]);
    expect(applied[0]?.title).toBe('Add kind, at to "required".');
  });

  it("requires properties of nested objects and definitions too", () => {
    const { schema } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: { user: { type: "object", properties: { name: { type: "string" } } } },
        required: ["user"],
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      user: {
        type: "object",
        properties: { name: { type: ["string", "null"] } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });

  it("does nothing to a schema that is already compatible", () => {
    const portable = { type: "object", properties: {}, required: [], additionalProperties: false };
    const result = fix(portable, { providers: ["openai"] });
    expect(result.applied).toEqual([]);
    expect(result.schema).toEqual(portable);
  });

  it("rejects a non-object schema the way lint does", () => {
    expect(() => fix("nope")).toThrow(TypeError);
  });
});

describe("rewrap", () => {
  it("puts a fixed schema back into the tool definition it came from", () => {
    const tool = {
      name: "get_weather",
      description: "Look up the weather.",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    };
    const { schema, keys } = unwrap(tool);
    const { schema: fixed } = fix(schema, { providers: ["anthropic"] });
    const document = rewrap(tool, keys, fixed) as typeof tool;

    expect(document.name).toBe("get_weather");
    expect(document.description).toBe("Look up the weather.");
    expect(document.input_schema).toMatchObject({ additionalProperties: false });
    expect(tool.input_schema).not.toHaveProperty("additionalProperties");
  });

  it("returns the schema itself for a bare document", () => {
    const bare = { type: "object" };
    expect(rewrap(bare, [], { type: "string" })).toEqual({ type: "string" });
  });

  it("records where nested wrappers keep the schema", () => {
    const tool = { type: "function", function: { name: "f", parameters: { type: "object" } } };
    const { keys } = unwrap(tool);
    expect(keys).toEqual(["function", "parameters"]);
    expect(resolvePointer(rewrap(tool, keys, { type: "string" }), "/function/parameters")).toEqual({ type: "string" });
  });
});
