import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { expandGlob, isGlob, segmentRegex } from "../src/glob.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "schemafit-glob-"));
  const files = [
    "a.json",
    "b.json",
    "c.yaml",
    ".hidden.json",
    "nested/d.json",
    "nested/deeper/e.json",
    "nested/deeper/f.yml",
    ".git/g.json",
    "tool1.json",
    "tool2.json",
    "tool10.json",
  ];
  for (const file of files) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), "{}");
  }
  await mkdir(join(root, "dir.json"));
});

const under = (matches: string[]): string[] => matches.map((match) => match.slice(root.length + 1));

describe("isGlob", () => {
  it("tells a pattern from a path", () => {
    expect(isGlob("schemas/*.json")).toBe(true);
    expect(isGlob("schemas/tool?.json")).toBe(true);
    expect(isGlob("schemas/tool[12].json")).toBe(true);
    expect(isGlob("schemas/**/x.json")).toBe(true);
    expect(isGlob("schemas/tool.json")).toBe(false);
    expect(isGlob("schemas/tool[1.json")).toBe(false);
    expect(isGlob("-")).toBe(false);
  });

  it("reads an escaped wildcard as a literal character, except on Windows", () => {
    expect(isGlob("schemas/\\*.json", { windows: false })).toBe(false);
    expect(isGlob("schemas\\*.json", { windows: true })).toBe(true);
  });
});

describe("segmentRegex", () => {
  it("matches one name of a directory", () => {
    expect(segmentRegex("*.json", false).test("a.json")).toBe(true);
    expect(segmentRegex("*.json", false).test("a.yaml")).toBe(false);
    expect(segmentRegex("tool?.json", false).test("tool1.json")).toBe(true);
    expect(segmentRegex("tool?.json", false).test("tool10.json")).toBe(false);
    expect(segmentRegex("tool[!1].json", false).test("tool2.json")).toBe(true);
    expect(segmentRegex("tool[!1].json", false).test("tool1.json")).toBe(false);
    expect(segmentRegex("[a-b].json", false).test("b.json")).toBe(true);
  });

  it("ignores case on Windows only", () => {
    expect(segmentRegex("*.JSON", true).test("a.json")).toBe(true);
    expect(segmentRegex("*.JSON", false).test("a.json")).toBe(false);
  });
});

describe("expandGlob", () => {
  it("expands a star within one directory, sorted, without the directories it also matches", async () => {
    expect(under(await expandGlob(`${root}/*.json`, { windows: false }))).toEqual([
      "a.json",
      "b.json",
      "tool1.json",
      "tool10.json",
      "tool2.json",
    ]);
  });

  it("leaves names that start with a dot to a pattern that starts with one", async () => {
    expect(under(await expandGlob(`${root}/.*.json`, { windows: false }))).toEqual([".hidden.json"]);
  });

  it("matches one character with ? and a set with brackets", async () => {
    expect(under(await expandGlob(`${root}/tool?.json`, { windows: false }))).toEqual(["tool1.json", "tool2.json"]);
    expect(under(await expandGlob(`${root}/[ab].json`, { windows: false }))).toEqual(["a.json", "b.json"]);
  });

  it("expands ** to any number of directories, including none, and skips hidden ones", async () => {
    expect(under(await expandGlob(`${root}/**/*.json`, { windows: false }))).toEqual([
      "a.json",
      "b.json",
      "nested/d.json",
      "nested/deeper/e.json",
      "tool1.json",
      "tool10.json",
      "tool2.json",
    ]);
    expect(under(await expandGlob(`${root}/nested/**`, { windows: false }))).toEqual([
      "nested/d.json",
      "nested/deeper/e.json",
      "nested/deeper/f.yml",
    ]);
  });

  it("puts a wildcard in a directory name as well as in the file name", async () => {
    expect(under(await expandGlob(`${root}/n*/*/*.y*`, { windows: false }))).toEqual(["nested/deeper/f.yml"]);
  });

  // Creating a symbolic link takes a privilege a Windows account does not have by default.
  it.skipIf(process.platform === "win32")("follows a symbolic link to a file or a directory, but not through **", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schemafit-glob-link-"));
    await writeFile(join(dir, "real.json"), "{}");
    await symlink(join(dir, "real.json"), join(dir, "link.json"));
    await symlink(root, join(dir, "loop"));
    const matches = (await expandGlob(`${dir}/**/*.json`, { windows: false })).map((m) => m.slice(dir.length + 1));
    expect(matches).toEqual(["link.json", "real.json"]);
    const through = (await expandGlob(`${dir}/lo*/a.json`, { windows: false })).map((m) => m.slice(dir.length + 1));
    expect(through).toEqual(["loop/a.json"]);
  });

  it("returns nothing for a pattern that matches no file, and a path as it is", async () => {
    expect(await expandGlob(`${root}/*.toml`, { windows: false })).toEqual([]);
    expect(await expandGlob(`${root}/missing/*.json`, { windows: false })).toEqual([]);
    expect(await expandGlob(`${root}/missing.json`, { windows: false })).toEqual([`${root}/missing.json`]);
  });

  // A path with backslashes in it names a different file on any other system.
  it.runIf(process.platform === "win32")("reads backslashes as separators on Windows, and keeps them in the matches", async () => {
    const pattern = `${root}\\nested\\*.JSON`;
    expect(under(await expandGlob(pattern, { windows: true }))).toEqual(["nested\\d.json"]);
    expect(under(await expandGlob(`${root}\\**\\f.yml`, { windows: true }))).toEqual(["nested\\deeper\\f.yml"]);
  });

  it("keeps the text in front of the first wildcard as it was written", async () => {
    expect(await expandGlob(`${root}//nested/*.json`, { windows: false })).toEqual([`${root}//nested/d.json`]);
  });
});
