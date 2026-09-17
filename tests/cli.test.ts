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

  it("prints help and version", async () => {
    expect((await cli(["--help"])).stdout).toContain("Usage");
    expect((await cli(["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+/);
    expect((await cli([])).code).toBe(2);
  });
});
