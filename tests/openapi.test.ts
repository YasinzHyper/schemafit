import { describe, expect, it } from "vitest";
import { lint, openApiSchemas } from "../src/index.js";
import type { Finding, LintResult } from "../src/index.js";
import { summarize } from "../src/lint.js";
import { withoutCopiedFindings } from "../src/openapi.js";
import { strictObject } from "./helpers.js";

const tag = strictObject({ name: { type: "string", minLength: 1 } });
const pet = strictObject({ id: { type: "integer" }, tag: { $ref: "#/components/schemas/Tag" } });

function openApi(schemas: Record<string, unknown>): unknown {
  return { openapi: "3.1.1", info: { title: "Pets", version: "1" }, paths: {}, components: { schemas } };
}

describe("openApiSchemas", () => {
  it("returns every component under its name and pointer", () => {
    const found = openApiSchemas(openApi({ Tag: tag, Pet: pet }));
    expect(found.map(({ name, pointer }) => [name, pointer])).toEqual([
      ["Tag", "/components/schemas/Tag"],
      ["Pet", "/components/schemas/Pet"],
    ]);
  });

  it("leaves a component that references none as it is", () => {
    const [found] = openApiSchemas(openApi({ Tag: tag }));
    expect(found?.schema).toEqual(tag);
    expect(found?.copied).toEqual([]);
    expect(found?.wrapper).toBe("OpenAPI component");
  });

  it("copies a referenced component under $defs and points the reference at it", () => {
    const [, found] = openApiSchemas(openApi({ Tag: tag, Pet: pet }));
    expect(found?.copied).toEqual(["Tag"]);
    expect(found?.schema).toEqual({
      ...pet,
      properties: { id: { type: "integer" }, tag: { $ref: "#/$defs/Tag" } },
      $defs: { Tag: tag },
    });
  });

  it("copies what a referenced component references in turn, and rewrites a reference into one", () => {
    const owner = strictObject({ pet: { $ref: "#/components/schemas/Pet" } });
    const name = strictObject({ value: { $ref: "#/components/schemas/Tag/properties/name" } });
    const found = openApiSchemas(openApi({ Tag: tag, Pet: pet, Owner: owner, Name: name }));
    expect(found[2]?.copied.sort()).toEqual(["Pet", "Tag"]);
    expect((found[2]?.schema as { $defs: Record<string, unknown> }).$defs.Pet).toMatchObject({
      properties: { tag: { $ref: "#/$defs/Tag" } },
    });
    expect((found[3]?.schema as { properties: { value: unknown } }).properties.value).toEqual({
      $ref: "#/$defs/Tag/properties/name",
    });
  });

  it("copies a component that refers to itself, so the recursion resolves inside the schema", () => {
    const node = strictObject({ children: { type: "array", items: { $ref: "#/components/schemas/Node" } } });
    const [found] = openApiSchemas(openApi({ Node: node }));
    expect(found?.copied).toEqual(["Node"]);
    const ruleIds = lint(found?.schema, { providers: ["anthropic"] }).findings.map((item) => item.ruleId);
    expect(ruleIds).toContain("anthropic/no-recursive-schemas");
  });

  it("leaves a reference to a component the document does not declare as it is", () => {
    const [found] = openApiSchemas(openApi({ Pet: pet }));
    expect(found?.copied).toEqual([]);
    expect(found?.schema).toEqual(pet);
  });

  it("keeps the component's own definitions beside the copied ones", () => {
    const own = { ...pet, $defs: { Id: { type: "integer" } } };
    const [, found] = openApiSchemas(openApi({ Tag: tag, Pet: own }));
    expect((found?.schema as { $defs: unknown }).$defs).toEqual({ Id: { type: "integer" }, Tag: tag });
  });

  it("refuses a component whose own definitions already use a referenced component's name", () => {
    const clash = { ...pet, $defs: { Tag: { type: "string" } } };
    expect(() => openApiSchemas(openApi({ Tag: tag, Pet: clash }))).toThrow(TypeError);
  });

  it("finds nothing in a document without schema components", () => {
    expect(openApiSchemas({ openapi: "3.1.1", paths: {} })).toEqual([]);
    expect(openApiSchemas({ type: "object" })).toEqual([]);
  });
});

describe("withoutCopiedFindings", () => {
  const counted = (findings: readonly Finding[]) => summarize(findings, ["anthropic"]);
  const lintAll = (document: unknown) => {
    const components = openApiSchemas(document);
    const results = components.map((found) => lint(found.schema, { providers: ["anthropic"] }));
    return withoutCopiedFindings(components, results, counted);
  };

  it("reports a finding in a shared component once, on that component", () => {
    const [own, referencing] = lintAll(openApi({ Tag: tag, Pet: pet }));
    expect(own?.findings.map((item) => [item.ruleId, item.path])).toEqual([
      ["anthropic/no-string-length", "/properties/name"],
    ]);
    expect(referencing?.findings).toEqual([]);
    expect(referencing?.summary).toEqual([{ provider: "anthropic", errors: 0, warnings: 0, compatible: true }]);
  });

  it("keeps a finding in a copy that the component's own report does not hold", () => {
    const components = openApiSchemas(openApi({ Tag: tag, Pet: pet }));
    const only: Finding = {
      ruleId: "anthropic/example",
      provider: "anthropic",
      severity: "error",
      path: "/$defs/Tag/properties/name",
      message: "Only the bundle shows this.",
      source: "https://example.com",
    };
    const results: LintResult[] = [
      { findings: [], summary: counted([]) },
      { findings: [only], summary: counted([only]) },
    ];
    expect(withoutCopiedFindings(components, results, counted)[1]?.findings).toEqual([only]);
  });
});
