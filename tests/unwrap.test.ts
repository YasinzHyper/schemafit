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
    expect(unwrapAll(SCHEMA)).toEqual([{ schema: SCHEMA, wrapper: null, keys: [], kind: null, pointer: "" }]);
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

  it("finds the JSON output schema of an Anthropic request, and the deprecated spelling", () => {
    const body = {
      model: "claude-opus-5-5",
      messages: [],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    };
    expect(found(body)).toEqual(["/output_config/format/schema output format (schema) -"]);
    expect(found({ messages: [], output_format: { type: "json_schema", schema: SCHEMA } })).toEqual([
      "/output_format/schema output format (schema) -",
    ]);
  });

  it("reports what each declaration says about strict decoding", () => {
    const body = {
      tools: [
        { name: "a", input_schema: SCHEMA, strict: true },
        { name: "b", input_schema: SCHEMA, strict: false },
        { name: "c", input_schema: SCHEMA },
        { type: "function", function: { name: "d", strict: true, parameters: SCHEMA } },
      ],
      response_format: { type: "json_schema", json_schema: { name: "e", strict: true, schema: SCHEMA } },
    };
    expect(unwrapAll(body).map(({ name, strict }) => `${name} ${strict}`)).toEqual([
      "a true",
      "b false",
      "c undefined",
      "d true",
      "e true",
    ]);
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

  it("finds every tool of an MCP tools/list response", () => {
    const response = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get_weather", inputSchema: SCHEMA }] } };
    expect(found(response)).toEqual(["/result/tools/0/inputSchema MCP tool (inputSchema) get_weather"]);
    expect(unwrapAll(response)[0]?.schema).toEqual(SCHEMA);

    // Paginated, and alongside a tool that declares no schema of its own.
    const page = {
      jsonrpc: "2.0",
      id: "req-7",
      result: {
        tools: [{ name: "ping" }, { name: "search", title: "Search", inputSchema: SCHEMA }],
        nextCursor: "next-page-cursor",
      },
    };
    expect(found(page)).toEqual(["/result/tools/1/inputSchema MCP tool (inputSchema) search"]);
  });

  it("finds no schema in a JSON-RPC message that declares none", () => {
    // An error response, a request, and a notification: none of them carries a tool definition,
    // and the envelope itself is not a schema to be linted.
    expect(found({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } })).toEqual([]);
    expect(found({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "c" } })).toEqual([]);
    expect(found({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toEqual([]);
    // A result of some other method, which is a payload rather than a schema.
    expect(found({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "72°F" }], isError: false } })).toEqual([]);
  });

  it("rewraps a schema found inside a JSON-RPC envelope, leaving the envelope whole", () => {
    const response = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "f", inputSchema: { type: "object" } }] } };
    const [entry] = unwrapAll(response);
    expect(rewrap(response, entry?.keys ?? [], { type: "object", title: "fixed" })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "f", inputSchema: { type: "object", title: "fixed" } }] },
    });
  });

  it("leaves a schema that describes a JSON-RPC message alone", () => {
    // "jsonrpc" here is a property of the schema; only the version string marks an envelope.
    const schema = { type: "object", properties: { jsonrpc: { const: "2.0" }, result: { type: "object" } } };
    expect(found(schema)).toEqual(["# null -"]);
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
