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
      properties: { code: { type: "string", pattern: "^[A-Z]{3}$", minLength: 3 } },
    });
    expect(found.map((finding) => [finding.ruleId, finding.severity])).toEqual([
      ["gemini/undocumented-keyword", "warn"],
      ["gemini/undocumented-keyword", "warn"],
    ]);
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
    const found = findingsFor("gemini", { not: {}, if: {}, allOf: [], const: 1, format: "uri", multipleOf: 2 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.severity === "warn")).toBe(true);
  });
});
