import { describe, expect, it } from "vitest";
import { fixOpenApi, lint, openApiInlineSchemas, openApiSchemas } from "../src/index.js";
import type { Finding, LintResult } from "../src/index.js";
import { summarize } from "../src/lint.js";
import { withoutCopiedFindings } from "../src/openapi.js";
import { strictObject } from "./helpers.js";

const tag = strictObject({ name: { type: "string", minLength: 1 } });
const pet = strictObject({ id: { type: "integer" }, tag: { $ref: "#/components/schemas/Tag" } });

function openApi(schemas: Record<string, unknown>, openapi = "3.1.1"): unknown {
  return { openapi, info: { title: "Pets", version: "1" }, paths: {}, components: { schemas } };
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

  it("copies a component the component's own definitions already hold under a name of its own", () => {
    const holder = { ...strictObject({ tag: { $ref: "#/components/schemas/Tag" } }), $defs: { Tag: tag } };
    const [, found] = openApiSchemas(openApi({ Tag: tag, Holder: holder }));
    expect(found?.copiedAs).toEqual({ Tag: "components.schemas.Tag" });
    expect(found?.schema).toEqual({
      ...strictObject({ tag: { $ref: "#/$defs/components.schemas.Tag" } }),
      $defs: { Tag: tag, "components.schemas.Tag": tag },
    });
  });

  it("refuses a component whose own definitions already use a referenced component's name", () => {
    const clash = { ...pet, $defs: { Tag: { type: "string" } } };
    expect(() => openApiSchemas(openApi({ Tag: tag, Pet: clash }))).toThrow(TypeError);
  });

  it("reads OpenAPI 3.0's nullable as the type array JSON Schema spells it as", () => {
    const named = strictObject({
      name: { type: "string", nullable: true },
      tags: { type: "array", items: { type: "string", nullable: true } },
    });
    const holder = strictObject({ named: { $ref: "#/components/schemas/Named" } });
    const [found, bundled] = openApiSchemas(openApi({ Named: named, Holder: holder }, "3.0.3"));
    const translated = strictObject({
      name: { type: ["string", "null"] },
      tags: { type: "array", items: { type: ["string", "null"] } },
    });
    expect(found?.schema).toEqual(translated);
    expect((bundled?.schema as { $defs: unknown }).$defs).toEqual({ Named: translated });
  });

  it("keeps an enum beside a translated nullable, which still rules null out", () => {
    const status = strictObject({ status: { type: "string", enum: ["open", "closed"], nullable: true } });
    const [found] = openApiSchemas(openApi({ Status: status }, "3.0.0"));
    expect(found?.schema).toEqual(strictObject({ status: { type: ["string", "null"], enum: ["open", "closed"] } }));
  });

  it("leaves a nullable that takes no effect, and every nullable of an OpenAPI 3.1 document, as written", () => {
    const loose = strictObject({ any: { nullable: true }, never: { type: "string", nullable: false } });
    const [found] = openApiSchemas(openApi({ Loose: loose }, "3.0.3"));
    expect(found?.schema).toEqual(loose);
    const written = strictObject({ name: { type: "string", nullable: true } });
    expect(openApiSchemas(openApi({ Named: written }))[0]?.schema).toEqual(written);
  });

  it("finds nothing in a document without schema components", () => {
    expect(openApiSchemas({ openapi: "3.1.1", paths: {} })).toEqual([]);
    expect(openApiSchemas({ type: "object" })).toEqual([]);
  });
});

