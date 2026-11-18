import { describe, expect, it } from "vitest";
import { findingsFor, ruleIds } from "./helpers.js";

describe("gemini", () => {
  it("accepts the documented subset, including optional properties, anyOf, and recursion", () => {
    const schema = {
      type: "object",
      title: "Employee",
      description: "An employee and their reports.",
      properties: {
        name: { type: "string" },
        level: { type: "integer", minimum: 1, maximum: 10 },
        joined: { type: "string", format: "date" },
        status: { anyOf: [{ type: "string", enum: ["active", "left"] }, { type: "null" }] },
        position: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], minItems: 2, maxItems: 2 },
        reports: { type: "array", items: { $ref: "#" } },
      },
      required: ["name"],
      additionalProperties: { type: "string" },
    };
    expect(findingsFor("gemini", schema)).toEqual([]);
  });

  it("undocumented-keyword warns, because unsupported keywords may be silently ignored", () => {
    const found = findingsFor("gemini", {
      type: "object",
      properties: { code: { type: "string", pattern: "^[A-Z]{3}$", multipleOf: 3 } },
    });
    expect(found.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ["gemini/undocumented-keyword", "warn"],
      ["gemini/undocumented-keyword", "warn"],
    ]);
  });

  it("unenforced-constraint warns about each constraint the docs say the API strips", () => {
    const found = findingsFor("gemini", {
      type: "object",
      properties: {
        code: { type: "string", minLength: 3, maxLength: 3 },
        labels: { type: "object", minProperties: 1, maxProperties: 5 },
        tags: { type: "array", items: { type: "string" }, uniqueItems: true },
        ids: { type: "array", contains: { type: "integer" }, minContains: 1, maxContains: 2 },
      },
    });
    expect(found.map((finding) => [finding.ruleId, finding.severity, finding.path, finding.message])).toEqual(
      [
        ["/properties/code", "minLength"],
        ["/properties/code", "maxLength"],
        ["/properties/labels", "minProperties"],
        ["/properties/labels", "maxProperties"],
        ["/properties/tags", "uniqueItems"],
        ["/properties/ids", "contains"],
        ["/properties/ids", "minContains"],
        ["/properties/ids", "maxContains"],
      ].map(([path, keyword]) => [
        "gemini/unenforced-constraint",
        "warn",
        path,
        `"${keyword}" is not enforced; the API strips it from the schema without an error.`,
      ]),
    );
  });

  it("unenforced-constraint leaves the array bounds the docs say are enforced alone", () => {
    expect(ruleIds("gemini", { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 })).toEqual([]);
  });

  it("unenforced-constraint moves the constraint into the description", () => {
    const [length] = findingsFor("gemini", { type: "string", description: "A country code.", maxLength: 2 });
    expect(length?.fix?.title).toBe('Remove "maxLength" and state it in "description".');
    expect(length?.fix?.rewrite({ type: "string", description: "A country code.", maxLength: 2 })).toEqual({
      type: "string",
      description: "A country code. Must be at most 2 characters long.",
    });

    const [count] = findingsFor("gemini", { type: "object", minProperties: 1 });
    expect(count?.fix?.rewrite({ type: "object", minProperties: 1 })).toEqual({
      type: "object",
      description: "Must have at least 1 property.",
    });
    const [most] = findingsFor("gemini", { type: "object", maxProperties: 4 });
    expect(most?.fix?.rewrite({ type: "object", maxProperties: 4 })).toEqual({
      type: "object",
      description: "Must have at most 4 properties.",
    });
  });

  it("unenforced-constraint has no sentence for contains, so it attaches no fix", () => {
    const found = findingsFor("gemini", { type: "array", contains: { type: "integer" }, minContains: 2 });
    expect(found.map((finding) => finding.fix)).toEqual([undefined, undefined]);
  });

  it("points oneOf users at anyOf", () => {
    const [finding] = findingsFor("gemini", { type: "object", properties: { v: { oneOf: [{ type: "string" }] } } });
    expect(finding?.hint).toContain("anyOf");
  });

  it("undocumented-format warns about formats beyond date-time, date, and time", () => {
    expect(ruleIds("gemini", { type: "string", format: "email" })).toEqual(["gemini/undocumented-format"]);
    expect(ruleIds("gemini", { type: "string", format: "date-time" })).toEqual([]);
  });

  it("undocumented-format keeps the format, because it is undocumented rather than rejected", () => {
    const [finding] = findingsFor("gemini", { type: "string", format: "email" });
    expect(finding?.fix).toBeUndefined();
  });

  it("never reports errors", () => {
    const found = findingsFor("gemini", {
      not: {},
      if: {},
      allOf: [],
      const: 1,
      format: "uri",
      multipleOf: 2,
      maxLength: 3,
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.severity === "warn")).toBe(true);
  });
});
