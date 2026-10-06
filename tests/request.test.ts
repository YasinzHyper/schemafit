import { describe, expect, it } from "vitest";
import { lint, lintRequest, lintSchema, requestSchemas } from "../src/index.js";
import type { Finding, JsonSchema } from "../src/index.js";
import { strictObject } from "./helpers.js";

/** An object with `count` properties, none of them required. */
function optional(count: number): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { type: "string" }])),
    required: [],
    additionalProperties: false,
  };
}

/** An object with `count` properties, each of them a union. */
function unions(count: number): JsonSchema {
  return strictObject(
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `p${i}`,
        i % 2 === 0 ? { type: ["string", "null"] } : { anyOf: [{ type: "string" }, { type: "null" }] },
      ]),
    ),
  );
}

/** An Anthropic Messages request body holding `tools`. */
function request(tools: readonly unknown[], rest: Record<string, unknown> = {}): unknown {
  return { model: "claude-opus-5-5", max_tokens: 1024, messages: [], tools, ...rest };
}

function findings(document: unknown): Finding[] {
  return lintRequest(document, { providers: ["anthropic"] }).findings;
}

function ids(document: unknown): string[] {
  return findings(document).map((finding) => finding.ruleId);
}

describe("requestSchemas", () => {
  it("counts every schema the request sends strictly, in document order", () => {
    const document = request(
      [
        { name: "a", input_schema: optional(1), strict: true },
        { name: "b", input_schema: optional(1), strict: false },
        { name: "c", input_schema: optional(1) },
        { type: "web_search_20260209", name: "web_search" },
      ],
      { output_config: { format: { type: "json_schema", schema: optional(1) } } },
    );
    expect(requestSchemas(document).map(({ pointer, kind, strict }) => `${pointer} ${kind} ${strict}`)).toEqual([
      "/tools/0/input_schema tool true",
      "/tools/2/input_schema tool undefined",
      "/output_config/format/schema format undefined",
    ]);
  });

  it("treats a bare schema as the one schema of its request", () => {
    expect(requestSchemas(optional(1)).map(({ pointer, kind }) => `${pointer || "#"} ${kind}`)).toEqual(["# null"]);
  });
});

describe("anthropic/optional-parameters-limit", () => {
  // The docs' own example: "4 strict tools with 6 optional parameters each" reaches the limit.
  const tools = (each: number): unknown =>
    request(Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, input_schema: optional(each), strict: true })));

  it("adds up the optional parameters of every strict schema", () => {
    expect(ids(tools(6))).toEqual([]);
    expect(ids(tools(7))).toEqual(["anthropic/optional-parameters-limit"]);
  });

  it("names the request and what each schema contributed", () => {
    const [finding] = findings(tools(7));
    expect(finding?.path).toBe("");
    expect(finding?.message).toBe(
      "The request's 4 strict schemas have 28 optional parameters; the request-wide limit is 24 " +
        "(t0 7, t1 7, t2 7, t3 7).",
    );
  });

  it("leaves out a tool that turns strictness off", () => {
    const document = request([
      { name: "strict", input_schema: optional(20), strict: true },
      { name: "loose", input_schema: optional(20), strict: false },
    ]);
    expect(ids(document)).toEqual([]);
  });

  it("counts an output schema alongside the tools", () => {
    const document = request([{ name: "t", input_schema: optional(20), strict: true }], {
      output_config: { format: { type: "json_schema", name: "answer", schema: optional(5) } },
    });
    expect(ids(document)).toEqual(["anthropic/optional-parameters-limit"]);
    expect(findings(document)[0]?.message).toContain("(t 20, answer 5)");
  });

  it("keeps the wording of a request that holds one schema", () => {
    const [finding] = findings(optional(25));
    expect(finding?.message).toBe("The schema has 25 optional parameters; the request-wide limit is 24.");
  });
});

describe("anthropic/union-parameters-limit", () => {
  it("adds up the union parameters of every strict schema", () => {
    const tools = (each: number): unknown =>
      request(Array.from({ length: 4 }, (_, i) => ({ name: `t${i}`, input_schema: unions(each), strict: true })));
    expect(ids(tools(4))).toEqual([]);
    expect(ids(tools(5))).toEqual(["anthropic/union-parameters-limit"]);
    expect(findings(tools(5))[0]?.message).toContain("20 parameters with union types");
  });
});

describe("anthropic/strict-tools-limit", () => {
  const tools = (count: number, strict: boolean): unknown =>
    request(Array.from({ length: count }, (_, i) => ({ name: `t${i}`, input_schema: strictObject({}), strict })));

  it("allows 20 strict tools and rejects 21", () => {
    expect(ids(tools(20, true))).toEqual([]);
    expect(ids(tools(21, true))).toEqual(["anthropic/strict-tools-limit"]);
    expect(findings(tools(21, true))[0]?.message).toContain('21 tools with "strict": true');
  });

  it("does not count the tools that are not strict", () => {
    expect(ids(tools(21, false))).toEqual([]);
    const unstated = request(Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, input_schema: strictObject({}) })));
    expect(ids(unstated)).toEqual([]);
  });

  it("does not count an output schema as a tool", () => {
    const document = request(
      Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, input_schema: strictObject({}), strict: true })),
      { output_config: { format: { type: "json_schema", schema: strictObject({}) } } },
    );
    expect(ids(document)).toEqual([]);
  });
});

describe("the two scopes together", () => {
  it("lintSchema reports the schema's own rules only", () => {
    const schema = optional(25);
    expect(lintSchema(schema, { providers: ["anthropic"] }).findings).toEqual([]);
    expect(lint(schema, { providers: ["anthropic"] }).findings.map((finding) => finding.ruleId)).toEqual([
      "anthropic/optional-parameters-limit",
    ]);
  });

  it("summarizes the request the way lint summarizes a schema", () => {
    expect(lintRequest(optional(25), { providers: ["anthropic", "openai"] }).summary).toEqual([
      { provider: "anthropic", errors: 1, warnings: 0, compatible: false },
      { provider: "openai", errors: 0, warnings: 0, compatible: true },
    ]);
  });

  it("says nothing about a request within every limit", () => {
    expect(lintRequest(request([{ name: "t", input_schema: strictObject({}), strict: true }])).findings).toEqual([]);
  });
});
