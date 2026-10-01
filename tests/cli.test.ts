import { mkdtemp, readFile } from "node:fs/promises";
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
