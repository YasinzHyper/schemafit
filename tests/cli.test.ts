import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const example = (name: string): string => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

async function cli(args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    readStdin: async () => stdin,
    color: false,
  });
  return { code, stdout, stderr };
}

describe("cli", () => {
  it("exits 0 for a portable schema", async () => {
    const { code, stdout } = await cli([example("ticket.portable.json")]);
    expect(code).toBe(0);
    expect(stdout.match(/✔ compatible/g)).toHaveLength(3);
  });

  it("exits 1 and explains each finding", async () => {
    const { code, stdout } = await cli([example("ticket.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("#/properties/reporter");
    expect(stdout).toContain("openai/all-required");
    expect(stdout).toContain("fix:");
  });

  it("limits the check to the selected providers", async () => {
    const { code, stdout } = await cli(["-p", "gemini", example("ticket.json")]);
    expect(code).toBe(0);
    expect(stdout).toContain("Gemini");
    expect(stdout).not.toContain("OpenAI");
  });

  it("accepts comma-separated and repeated providers", async () => {
    const { stdout } = await cli(["-p", "openai,gemini", "-p", "anthropic", "-f", "json", example("ticket.portable.json")]);
    const providers = JSON.parse(stdout).files[0].summary.map((entry: { provider: string }) => entry.provider);
    expect(providers).toEqual(["openai", "gemini", "anthropic"]);
  });

  it("unwraps tool definitions and says so", async () => {
    const { code, stdout } = await cli([example("anthropic-tool.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("Anthropic tool (input_schema)");
    expect(stdout).toContain("anthropic/no-numeric-constraints");
  });

  it("reports every tool of a request body on its own", async () => {
    const { code, stdout } = await cli([example("messages-request.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("messages-request.json#/tools/1/input_schema  create_ticket");
    expect(stdout).toContain("messages-request.json#/tools/2/input_schema  search_tickets");
    // The server tool in the same array declares no schema, so it is not reported at all.
    expect(stdout).not.toContain("web_search");
    expect(stdout).toContain("openai/all-required");
  });

  it("leaves a tool the request does not send strictly out of the report", async () => {
    const { code, stdout, stderr } = await cli([example("chat-request.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("chat-request.json#/tools/0/function/parameters  create_ticket");
    expect(stdout).not.toContain("log_event");
    expect(stderr).toContain('skipped log_event — "strict": false');
    expect(stderr).toContain("--all-tools");
  });

  it("--all-tools reports the non-strict tool too", async () => {
    const { code, stdout, stderr } = await cli(["--all-tools", example("chat-request.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("chat-request.json#/tools/1/function/parameters  log_event");
    expect(stdout).toContain("openai/undocumented-keyword");
    expect(stderr).not.toContain("skipped");
  });

  it("checks a tool that says nothing about strict, which the Responses API may normalize", async () => {
    // Every tool of messages-request.json omits "strict"; omitting it is not opting out.
    const { stdout, stderr } = await cli(["-f", "json", example("messages-request.json")]);
    expect((JSON.parse(stdout).files as unknown[]).length).toBeGreaterThan(1);
    expect(stderr).not.toContain("skipped");
  });

  it("says so and exits 0 when every schema of a document opts out of strictness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const body = join(dir, "request.json");
    const tool = { name: "log_event", strict: false, input_schema: { type: "object", properties: {} } };
    await writeFile(body, JSON.stringify({ model: "claude-opus-5-5", messages: [], tools: [tool, tool] }));

    const { code, stdout, stderr } = await cli([body]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("skipped every schema it declares");

    const { code: all, stdout: reported } = await cli(["--all-tools", body]);
    expect(all).toBe(1);
    expect(reported).toContain("anthropic/additional-properties-false");
  });

  it("--fix leaves a non-strict tool's constraints alone, and --all-tools rewrites them", async () => {
    const { code, stdout, stderr } = await cli(["--fix", "-p", "anthropic", example("chat-request.json")]);
    expect(code).toBe(0);
    const tools = (JSON.parse(stdout) as { tools: { function: { parameters: Record<string, unknown> } }[] }).tools;
    // The audit log's message keeps the length Anthropic's strict subset would have dropped.
    expect(tools[1]?.function.parameters.properties).toMatchObject({ message: { minLength: 1, maxLength: 200 } });
    expect(tools[0]?.function.parameters).toMatchObject({ additionalProperties: false });
    expect(stderr).toContain('skipped log_event — "strict": false');

    const { stdout: all } = await cli(["--fix", "--all-tools", "-p", "anthropic", example("chat-request.json")]);
    const rewritten = (JSON.parse(all) as { tools: { function: { parameters: { properties: Record<string, Record<string, unknown>> } } }[] }).tools;
    expect(rewritten[1]?.function.parameters.properties.message).not.toHaveProperty("minLength");
    expect(rewritten[1]?.function.parameters.properties.message?.description).toContain("at least 1");
  });

  it("names each schema of a request body in the JSON output", async () => {
    const { stdout } = await cli(["-f", "json", example("messages-request.json")]);
    const files = JSON.parse(stdout).files as { file: string; pointer: string; name: string }[];
    expect(files.map(({ pointer, name }) => `${pointer} ${name}`)).toEqual([
      "/tools/1/input_schema create_ticket",
      "/tools/2/input_schema search_tickets",
    ]);
    expect(new Set(files.map(({ file }) => file)).size).toBe(1);
  });

  it("names a document that holds a single schema by its file alone", async () => {
    // The pointer is only what tells several reports on one file apart, so a file holding one
    // schema is reported exactly as it was before a document could hold several: no pointer,
    // whether the schema sat in a wrapper or not. Only the tool's name is new beside it.
    const { stdout } = await cli([example("anthropic-tool.json")]);
    expect(stdout).toContain("anthropic-tool.json  get_weather  (Anthropic tool (input_schema))");
    expect(stdout).not.toContain("anthropic-tool.json#");

    const { stdout: json } = await cli(["-f", "json", example("anthropic-tool.json")]);
    const [file] = JSON.parse(json).files as { name: string; pointer?: string }[];
    expect(file?.name).toBe("get_weather");
    expect(file).not.toHaveProperty("pointer");
  });

  it("--fix rewrites every tool of a request body and leaves the rest of the body alone", async () => {
    const { code, stdout, stderr } = await cli(["--fix", example("messages-request.json")]);
    expect(code).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.messages).toHaveLength(1);
    expect(body.tools[0]).toEqual({ type: "web_search_20260209", name: "web_search" });
    expect(body.tools[1].input_schema).toMatchObject({
      additionalProperties: false,
      required: ["title", "category", "assignee"],
      properties: { assignee: { type: ["string", "null"], description: expect.any(String) } },
    });
    // One report per schema, the untouched one included.
    expect(stderr.match(/create_ticket|search_tickets/g)).toEqual(["create_ticket", "search_tickets"]);
    expect(stderr).toContain("Nothing to fix");
  });

  it("lints and fixes the schema of a Gemini request that lists its response formats", async () => {
    const body = JSON.stringify({
      model: "gemini-3.8-flash",
      input: "Extract the ticket.",
      response_format: [
        {
          type: "text",
          mime_type: "application/json",
          schema: { type: "object", properties: { id: { type: "string", pattern: "^T-" } } },
        },
      ],
    });
    const lint = await cli(["-p", "gemini", "-"], body);
    expect(lint.stdout).toContain("<stdin>  (output format (schema))");
    expect(lint.stdout).toContain('"pattern" is outside the documented subset');

    const { stdout } = await cli(["--fix", "-p", "openai", "-"], body);
    const fixed = JSON.parse(stdout);
    expect(fixed.model).toBe("gemini-3.8-flash");
    expect(fixed.response_format).toHaveLength(1);
    expect(fixed.response_format[0]).toMatchObject({ type: "text", mime_type: "application/json" });
    expect(fixed.response_format[0].schema).toMatchObject({ additionalProperties: false, required: ["id"] });
  });

  it("reports every tool of a captured MCP tools/list response", async () => {
    const { code, stdout } = await cli([example("mcp-tools-list.json")]);
    expect(code).toBe(1);
    expect(stdout).toContain("mcp-tools-list.json#/result/tools/0/inputSchema  create_note");
    expect(stdout).toContain("mcp-tools-list.json#/result/tools/1/inputSchema  search_notes");
    expect(stdout).toContain("MCP tool (inputSchema)");
    expect(stdout).toContain("anthropic/no-numeric-constraints");
  });

  it("--fix rewrites a captured MCP response and leaves the envelope whole", async () => {
    const response = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { tools: [{ name: "f", inputSchema: { type: "object", properties: {} } }], nextCursor: "c" },
    });
    const { stdout } = await cli(["--fix", "-p", "anthropic", "-"], response);
    expect(JSON.parse(stdout)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        tools: [{ name: "f", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        nextCursor: "c",
      },
    });
  });

  it("reports every tool of every response in a captured JSON-RPC batch", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "create_note", inputSchema: { type: "object", properties: { title: { type: "string", maxLength: 120 } }, required: ["title"] } }] } },
      { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_notes", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } },
    ]);
    const { code, stdout } = await cli(["-p", "anthropic", "-"], batch);
    expect(code).toBe(1);
    expect(stdout).toContain("<stdin>#/0/result/tools/0/inputSchema  create_note");
    expect(stdout).toContain("<stdin>#/1/result/tools/0/inputSchema  search_notes");
    expect(stdout).toContain("MCP tool (inputSchema)");
    // The envelopes themselves are never linted: a message is not a schema that is missing
    // "additionalProperties", and before batches were read as batches both were reported as one.
    expect(stdout).not.toContain("#/0  ");
    expect(stdout).not.toContain("#/1  ");
  });

  it("--fix rewrites every response of a batch and leaves the batch whole", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "f", inputSchema: { type: "object", properties: {} } }] } },
    ]);
    const { stdout } = await cli(["--fix", "-p", "anthropic", "-"], batch);
    expect(JSON.parse(stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
      {
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "f", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] },
      },
    ]);
  });

  it("names each message of a JSON-RPC batch that declares no schema", async () => {
    const batch = JSON.stringify([
      { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } },
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    ]);
    const { code, stderr } = await cli(["-"], batch);
    expect(code).toBe(2);
    expect(stderr).toContain("<stdin> is a JSON-RPC batch of 2 messages, none of which declares a schema");
    expect(stderr).toContain('an error response (error -32601: "Method not found")');
    expect(stderr).toContain('a notification of "notifications/tools/list_changed"');
    expect(stderr).not.toContain("holds no schema to check");
  });

  it("counts the messages of a long batch it does not name one by one", async () => {
    const batch = JSON.stringify(
      Array.from({ length: 6 }, (_unused, index) => ({ jsonrpc: "2.0", id: index, method: "tools/call" })),
    );
    const { code, stderr } = await cli(["-"], batch);
    expect(code).toBe(2);
    expect(stderr).toContain("is a JSON-RPC batch of 6 messages");
    expect(stderr).toContain("and 3 more");
  });

  it("names the failure of a JSON-RPC error response, rather than linting the envelope", async () => {
    const error = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } });
    const { code, stderr } = await cli(["-"], error);
    expect(code).toBe(2);
    expect(stderr).toContain("<stdin> is a JSON-RPC error response");
    expect(stderr).toContain('error -32601: "Method not found"');
    expect(stderr).not.toContain("holds no schema to check");
  });

  it("names the method a JSON-RPC request or notification calls", async () => {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const call = await cli(["-"], request);
    expect(call.code).toBe(2);
    expect(call.stderr).toContain('<stdin> is a JSON-RPC request for "tools/list"');

    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const notified = await cli(["-"], notification);
    expect(notified.code).toBe(2);
    expect(notified.stderr).toContain('is a JSON-RPC notification of "notifications/tools/list_changed"');
  });

  it("says a JSON-RPC result declares no schema when it is some other method's payload", async () => {
    const result = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "72F" }] } });
    const { code, stderr } = await cli(["-"], result);
    expect(code).toBe(2);
    expect(stderr).toContain("its result declares no schema");
    expect(stderr).toContain('"inputSchema"');
  });

  it("names a JSON-RPC message under --fix too, which reads the same documents", async () => {
    const error = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } });
    const { code, stderr } = await cli(["--fix", "-"], error);
    expect(code).toBe(2);
    expect(stderr).toContain('error -32602: "Invalid params"');
  });

  it("exits 2 when a document holds no schema at all", async () => {
    const body = JSON.stringify({ tools: [{ type: "web_search_20260209", name: "web_search" }] });
    const { code, stderr } = await cli(["-"], body);
    expect(code).toBe(2);
    expect(stderr).toContain("holds no schema to check");
  });

  it("names the schema a document holds several of when one is not an object", async () => {
    const { code, stderr } = await cli(["-"], JSON.stringify({ tools: [{ name: "f", input_schema: true }] }));
    expect(code).toBe(2);
    expect(stderr).toContain("<stdin> at #/tools/0/input_schema: Schema must be a JSON object.");
  });

  it("reads a schema from stdin", async () => {
    const { code, stdout } = await cli(["-", "--format", "json"], '{"type":"array"}');
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.files[0].file).toBe("<stdin>");
    expect(report.files[0].findings[0].ruleId).toBe("openai/root-object");
  });

  it("--quiet hides warnings", async () => {
    const { stdout } = await cli(["--quiet", "-p", "gemini", example("ticket.json")]);
    expect(stdout).not.toContain("warn");
    expect(stdout).toContain("✔ compatible");
  });

  it("--max-warnings turns warnings into a failure", async () => {
    const { code, stderr } = await cli(["--max-warnings", "0", "-p", "gemini", example("ticket.json")]);
    expect(code).toBe(1);
    expect(stderr).toContain("--max-warnings");
  });

  it("lists rules", async () => {
    const { code, stdout } = await cli(["rules", "-p", "anthropic"]);
    expect(code).toBe(0);
    expect(stdout).toContain("anthropic/no-recursive-schemas");
    expect(stdout).not.toContain("openai/");
    expect(stdout).toMatch(/anthropic\/optional-parameters-limit.*\[request\]/);
  });

  it("reports the limits a request body exceeds together, not tool by tool", async () => {
    // Four tools of seven optional parameters each: the docs' own case for the request-wide
    // limit, where no single tool looks complex and the request is over it anyway.
    const tool = (index: number): unknown => ({
      name: `tool_${index}`,
      strict: true,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`p${i}`, { type: "string" }])),
        required: [],
        additionalProperties: false,
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const body = join(dir, "request.json");
    await writeFile(body, JSON.stringify({ model: "claude-opus-5-5", messages: [], tools: [0, 1, 2, 3].map(tool) }));

    const { code, stdout } = await cli(["-p", "anthropic", body]);
    expect(code).toBe(1);
    // Every tool on its own fits; the request does not.
    expect(stdout.match(/✔ compatible/g)).toHaveLength(4);
    expect(stdout).toContain("request.json  (the request as a whole)");
    expect(stdout).toContain("anthropic/optional-parameters-limit");
    expect(stdout).toContain("28 optional parameters");

    const json = JSON.parse((await cli(["-p", "anthropic", "-f", "json", body])).stdout);
    expect(json.files.at(-1)).toMatchObject({ scope: "request", summary: [{ provider: "anthropic", errors: 1 }] });
  });

  it("reports a single schema's own limits in its own block", async () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: "string" }])),
      required: [],
      additionalProperties: false,
    };
    const { code, stdout } = await cli(["-p", "anthropic", "-"], JSON.stringify(schema));
    expect(code).toBe(1);
    expect(stdout).toContain("anthropic/optional-parameters-limit");
    expect(stdout).toContain("The schema has 25 optional parameters");
    expect(stdout).not.toContain("the request as a whole");
  });

  it.each([
    [["--provider", "llama", "x.json"], "Unknown provider"],
    [["--format", "xml", "x.json"], "Unknown format"],
    [["--nope"], "--nope"],
    [["does-not-exist.json"], "Cannot read"],
    [["--max-warnings", "many", "x.json"], "non-negative integer"],
  ])("exits 2 on bad usage: %j", async (args, message) => {
    const { code, stderr } = await cli(args);
    expect(code).toBe(2);
    expect(stderr).toContain(message);
  });

  it("exits 2 on invalid JSON and on non-object schemas", async () => {
    expect((await cli(["-"], "{nope")).code).toBe(2);
    expect((await cli(["-"], "true")).code).toBe(2);
  });

  it("--fix writes the rewritten schema to stdout and the changes to stderr", async () => {
    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "-"], '{"type":"object","properties":{}}');
    expect(JSON.parse(stdout)).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(stderr).toContain("openai/additional-properties-false");
    expect(stderr).toContain('Set "additionalProperties": false.');
    expect(code).toBe(0);
  });

  it("--fix keeps the wrapper the schema came in", async () => {
    const tool = JSON.stringify({ name: "f", input_schema: { type: "object", properties: {} } });
    const { stdout } = await cli(["--fix", "-p", "anthropic", "-"], tool);
    expect(JSON.parse(stdout)).toEqual({
      name: "f",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  it("--fix exits 1 and lists what it could not fix", async () => {
    const schema = '{"type":"object","properties":{"a":{"allOf":[{"type":"string"},{"type":"number"}]}},"required":["a"]}';
    const { code, stderr } = await cli(["--fix", "-p", "openai", "-"], schema);
    expect(code).toBe(1);
    expect(stderr).toContain("openai/unsupported-composition");
    expect(stderr).toContain("No automatic rewrite");
  });

  it("--fix rewrites oneOf to anyOf", async () => {
    const schema = '{"type":"object","properties":{"a":{"oneOf":[{"type":"string"}]}},"required":["a"]}';
    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "-"], schema);
    expect(JSON.parse(stdout).properties.a).toEqual({ anyOf: [{ type: "string" }] });
    expect(stderr).toContain("openai/no-one-of");
    expect(code).toBe(0);
  });

  it("--fix requires the optional properties and makes them nullable", async () => {
    const schema = '{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":false}';
    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "-"], schema);
    expect(JSON.parse(stdout)).toEqual({
      type: "object",
      properties: { a: { type: ["string", "null"] } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(stderr).toContain("openai/all-required");
    expect(code).toBe(0);
  });

  it("--fix --out writes to a file", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "schemafit-")), "fixed.json");
    const { code, stdout } = await cli(["--fix", "-p", "openai", "--out", out, "-"], '{"type":"object","properties":{}}');
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(JSON.parse(await readFile(out, "utf8"))).toMatchObject({ additionalProperties: false });
  });

  it("--fix --write rewrites each file in place and leaves the ones no fix touched alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const loose = join(dir, "loose.json");
    const fitting = join(dir, "fitting.json");
    // Written with its own formatting, so an untouched file is recognisable byte for byte.
    const original = '{\n    "type": "object",\n    "properties": {},\n    "additionalProperties": false\n}';
    await writeFile(loose, '{"type":"object","properties":{}}');
    await writeFile(fitting, original);

    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "--write", loose, fitting]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(JSON.parse(await readFile(loose, "utf8"))).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(await readFile(fitting, "utf8")).toBe(original);
    expect(stderr).toContain("openai/additional-properties-false");
    expect(stderr).toContain("Nothing to fix");
    expect(stderr).toContain("rewrote 1 of 2 files");
  });

  it("--fix --write rewrites a request body in place and counts it once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const body = join(dir, "request.json");
    await writeFile(body, await readFile(example("messages-request.json"), "utf8"));

    const { code, stderr } = await cli(["--fix", "--write", body]);
    expect(code).toBe(0);
    const fixed = JSON.parse(await readFile(body, "utf8"));
    expect(fixed.tools[1].input_schema.additionalProperties).toBe(false);
    expect(fixed.tools[2].input_schema).toEqual(JSON.parse(await readFile(example("messages-request.json"), "utf8")).tools[2].input_schema);
    // One file, two reports: the count is of files, not of schemas.
    expect(stderr).not.toContain("rewrote");

    // A second run has nothing left to change, so the file is not written again.
    const again = await cli(["--fix", "--write", body]);
    expect(again.stderr.match(/Nothing to fix/g)).toHaveLength(2);
  });

  it("--fix --write writes nothing when one of the files cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const loose = join(dir, "loose.json");
    const broken = join(dir, "broken.json");
    await writeFile(loose, '{"type":"object","properties":{}}');
    await writeFile(broken, "{nope");

    const { code, stderr } = await cli(["--fix", "-p", "openai", "--write", loose, broken]);
    expect(code).toBe(2);
    expect(stderr).toContain("not valid JSON");
    expect(await readFile(loose, "utf8")).toBe('{"type":"object","properties":{}}');
  });

  it("--fix --prune-unused-defs drops a definition nothing references", async () => {
    const schema = JSON.stringify({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
      $defs: { legacy: { type: "string" } },
    });

    const kept = await cli(["--fix", "-p", "openai", "-"], schema);
    expect(JSON.parse(kept.stdout)).toHaveProperty("$defs");
    expect(kept.stderr).toContain("Nothing to fix");

    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "--prune-unused-defs", "-"], schema);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).not.toHaveProperty("$defs");
    expect(stderr).toContain("--prune-unused-defs");
    expect(stderr).toContain("Remove #/$defs/legacy, which nothing references.");
  });

  it("--fix rewrites for every provider when none is named", async () => {
    const schema = '{"type":"object","properties":{"a":{"type":"string","minLength":3}},"required":["a"]}';
    const { code, stdout, stderr } = await cli(["--fix", "-"], schema);
    expect(JSON.parse(stdout)).toEqual({
      type: "object",
      properties: { a: { type: "string", description: "Must be at least 3 characters long." } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(stderr).toContain("anthropic/no-string-length");
    expect(stderr).toContain("openai/additional-properties-false");
    expect(stderr.match(/✔ compatible/g)).toHaveLength(3);
    expect(code).toBe(0);
  });

  it("--fix keeps a constraint the named provider supports", async () => {
    const schema = '{"type":"object","properties":{"a":{"type":"string","minLength":3}},"required":["a"]}';
    const { stdout } = await cli(["--fix", "-p", "openai", "-"], schema);
    expect(JSON.parse(stdout).properties.a).toEqual({ type: "string", minLength: 3 });
  });

  it("--fix reports every selected provider that is still incompatible", async () => {
    const { code, stderr } = await cli(["--fix", "-p", "openai,anthropic", example("ticket.json")]);
    expect(code).toBe(1);
    expect(stderr).toContain("OpenAI     ✔ compatible");
    expect(stderr).toContain("anthropic/no-recursive-schemas");
    expect(stderr).not.toContain("Gemini");
  });

  it("--fix says nothing to do for a schema that already fits", async () => {
    const { code, stderr } = await cli(["--fix", "-p", "openai", example("ticket.portable.json")]);
    expect(code).toBe(0);
    expect(stderr).toContain("Nothing to fix");
  });

  it("reads a schema written in YAML", async () => {
    const { code, stdout } = await cli([example("agent-tools.yaml")]);
    expect(code).toBe(1);
    expect(stdout).toContain("agent-tools.yaml#/0/input_schema  create_ticket");
    expect(stdout).toContain("agent-tools.yaml#/1/input_schema  search_tickets");
    expect(stdout).toContain("openai/all-required");
    expect(stdout).toContain("anthropic/no-numeric-constraints");
  });

  it("reads YAML from stdin, which has no name to read the format off", async () => {
    const yaml = "type: object\nproperties:\n  title:\n    type: string\nrequired: [title]\n";
    const { code, stdout } = await cli(["-p", "openai", "-"], yaml);
    expect(code).toBe(1);
    expect(stdout).toContain("<stdin>");
    expect(stdout).toContain("openai/additional-properties-false");
  });

  it("rewrites a YAML schema as JSON and says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const out = join(dir, "tools.json");

    const { code, stderr } = await cli(["--fix", example("agent-tools.yaml"), "--out", out]);
    expect(code).toBe(0);
    expect(stderr).toContain("read as YAML, rewritten as JSON");
    expect(stderr).toContain('Remove "minimum" and state it in "description"');

    // The block scalar of the first tool's description survives the round trip as its text,
    // and the comment line that follows it stays a comment rather than joining the scalar.
    // The second tool's folded block keeps the line breaks of its more indented lines and
    // folds the prose around them.
    const tools = JSON.parse(await readFile(out, "utf8")) as Array<{ name: string; description: string }>;
    expect(tools.map(({ name }) => name)).toEqual(["create_ticket", "search_tickets"]);
    expect(tools[0]?.description).toBe(
      "Open a support ticket for the customer.\nCall it once per issue, after the customer has confirmed the summary.\n",
    );
    expect(tools[1]?.description).toBe(
      "Find tickets by text, so the agent can point at an existing one instead of opening a duplicate." +
        " Two words beat one:\n\n  billing refund      good\n  refund              too broad\n\n" +
        'The more indented lines above keep their own line breaks, which is what ">" does with them.',
    );
    expect((await cli([out])).code).toBe(0);
  });

  it("--fix --write rewrites a YAML file in place as YAML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "tool.yaml");
    await writeFile(file, "type: object\nproperties:\n  status:\n    oneOf:\n    - const: open\n    - const: closed\nrequired: [status]\n");

    const { code, stdout, stderr } = await cli(["--fix", "-p", "openai", "--write", file]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("rewritten as JSON");
    expect(await readFile(file, "utf8")).toBe(`type: object
properties:
  status:
    anyOf:
      - const: open
      - const: closed
required: [status]
additionalProperties: false
`);
    expect((await cli(["-p", "openai", file])).code).toBe(0);
  });

  it("--fix --write keeps the comments of a YAML file on the entries they belong to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "tool.yaml");
    await writeFile(
      file,
      `# Kept by hand.
type: object # always an object
properties:
  # What the ticket is about.
  title: {type: string} # one line
  priority:
    type: integer
    description: 1 is a question, 5 is an outage.
required: [title] # priority is optional
`,
    );

    const { code, stderr } = await cli(["--fix", "-p", "openai", "--write", file]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("comment");
    expect(await readFile(file, "utf8")).toBe(`# Kept by hand.
type: object # always an object
properties:
  # What the ticket is about.
  title: # one line
    type: string
  priority:
    type: [integer, "null"]
    description: "1 is a question, 5 is an outage."
required: [title, priority] # priority is optional
additionalProperties: false
`);
  });

  it("--fix --write refuses to drop a comment on an entry the rewrite removes, and leaves a file it would not change alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const loose = join(dir, "loose.yaml");
    const fitting = join(dir, "fitting.yaml");
    const looseText = "# Kept by hand.\ntype: object\nproperties:\n  status:\n    # One of two.\n    oneOf: [{const: open}, {const: closed}]\n";
    const fittingText = "# Already fits.\ntype: object\nproperties: {}\nrequired: []\nadditionalProperties: false\n";
    await writeFile(loose, looseText);
    await writeFile(fitting, fittingText);

    const { code, stderr } = await cli(["--fix", "-p", "openai", "--write", fitting, loose]);
    expect(code).toBe(2);
    expect(stderr).toContain(
      `--write cannot rewrite ${loose} in place: line 5 holds a comment on an entry the rewrite removes or moves, which it would drop.`,
    );
    expect(await readFile(loose, "utf8")).toBe(looseText);

    const alone = await cli(["--fix", "-p", "openai", "--write", fitting]);
    expect(alone.code).toBe(0);
    expect(await readFile(fitting, "utf8")).toBe(fittingText);
  });

  it("--fix --write does not carry a comment into a root the rewrite wrapped, where its pointer names another entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "list.yaml");
    const text = "# A list at the root.\ntype: array # not an object\nitems: {type: string}\n";
    await writeFile(file, text);

    const { code, stderr } = await cli(["--fix", "-p", "openai", "--write", file]);
    expect(code).toBe(2);
    expect(stderr).toContain("lines 1 and 2 hold a comment on an entry the rewrite removes or moves");
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("--fix --out writes YAML to a .yaml file, with the comments of the file it read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const out = join(dir, "tools.fixed.yaml");

    const { code, stderr } = await cli(["--fix", example("agent-tools.yaml"), "--out", out]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("comment");
    expect(stderr).not.toContain("rewritten as JSON");
    const written = await readFile(out, "utf8");
    expect(written).toMatch(/^# The tools the support agent is given, kept in YAML so the descriptions stay readable and\n# reviewable\./);
    expect(written).toContain(
      "    Call it once per issue, after the customer has confirmed the summary.\n  # Generated from the Pydantic model, so edit the model and not this.\n  input_schema:\n",
    );
    expect((await cli([out])).code).toBe(0);

    // A JSON file sent to a .yaml one is written as YAML too.
    const fromJson = join(dir, "ticket.yaml");
    expect((await cli(["--fix", "-p", "openai", example("ticket.json"), "--out", fromJson])).code).toBe(0);
    expect(await readFile(fromJson, "utf8")).toMatch(/^\$schema: https:\/\/json-schema\.org\/draft\/2020-12\/schema\ntitle: SupportTicket\n/);
  });

  it("--fix --out names the comments it could not carry over", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "tool.yaml");
    const out = join(dir, "tool.fixed.yaml");
    await writeFile(file, "type: object\nproperties:\n  status:\n    oneOf: # one of two\n    - const: open\n    - const: closed\n");

    const { code, stderr } = await cli(["--fix", "-p", "openai", file, "--out", out]);
    expect(code).toBe(0);
    expect(stderr).toContain(`tool.yaml: line 4 holds a comment on an entry the rewrite removes or moves, which ${out} does not carry over.`);
    expect(await readFile(out, "utf8")).not.toContain("#");
  });

  it("names the line of a YAML file it cannot read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "tool.yaml");
    await writeFile(file, "type: object\nproperties: &shared\n  title: { type: string }\n");

    const { code, stderr } = await cli([file]);
    expect(code).toBe(2);
    expect(stderr).toContain("is not YAML schemafit can read: line 2: an anchor");
  });

  it("reads the format off the file name, and reports what neither parser could read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
    const file = join(dir, "tool.json");
    await writeFile(file, "type: object\n");

    const { code, stderr } = await cli([file]);
    expect(code).toBe(2);
    expect(stderr).toContain("is not valid JSON");

    const broken = await cli(["-"], "type: object\n  oops: 1\n");
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain("<stdin> is neither valid JSON nor YAML schemafit can read: line 2:");
  });

  it.each([
    [["--fix", "-p", "openai"], "exactly one file"],
    [["--fix", "-p", "openai", "a.json", "b.json"], "exactly one file"],
    [["--fix", "-p", "openai", "rules"], "rules subcommand"],
    [["--out", "x.json", "a.json"], "--out only applies"],
    [["--prune-unused-defs", "a.json"], "--prune-unused-defs only applies"],
    [["--write", "a.json"], "--write only applies"],
    [["--fix", "--write", "--out", "x.json", "a.json"], "cannot be combined"],
    [["--fix", "--write", "-"], "cannot rewrite stdin"],
    [["--fix", "--write"], "at least one file"],
  ])("exits 2 on bad --fix usage: %j", async (args, message) => {
    const { code, stderr } = await cli(args);
    expect(code).toBe(2);
    expect(stderr).toContain(message);
  });

  it("marks the fixable rules in the rule list", async () => {
    const { stdout } = await cli(["rules", "-p", "openai"]);
    expect(stdout).toMatch(/openai\/additional-properties-false.*\[--fix\]/);
    expect(stdout).not.toMatch(/openai\/nesting-depth.*\[--fix\]/);
  });

  it("prints help and version", async () => {
    expect((await cli(["--help"])).stdout).toContain("Usage");
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect((await cli([])).code).toBe(2);
  });
  describe("--openapi", () => {
    const tag = {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    };
    const pet = {
      type: "object",
      properties: { tag: { $ref: "#/components/schemas/Tag" } },
      required: ["tag"],
      additionalProperties: false,
    };

    async function openApiFile(schemas: Record<string, unknown>, name = "openapi.json"): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
      const file = join(dir, name);
      await writeFile(file, JSON.stringify({ openapi: "3.1.1", info: { title: "Pets", version: "1" }, components: { schemas } }));
      return file;
    }

    it("reports every component under its name", async () => {
      const file = await openApiFile({ Tag: tag, Pet: pet });
      const { code, stdout } = await cli(["--openapi", "-p", "anthropic", file]);
      expect(code).toBe(1);
      expect(stdout).toContain(`${file}#/components/schemas/Tag  Tag  (OpenAPI component)`);
      expect(stdout).toContain(
        `${file}#/components/schemas/Pet  Pet  (OpenAPI component, with the components it references under $defs)`,
      );
    });

    it("reports a finding in a shared component once", async () => {
      const file = await openApiFile({ Tag: tag, Pet: pet });
      const { stdout } = await cli(["--openapi", "-p", "anthropic", file]);
      expect(stdout.match(/anthropic\/no-string-length/g)).toHaveLength(1);
      expect(stdout).not.toContain("#/$defs/Tag");
    });

    it("prints one entry per component in JSON", async () => {
      const file = await openApiFile({ Tag: tag, Pet: pet });
      const { stdout } = await cli(["--openapi", "-p", "anthropic", "-f", "json", file]);
      const { files } = JSON.parse(stdout) as { files: Array<{ name: string; pointer: string; findings: unknown[] }> };
      expect(files.map(({ name, pointer, findings }) => [name, pointer, findings.length])).toEqual([
        ["Tag", "/components/schemas/Tag", 1],
        ["Pet", "/components/schemas/Pet", 0],
      ]);
    });

    it("reads an OpenAPI document written in YAML", async () => {
      const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
      const file = join(dir, "openapi.yaml");
      await writeFile(
        file,
        [
          "openapi: 3.1.1",
          "components:",
          "  schemas:",
          "    Tag:",
          "      type: object",
          "      properties:",
          "        name: { type: string }",
          "      required: [name]",
          "      additionalProperties: false",
          "",
        ].join("\n"),
      );
      const { code, stdout } = await cli(["--openapi", file]);
      expect(code).toBe(0);
      expect(stdout).toContain(`${file}#/components/schemas/Tag  Tag`);
    });

    it("names a document that declares no schema components", async () => {
      const dir = await mkdtemp(join(tmpdir(), "schemafit-"));
      const file = join(dir, "openapi.json");
      await writeFile(file, JSON.stringify({ openapi: "3.1.1", paths: {} }));
      const { code, stderr } = await cli(["--openapi", file]);
      expect(code).toBe(2);
      expect(stderr).toContain("declares no schema under components.schemas");
    });

    it("names the component whose definitions cannot take a copy", async () => {
      const file = await openApiFile({ Tag: tag, Pet: { ...pet, $defs: { Tag: { type: "string" } } } });
      const { code, stderr } = await cli(["--openapi", file]);
      expect(code).toBe(2);
      expect(stderr).toContain('Component "Pet": "$defs" already defines "Tag"');
    });

    it("refuses --fix", async () => {
      const file = await openApiFile({ Tag: tag });
      const { code, stderr } = await cli(["--openapi", "--fix", file]);
      expect(code).toBe(2);
      expect(stderr).toContain("--fix does not take --openapi yet");
    });
  });
});
