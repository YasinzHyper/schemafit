import { describe, expect, it } from "vitest";
import { rewrap, unwrapAll } from "../src/index.js";
import type { JsonSchema } from "../src/index.js";

const SCHEMA: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

/** `<pointer> <wrapper> <name>` for each schema found, which is what the report header shows. */
function found(document: unknown): string[] {
  return unwrapAll(document).map(({ pointer, wrapper, name }) => `${pointer || "#"} ${wrapper} ${name ?? "-"}`);
}

describe("unwrapAll", () => {
  it("finds the one schema of a bare document, as unwrap does", () => {
    expect(unwrapAll(SCHEMA)).toEqual([{ schema: SCHEMA, wrapper: null, keys: [], pointer: "" }]);
    expect(found({ name: "f", input_schema: SCHEMA })).toEqual(["/input_schema Anthropic tool (input_schema) f"]);
  });

  it("finds every tool of a request body and names it", () => {
    const body = {
      model: "claude-opus-5-5",
      tools: [
        { name: "search", description: "…", input_schema: SCHEMA },
        { type: "function", name: "get_weather", parameters: SCHEMA },
      ],
      messages: [{ role: "user", content: "hi" }],
    };
    expect(found(body)).toEqual([
      "/tools/0/input_schema Anthropic tool (input_schema) search",
      "/tools/1/parameters OpenAI Responses tool (parameters) get_weather",
    ]);
    expect(unwrapAll(body).map(({ schema }) => schema)).toEqual([SCHEMA, SCHEMA]);
  });

  it("skips a tool that declares no schema", () => {
    // A server tool, as the Anthropic tool-use docs pass one, and an OpenAI built-in.
    const body = {
      tools: [
        { type: "web_search_20260209", name: "web_search" },
        { type: "code_interpreter", container: { type: "auto" } },
        { name: "search", input_schema: SCHEMA },
      ],
    };
    expect(found(body)).toEqual(["/tools/2/input_schema Anthropic tool (input_schema) search"]);
  });

  it("descends into the tools of an OpenAI namespace", () => {
    const body = {
      tools: [
        {
          type: "namespace",
          name: "crm",
          description: "CRM tools.",
          tools: [{ type: "function", name: "get_customer_profile", parameters: SCHEMA }],
        },
      ],
    };
    expect(found(body)).toEqual(["/tools/0/tools/0/parameters OpenAI Responses tool (parameters) get_customer_profile"]);
  });

  it("finds the response format of a Chat Completions and a Responses request", () => {
    const chat = { messages: [], response_format: { type: "json_schema", json_schema: { name: "ticket", schema: SCHEMA } } };
    expect(found(chat)).toEqual(["/response_format/json_schema/schema OpenAI response_format (json_schema.schema) ticket"]);

    const responses = { input: "hi", text: { format: { type: "json_schema", name: "ticket", schema: SCHEMA } } };
    expect(found(responses)).toEqual(["/text/format/schema output format (schema) ticket"]);
  });

  it("finds the tools and the response format of one request body", () => {
    const body = {
      tools: [{ name: "search", input_schema: SCHEMA }],
      response_format: { type: "json_schema", json_schema: { name: "answer", schema: SCHEMA } },
    };
    expect(found(body)).toEqual([
      "/tools/0/input_schema Anthropic tool (input_schema) search",
      "/response_format/json_schema/schema OpenAI response_format (json_schema.schema) answer",
    ]);
  });

  it("finds the response schema of a Gemini request, which names no wrapper key", () => {
    const body = {
      model: "gemini-3.8-flash",
      input: "…",
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    };
    expect(found(body)).toEqual(["/response_format/schema output format (schema) -"]);
    expect(unwrapAll(body)[0]?.schema).toEqual(SCHEMA);
  });

  it("ignores a response format that asks for no schema", () => {
    expect(found({ tools: [], response_format: { type: "json_object" } })).toEqual([]);
    expect(found({ text: { format: { type: "text" } } })).toEqual([]);
  });

  it("finds every entry of an array, tools and bare schemas alike", () => {
    expect(found([{ name: "f", input_schema: SCHEMA }, SCHEMA])).toEqual([
      "/0/input_schema Anthropic tool (input_schema) f",
      "/1 null -",
    ]);
  });

  it("leaves a schema whose own properties are named like a request body alone", () => {
    // "tools" here is a property of the schema, not a list of tool definitions.
    const schema = { type: "object", properties: { tools: { type: "array" } }, required: ["tools"] };
    expect(found(schema)).toEqual(["# null -"]);
    expect(found({ ...schema, tools: {} })).toEqual(["# null -"]);
  });

  it("rewraps every schema it found, by the keys it reports", () => {
    const body = { tools: [{ name: "a", input_schema: { type: "object" } }, { name: "b", input_schema: { type: "object" } }] };
    let document: unknown = body;
    for (const [index, { keys }] of unwrapAll(body).entries()) {
      document = rewrap(document, keys, { type: "object", title: `fixed ${index}` });
    }
    expect(document).toEqual({
      tools: [
        { name: "a", input_schema: { type: "object", title: "fixed 0" } },
        { name: "b", input_schema: { type: "object", title: "fixed 1" } },
      ],
    });
    // The input is untouched, as rewrap promises.
    expect(body.tools.map((tool) => tool.input_schema)).toEqual([{ type: "object" }, { type: "object" }]);
  });
});
