import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringifyYaml } from "../src/yaml-write.js";
import { parseYaml } from "../src/yaml.js";

const example = (name: string): string => fileURLToPath(new URL(`../examples/${name}`, import.meta.url));

describe("stringifyYaml", () => {
  it("writes a schema as block mappings, with short lists of scalars in flow style", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string", description: "One line, in the customer's words." },
        assignee: { type: ["string", "null"] },
        tags: { type: "array", items: { enum: ["bug", "feature"] } },
        meta: { type: "object", properties: {}, additionalProperties: false },
      },
      required: ["title", "assignee", "tags", "meta"],
      additionalProperties: false,
    };
    expect(stringifyYaml(schema)).toBe(`type: object
properties:
  title:
    type: string
    description: One line, in the customer's words.
  assignee:
    type: [string, "null"]
  tags:
    type: array
    items:
      enum: [bug, feature]
  meta:
    type: object
    properties: {}
    additionalProperties: false
required: [title, assignee, tags, meta]
additionalProperties: false
`);
  });

  it("starts a collection in a sequence item on the dash's line", () => {
    const value = [{ name: "a", input_schema: { type: "object" } }, [1, [2]], [{ x: 1 }]];
    expect(stringifyYaml(value)).toBe(`- name: a
  input_schema:
    type: object
- - 1
  - [2]
- - x: 1
`);
  });

  it("writes a string over several lines as a literal block scalar", () => {
    expect(stringifyYaml({ a: "one\ntwo\n", b: "one\n\n  indented # not a comment\nlast" })).toBe(`a: |
  one
  two
b: |-
  one

    indented # not a comment
  last
`);
  });

  it.each([
    ["a string YAML would resolve to something else", ["null", "true", "Yes", "off", "~", "12", "1.5", "0x1F", ".inf"]],
    ["a string that starts with an indicator", ["#/$defs/Item", "- item", "*bold*", "&x", "!tag", "|", ">", "'q'", '"q"', "[x]", "{x}"]],
    ["a string a colon or a hash would cut short", ["a: b", "trailing:", "a #b"]],
    ["a string with white space at either end, or empty", [" x", "x ", ""]],
  ])("quotes %s", (_, strings) => {
    for (const text of strings) {
      expect(stringifyYaml({ k: text })).toBe(`k: ${JSON.stringify(text)}\n`);
    }
  });

  it("quotes a key that would not read back as itself", () => {
    expect(stringifyYaml({ "": 1, "-": 2, "a: b": 3, $ref: "#/x", "a b": 4 })).toBe(
      `"": 1\n"-": 2\n"a: b": 3\n$ref: "#/x"\na b: 4\n`,
    );
  });

  it("quotes a list item that holds a comma or a bracket in flow style", () => {
    expect(stringifyYaml({ enum: ["a, b", "c]", "d"] })).toBe(`enum: ["a, b", "c]", d]\n`);
  });

  it("escapes what YAML would not print, and keeps a string a block scalar cannot hold quoted", () => {
    const value = { a: "x\u2028y", b: "\ud800", c: "tab\there\x07", d: "  lead\nx", e: "end\n\n", f: "\u00e9 \u{1F600}" };
    expect(stringifyYaml(value)).toBe(
      'a: "x\\u2028y"\nb: "\\ud800"\nc: "tab\\there\\u0007"\nd: "  lead\\nx"\ne: "end\\n\\n"\nf: \u00e9 \u{1F600}\n',
    );
  });

  it("breaks a list of scalars onto lines when it would not fit on one", () => {
    const items = Array.from({ length: 12 }, (_, i) => `value_${i}`);
    expect(stringifyYaml({ enum: items }).split("\n")).toHaveLength(items.length + 2);
  });

  it.each([
    ["an object", { a: { b: [1, -1.5e-7, true, null, "s", [], {}] } }],
    ["a scalar document", "x\ny"],
    ["an empty list", []],
    ["a number", 3],
  ])("writes %s that reads back as itself", (_, value) => {
    expect(parseYaml(stringifyYaml(value))).toEqual(value);
  });

  it("reads every YAML example back as the value it was written from", async () => {
    for (const name of ["agent-tools.yaml"]) {
      const value = parseYaml(await readFile(example(name), "utf8"));
      expect(parseYaml(stringifyYaml(value))).toEqual(value);
    }
  });

  it("refuses a value JSON cannot hold", () => {
    expect(() => stringifyYaml(undefined)).toThrow(TypeError);
  });
});
