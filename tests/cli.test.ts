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
});
