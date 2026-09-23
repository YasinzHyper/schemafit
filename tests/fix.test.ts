import { describe, expect, it } from "vitest";
import { fix, lint, rewrap, unwrap } from "../src/index.js";
import { resolvePointer, setPointer } from "../src/pointer.js";
import { strictObject } from "./helpers.js";

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
        properties: { id: { allOf: [{ type: "string" }] } },
        required: ["id"],
      },
      { providers: ["openai"] },
    );
    const remaining = result.findings.map((finding) => finding.ruleId);
    expect(remaining).toContain("openai/unsupported-composition");
    expect(remaining).not.toContain("openai/additional-properties-false");
    expect(result.summary[0]?.errors).toBe(remaining.length);
  });

  it("renames oneOf to anyOf, at every depth and in place", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            description: "A string or a number.",
            oneOf: [{ type: "string" }, { oneOf: [{ type: "integer" }, { type: "number" }] }],
            title: "Id",
          },
        },
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      id: {
        description: "A string or a number.",
        anyOf: [{ type: "string" }, { anyOf: [{ type: "integer" }, { type: "number" }] }],
        title: "Id",
      },
    });
    // The rename keeps the keyword where it was, so the schema still reads in its original order.
    expect(Object.keys(resolvePointer(schema, "/properties/id") as object)).toEqual(["description", "anyOf", "title"]);
    expect(applied.map((item) => item.path)).toEqual(["/properties/id/oneOf/1", "/properties/id"]);
    expect(applied[0]?.title).toBe('Rename "oneOf" to "anyOf".');
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a oneOf that sits next to an anyOf for a human", () => {
    const union = { anyOf: [{ type: "string" }], oneOf: [{ type: "integer" }] };
    const result = fix(
      { type: "object", additionalProperties: false, required: ["id"], properties: { id: union } },
      { providers: ["openai"] },
    );

    expect(result.schema.properties).toEqual({ id: union });
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["openai/no-one-of"]);
  });

  it("merges an allOf of objects into the object that holds it", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        description: "A ticket.",
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "Tracking fields.",
            properties: { opened_at: { type: "string", format: "date-time" } },
            required: ["opened_at"],
          },
        ],
      },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      type: "object",
      description: "A ticket. Tracking fields.",
      properties: { id: { type: "string" }, opened_at: { type: "string", format: "date-time" } },
      required: ["id", "opened_at"],
      additionalProperties: false,
    });
    expect(applied.map((item) => item.title)).toContain('Merge the 2 "allOf" branches into the object.');
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("merges an allOf nested inside another one, deepest first", () => {
    const { schema, applied } = fix(
      strictObject({
        ticket: {
          type: "object",
          additionalProperties: false,
          allOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              allOf: [{ type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }],
            },
          ],
        },
      }),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      ticket: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, kind: { type: "string" } },
        required: ["id", "kind"],
      },
    });
    const merges = applied.filter((item) => item.ruleId === "openai/unsupported-composition");
    expect(merges.map((item) => item.path)).toEqual(["/properties/ticket/allOf/0", "/properties/ticket"]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves an allOf whose branches constrain the same property differently", () => {
    const intersection = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    };
    const result = fix(strictObject({ ticket: intersection }), { providers: ["openai"] });

    expect(result.schema.properties).toMatchObject({ ticket: { allOf: intersection.allOf } });
    expect(result.applied.map((item) => item.ruleId)).not.toContain("openai/unsupported-composition");
    expect(result.findings.map((finding) => finding.ruleId)).toContain("openai/unsupported-composition");
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

  it("moves Anthropic's unsupported numeric and string constraints into the description", () => {
    const { schema, applied } = fix(
      strictObject({
        score: { type: "integer", minimum: 100, maximum: 500, multipleOf: 5 },
        name: { type: "string", description: "The display name.", minLength: 1, maxLength: 80 },
      }),
      { providers: ["anthropic"] },
    );

    expect(schema.properties).toEqual({
      score: {
        type: "integer",
        description: "Must be at least 100. Must be at most 500. Must be a multiple of 5.",
      },
      name: {
        type: "string",
        description: "The display name. Must be at least 1 character long. Must be at most 80 characters long.",
      },
    });
    expect(applied.map((item) => item.title)).toEqual([
      'Remove "minimum" and state it in "description".',
      'Remove "maximum" and state it in "description".',
      'Remove "multipleOf" and state it in "description".',
      'Remove "minLength" and state it in "description".',
      'Remove "maxLength" and state it in "description".',
    ]);
    expect(lint(schema, { providers: ["anthropic"] }).findings).toEqual([]);
  });

  it("lowers minItems to 1 and describes the array constraints it drops", () => {
    const { schema, applied } = fix(
      strictObject({
        tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10, uniqueItems: true },
      }),
      { providers: ["anthropic"] },
    );

    expect(schema.properties).toEqual({
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Must have at least 2 items. Must have at most 10 items. Items must be unique.",
      },
    });
    expect(applied[0]?.title).toBe('Lower "minItems" to 1 and state the real minimum in "description".');
    expect(lint(schema, { providers: ["anthropic"] }).findings).toEqual([]);
  });

  it('drops a "uniqueItems": false that constrains nothing, without a note', () => {
    const { schema, applied } = fix(strictObject({ tags: { type: "array", items: {}, uniqueItems: false } }), {
      providers: ["anthropic"],
    });

    expect(schema.properties).toEqual({ tags: { type: "array", items: {} } });
    expect(applied.map((item) => item.title)).toEqual(['Remove "uniqueItems".']);
  });

  it("leaves a constraint it cannot put into words for a human", () => {
    // The draft-04 spelling, where exclusiveMinimum is a flag on minimum rather than a bound.
    const result = fix(strictObject({ n: { type: "number", exclusiveMinimum: true } }), {
      providers: ["anthropic"],
    });

    expect(result.schema.properties).toEqual({ n: { type: "number", exclusiveMinimum: true } });
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["anthropic/no-numeric-constraints"]);
  });

  it("drops an unsupported format and keeps what it required in the description", () => {
    const { schema, applied } = fix(
      strictObject({
        website: { type: "string", format: "uri", description: "Where to find them." },
        avatar: { type: "string", format: "uri-reference" },
        id: { type: "string", format: "uuid" },
      }),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      website: {
        type: "string",
        description: "Where to find them. Must be an absolute URI, such as https://example.com/a.",
      },
      avatar: { type: "string", description: "Must be a URI, absolute or relative." },
      // uuid is on OpenAI's documented list, so it stays.
      id: { type: "string", format: "uuid" },
    });
    expect(applied.map((item) => [item.path, item.title])).toEqual([
      ["/properties/website", 'Remove "format": "uri" and state it in "description".'],
      ["/properties/avatar", 'Remove "format": "uri-reference" and state it in "description".'],
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a format Gemini only leaves undocumented in place", () => {
    const portable = strictObject({ email: { type: "string", format: "email" } });
    const result = fix(portable, { providers: ["gemini"] });

    expect(result.schema).toEqual(portable);
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("gemini/undocumented-format");
  });

  it("wraps a union root in an object and keeps the definitions where refs find them", () => {
    const { schema, applied } = fix(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        description: "A ticket or an error.",
        anyOf: [{ $ref: "#/$defs/ticket" }, { $ref: "#/$defs/error" }],
        $defs: {
          ticket: strictObject({ id: { type: "string" } }),
          error: strictObject({ message: { type: "string" } }),
        },
      },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        result: {
          description: "A ticket or an error.",
          anyOf: [{ $ref: "#/$defs/ticket" }, { $ref: "#/$defs/error" }],
        },
      },
      required: ["result"],
      additionalProperties: false,
      $defs: {
        ticket: strictObject({ id: { type: "string" } }),
        error: strictObject({ message: { type: "string" } }),
      },
    });
    expect(applied).toEqual([
      {
        ruleId: "openai/root-object",
        provider: "openai",
        path: "",
        title: 'Wrap the root in an object with one property, "result".',
      },
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("wraps an array root, and fixes what the wrapping exposes", () => {
    const { schema } = fix(
      { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        result: {
          type: "array",
          items: strictObject({ id: { type: "string" } }),
        },
      },
      required: ["result"],
      additionalProperties: false,
    });
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a root with nothing to wrap for a human", () => {
    const definitionsOnly = { $defs: { ticket: strictObject({ id: { type: "string" } }) } };
    const result = fix(definitionsOnly, { providers: ["openai"] });

    expect(result.schema).toEqual(definitionsOnly);
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("openai/root-object");
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