describe("openApiInlineSchemas", () => {
  const order = strictObject({ quantity: { type: "integer", minimum: 1 } });
  const json = (schema: unknown) => ({ content: { "application/json": { schema } } });
  const withPaths = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}) => ({
    ...(openApi(schemas) as object),
    paths,
  });

  it("finds the request body and responses of every operation, named for where they are used", () => {
    const document = withPaths({
      "/orders": {
        post: {
          requestBody: json(order),
          responses: { "201": { description: "Created", ...json(order) } },
        },
      },
    });
    expect(openApiInlineSchemas(document).map(({ name, pointer, wrapper }) => [name, pointer, wrapper])).toEqual([
      [
        "POST /orders request body, application/json",
        "/paths/~1orders/post/requestBody/content/application~1json/schema",
        "OpenAPI request body",
      ],
      [
        "POST /orders 201 response, application/json",
        "/paths/~1orders/post/responses/201/content/application~1json/schema",
        "OpenAPI response",
      ],
    ]);
  });

  it("leaves out parameters, whose schemas are never sent on their own", () => {
    const document = withPaths({
      "/pets": {
        parameters: [{ name: "store", in: "query", schema: { type: "string" } }],
        get: {
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "X-Trace", in: "header", content: { "text/plain": { schema: { type: "string" } } } },
          ],
          responses: { "200": json(order) },
        },
      },
    });
    expect(openApiInlineSchemas(document).map(({ name }) => name)).toEqual(["GET /pets 200 response, application/json"]);
  });

  it("returns the schema as declared, with the keys that lead to it", () => {
    const [found] = openApiInlineSchemas(withPaths({ "/orders": { post: { requestBody: json(order) } } }));
    expect(found?.schema).toEqual(order);
    expect(found?.keys).toEqual(["paths", "/orders", "post", "requestBody", "content", "application/json", "schema"]);
    expect(found?.copied).toEqual([]);
  });

  it("copies the components an inline schema references under $defs", () => {
    const body = strictObject({ tag: { $ref: "#/components/schemas/Tag" } });
    const [found] = openApiInlineSchemas(withPaths({ "/pets": { put: { requestBody: json(body) } } }, { Tag: tag }));
    expect(found?.copied).toEqual(["Tag"]);
    expect(found?.wrapper).toBe("OpenAPI request body, with the components it references under $defs");
    expect(found?.schema).toEqual({ ...body, properties: { tag: { $ref: "#/$defs/Tag" } }, $defs: { Tag: tag } });
  });

  it("leaves out a schema that is only a reference to a component, and Reference Objects", () => {
    const document = withPaths(
      {
        "/pets": {
          parameters: [{ $ref: "#/components/parameters/Limit" }],
          get: {
            requestBody: { $ref: "#/components/requestBodies/Pet" },
            responses: {
              "200": { description: "A pet", ...json({ $ref: "#/components/schemas/Tag" }) },
              "404": { $ref: "#/components/responses/NotFound" },
            },
          },
        },
      },
      { Tag: tag },
    );
    expect(openApiInlineSchemas(document)).toEqual([]);
  });

  it("keeps a schema that references part of a component, which no component report covers as a root", () => {
    const response = json({ $ref: "#/components/schemas/Tag/properties/name" });
    const document = withPaths({ "/pets": { get: { responses: { "200": response } } } }, { Tag: tag });
    expect(openApiInlineSchemas(document).map(({ name }) => name)).toEqual(["GET /pets 200 response, application/json"]);
  });

  it("reads only the fields of a path item that hold an operation", () => {
    const item = { summary: "Pets", servers: [], "x-internal": { requestBody: json(order) } };
    const document = withPaths({ "/pets": item });
    expect(openApiInlineSchemas(document)).toEqual([]);
  });

  it("returns nothing for a document without paths", () => {
    expect(openApiInlineSchemas({ openapi: "3.1.1", components: { schemas: { Tag: tag } } })).toEqual([]);
  });

  it("reports a finding in a component an inline schema references once, on the component", () => {
    const body = strictObject({ tag: { $ref: "#/components/schemas/Tag" } });
    const document = withPaths({ "/pets": { post: { requestBody: json(body) } } }, { Tag: tag });
    const schemas = [...openApiSchemas(document), ...openApiInlineSchemas(document)];
    const results = schemas.map((found) => lint(found.schema, { providers: ["anthropic"] }));
    const counted = (findings: readonly Finding[]) => summarize(findings, ["anthropic"]);
    const [component, inline] = withoutCopiedFindings(schemas, results, counted);
    expect(component?.findings.map((item) => item.ruleId)).toEqual(["anthropic/no-string-length"]);
    expect(inline?.findings).toEqual([]);
  });

  it("does not take an inline schema for a component that happens to share its name", () => {
    const name = "POST /pets request body, application/json";
    const document = withPaths({ "/pets": { post: { requestBody: json(tag) } } }, { [name]: { type: "object" } });
    const schemas = [...openApiSchemas(document), ...openApiInlineSchemas(document)];
    const results = schemas.map((found) => lint(found.schema, { providers: ["anthropic"] }));
    const [, inline] = withoutCopiedFindings(schemas, results, (findings) => summarize(findings, ["anthropic"]));
    expect(inline?.findings.map((item) => item.ruleId)).toEqual(["anthropic/no-string-length"]);
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

describe("fixOpenApi", () => {
  it("fixes each component and puts it back without the copies of the components it references", () => {
    const document = openApi({ Tag: tag, Pet: pet });
    const { document: fixed, components } = fixOpenApi(document, { providers: ["anthropic"] });
    expect((fixed as { components: unknown }).components).toEqual({
      schemas: {
        Tag: strictObject({ name: { type: "string", description: "Must be at least 1 character long." } }),
        Pet: pet,
      },
    });
    expect(components.map(({ name, applied }) => [name, applied.map((item) => item.path)])).toEqual([
      ["Tag", ["/properties/name"]],
      ["Pet", []],
    ]);
    expect(document).toEqual(openApi({ Tag: tag, Pet: pet }));
  });

  it("reports what remains in a copy on the component it was copied from alone", () => {
    const loose = { type: "object", properties: { at: { type: "string", format: "email" } } };
    const holder = strictObject({ loose: { $ref: "#/components/schemas/Loose" } });
    const { components } = fixOpenApi(openApi({ Loose: loose, Holder: holder }), { providers: ["gemini"] });
    expect(components.map(({ name, findings }) => [name, findings.map((item) => item.path)])).toEqual([
      ["Loose", ["/properties/at"]],
      ["Holder", []],
    ]);
  });

  it("keeps what a fix inlined into the component, and the component's own definitions", () => {
    const base = strictObject({ id: { type: "integer" } });
    const named = {
      allOf: [{ $ref: "#/components/schemas/Base" }, strictObject({ name: { type: "string" } })],
      $defs: { Id: { type: "integer" } },
    };
    const { document } = fixOpenApi(openApi({ Base: base, Named: named }), { providers: ["anthropic"] });
    const schemas = (document as { components: { schemas: Record<string, { $defs?: unknown; allOf?: unknown }> } })
      .components.schemas;
    expect(schemas.Named?.allOf).toEqual([base, named.allOf[1]]);
    expect(schemas.Named?.$defs).toEqual({ Id: { type: "integer" } });
  });

  it("points a reference that stays back at the component", () => {
    const branches = [{ $ref: "#/components/schemas/Node" }, { type: "null" }];
    const node = strictObject({ next: { oneOf: branches } });
    const { document } = fixOpenApi(openApi({ Node: node }), { providers: ["openai"] });
    expect((document as { components: { schemas: unknown } }).components.schemas).toEqual({
      Node: strictObject({ next: { anyOf: branches } }),
    });
  });

  it("does not wrap the root of a component that is not an object", () => {
    const status = { type: "string", enum: ["available", "sold"] };
    const { document, components } = fixOpenApi(openApi({ Status: status }), { providers: ["openai"] });
    expect((document as { components: { schemas: unknown } }).components.schemas).toEqual({ Status: status });
    expect(components[0]?.findings.map((item) => item.ruleId)).toEqual(["openai/root-object"]);
  });

  it("points a reference back at the component when the component's own definitions hold the same schema", () => {
    const base = strictObject({ id: { type: "string" } });
    const holder = { ...strictObject({ b: { $ref: "#/components/schemas/Base" } }), $defs: { Base: base } };
    const { document, components } = fixOpenApi(openApi({ Base: base, Holder: holder }), { providers: ["openai"] });
    expect(components[1]?.applied).toEqual([]);
    expect((document as { components: { schemas: unknown } }).components.schemas).toEqual({ Base: base, Holder: holder });
  });

  it("keeps an own reference to a definition apart from the reference the bundle made", () => {
    const base = strictObject({ id: { type: "string" } });
    const holder = {
      ...strictObject({ shared: { $ref: "#/components/schemas/Base" }, local: { $ref: "#/$defs/Base" } }),
      $defs: { Base: base },
    };
    const { document } = fixOpenApi(openApi({ Base: base, Holder: holder }), { providers: ["openai"] });
    expect((document as { components: { schemas: { Holder: unknown } } }).components.schemas.Holder).toEqual(holder);
  });

  it("keeps an empty $defs the component declared itself", () => {
    const holder = { ...strictObject({ tag: { $ref: "#/components/schemas/Tag" } }), $defs: {} };
    const { document } = fixOpenApi(openApi({ Tag: tag, Holder: holder }), { providers: ["openai"] });
    expect((document as { components: { schemas: { Holder: unknown } } }).components.schemas.Holder).toEqual(holder);
  });

  it("leaves every component no fix applied to exactly as it was", () => {
    const base = strictObject({ id: { type: "string" } });
    const documents = [
      openApi({ Tag: tag, Pet: pet }),
      openApi({ Tag: tag, Pet: { ...pet, $defs: {} }, Owner: strictObject({ pet: { $ref: "#/components/schemas/Pet" } }) }),
      openApi({ Base: base, Holder: { ...strictObject({ b: { $ref: "#/components/schemas/Base" } }), $defs: { Base: base } } }),
      openApi({ Node: strictObject({ next: { anyOf: [{ $ref: "#/components/schemas/Node" }, { type: "null" }] } }) }),
      openApi({ "A/B": base, Ref: strictObject({ ab: { $ref: "#/components/schemas/A~1B" } }) }),
    ];
    for (const document of documents) {
      for (const providers of [["openai"], ["anthropic"], ["gemini"]] as const) {
        const { document: fixed, components } = fixOpenApi(document, { providers: [...providers] });
        const before = (document as { components: { schemas: Record<string, unknown> } }).components.schemas;
        const after = (fixed as { components: { schemas: Record<string, unknown> } }).components.schemas;
        for (const { name, applied } of components) {
          if (applied.length === 0) expect(after[name as string], `${name} for ${providers[0]}`).toEqual(before[name as string]);
        }
      }
    }
  });

  it("writes the nullable of an OpenAPI 3.0 document back as the keyword, a fix's own included", () => {
    const pet = {
      type: "object",
      properties: { name: { type: "string", nullable: true }, age: { type: "integer" } },
      additionalProperties: false,
    };
    const document = openApi({ Pet: pet }, "3.0.3");
    const { document: fixed, components } = fixOpenApi(document, { providers: ["openai"] });
    expect((fixed as { components: { schemas: unknown } }).components.schemas).toEqual({
      Pet: {
        type: "object",
        properties: { name: { type: "string", nullable: true }, age: { type: "integer", nullable: true } },
        additionalProperties: false,
        required: ["name", "age"],
      },
    });
    expect(components[0]?.applied.map((item) => item.title)).toEqual([
      'Add name, age to "required", and "null" to the type of age.',
    ]);
  });

  it("replaces a nullable: false in an OpenAPI 3.0 document when a fix makes the property nullable", () => {
    const flags = {
      type: "object",
      properties: { on: { type: "string" }, off: { type: "integer", nullable: false } },
      required: ["on"],
      additionalProperties: false,
    };
    const document = openApi({ Flags: flags }, "3.0.3");
    const { document: fixed } = fixOpenApi(document, { providers: ["openai"] });
    expect((fixed as { components: { schemas: unknown } }).components.schemas).toEqual({
      Flags: {
        type: "object",
        properties: { on: { type: "string" }, off: { type: "integer", nullable: true } },
        required: ["on", "off"],
        additionalProperties: false,
      },
    });
  });

  it("leaves a component of an OpenAPI 3.0 document no fix applied to exactly as it was", () => {
    const named = strictObject({ name: { nullable: true, type: "string" } });
    const document = openApi({ Named: named }, "3.0.3");
    const { document: fixed } = fixOpenApi(document, { providers: ["openai"] });
    const { components } = fixed as { components: unknown };
    expect(JSON.stringify(components)).toBe(JSON.stringify({ schemas: { Named: named } }));
  });

  it("names a component that is not a JSON object", () => {
    expect(() => fixOpenApi(openApi({ Tag: tag, Any: true }))).toThrow('Component "Any": Schema must be a JSON object.');
  });

  it("returns a document without schema components as it is", () => {
    const document = { openapi: "3.1.1", paths: {} };
    expect(fixOpenApi(document)).toEqual({ document, components: [] });
  });
});
