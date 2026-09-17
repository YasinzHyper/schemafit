import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVIDER_IDS, lint, providers, rules, unwrap } from "../src/index.js";
import { joinPointer, resolvePointer } from "../src/pointer.js";

const example = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));

describe("lint", () => {
  it("summarizes each selected provider, in the order given", () => {
    const { summary } = lint({ type: "string", minLength: 1 }, { providers: ["gemini", "openai"] });
    expect(summary).toEqual([
      { provider: "gemini", errors: 0, warnings: 1, compatible: true },
      { provider: "openai", errors: 1, warnings: 1, compatible: false },
    ]);
  });

  it("checks every provider by default", () => {
    expect(lint({ type: "object" }).summary.map((entry) => entry.provider)).toEqual([...PROVIDER_IDS]);
  });

  it("rejects input that is not a JSON object", () => {
    for (const input of [true, null, [], "schema", 1]) {
      expect(() => lint(input)).toThrow(TypeError);
    }
  });

  it("finds problems for every provider in the typical example", () => {
    const { summary } = lint(example("ticket.json"));
    expect(summary.find((entry) => entry.provider === "openai")?.compatible).toBe(false);
    expect(summary.find((entry) => entry.provider === "anthropic")?.compatible).toBe(false);
    expect(summary.find((entry) => entry.provider === "gemini")?.warnings).toBeGreaterThan(0);
  });

  it("finds nothing in the portable example", () => {
    expect(lint(example("ticket.portable.json")).findings).toEqual([]);
  });
});

describe("unwrap", () => {
  const schema = { type: "object", properties: {} };

  it.each([
    ["OpenAI Chat Completions tool", { type: "function", function: { name: "f", parameters: schema } }],
    ["OpenAI Responses tool", { type: "function", name: "f", parameters: schema }],
    ["OpenAI response_format", { type: "json_schema", json_schema: { name: "s", strict: true, schema } }],
    ["output format", { type: "json_schema", schema }],
    ["Anthropic tool", { name: "f", input_schema: schema }],
    ["MCP tool", { name: "f", inputSchema: schema }],
    ["named schema", { name: "s", strict: true, schema }],
    ["function definition", { name: "f", parameters: schema }],
  ])("finds the schema inside an %s", (label, document) => {
    const result = unwrap(document);
    expect(result.schema).toBe(schema);
    expect(result.wrapper).toContain(label.split(" ")[0]);
    expect(resolvePointer(document, joinPointer("", ...result.keys))).toBe(schema);
  });

  it("leaves bare schemas alone, even ones with properties named like wrappers", () => {
    const bare = { type: "object", properties: { name: { type: "string" }, schema: { type: "string" } } };
    expect(unwrap(bare)).toEqual({ schema: bare, wrapper: null, keys: [] });
  });
});

describe("rule metadata", () => {
  it("gives every rule a unique, provider-prefixed id", () => {
    const ids = rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of rules) {
      expect(rule.id).toMatch(new RegExp(`^${rule.provider}/[a-z]+(-[a-z]+)*$`));
      expect(providers[rule.provider].rules).toContain(rule);
    }
  });

  it("ties every rule to official documentation and a verification date", () => {
    for (const rule of rules) {
      expect(rule.source).toMatch(/^https:\/\/(developers\.openai\.com|platform\.claude\.com|ai\.google\.dev)\//);
      expect(rule.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rule.summary.length).toBeGreaterThan(10);
    }
  });
});
