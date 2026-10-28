import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringifyYaml } from "../src/yaml-write.js";
import { parseYaml, readYaml } from "../src/yaml.js";

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

  it("writes the comments of a file back where they were", () => {
    const text = `# The schema.
type: object # always
properties: # the fields
  # one field
  tags:
    type: array
    items: [string] # strings
required: [tags]
# The end.
`;
    const { value, attached } = readYaml(text);
    expect(stringifyYaml(value, attached)).toBe(text);
  });

  it("puts a comment after the first line of its entry, and one above the first key of a sequence item above the dash", () => {
    const value = { items: [{ name: "a", schema: { type: "object" } }], description: "one\ntwo" };
    const comments = [
      { line: 1, text: "# above the item", pointer: "/items/0", trailing: false },
      { line: 2, text: "# above its first key", pointer: "/items/0/name", trailing: false },
      { line: 3, text: "# after the dash", pointer: "/items/0", trailing: true },
      { line: 4, text: "# after a key with a block below", pointer: "/items/0/schema", trailing: true },
      { line: 5, text: "# after a block scalar's header", pointer: "/description", trailing: true },
    ];
    expect(stringifyYaml(value, comments)).toBe(`items:
  # above the item
  # above its first key
  - name: a # after the dash
    schema: # after a key with a block below
      type: object
description: |- # after a block scalar's header
  one
  two
`);
  });

  it("keeps a list of scalars in block style when one of its items has a comment", () => {
    const text = "enum:\n  - open # first\n  # the last\n  - closed\ntype: [string, \"null\"]\n";
    const { value, attached } = readYaml(text);
    expect(stringifyYaml(value, attached)).toBe(text);
  });

  it("keeps the empty lines between entries, in their place among the comments above an entry", () => {
    const text = `# The tools.

- name: search
  description: |
    Finds things.

  input_schema:
    type: object

# The second tool.
- name: fetch

  # its schema

  input_schema:
    type: object

# The end.
`;
    const { value, attached, blanks } = readYaml(text);
    expect(stringifyYaml(value, attached, blanks)).toBe(text);
  });

  it("keeps a list of scalars in block style when an empty line separates two of its items", () => {
    const text = "enum:\n  - open\n\n  - closed\n";
    const { value, attached, blanks } = readYaml(text);
    expect(stringifyYaml(value, attached, blanks)).toBe(text);
  });

  it("leaves out the empty lines with no entry below them, and refuses one on an entry the value does not hold", () => {
    expect(stringifyYaml({ a: 1 }, [], [{ line: 2, pointer: null }])).toBe("a: 1\n");
    expect(() => stringifyYaml({ a: 1 }, [], [{ line: 1, pointer: "/b" }])).toThrow(
      "1 of the empty lines belong to an entry the value does not hold",
    );
  });

  it("reads every YAML example back with its comments and its empty lines", async () => {
    for (const name of ["agent-tools.yaml"]) {
      const { value, attached, blanks } = readYaml(await readFile(example(name), "utf8"));
      const written = readYaml(stringifyYaml(value, attached, blanks));
      expect(written.blanks.map(({ pointer }) => pointer)).toEqual(blanks.map(({ pointer }) => pointer));
      expect(written.value).toEqual(value);
      expect(written.attached.map(({ text, pointer }) => [text, pointer])).toEqual(attached.map(({ text, pointer }) => [text, pointer]));
    }
  });

  it("refuses a comment on an entry the value does not hold, or one that is not a comment", () => {
    expect(() => stringifyYaml({ a: 1 }, [{ line: 1, text: "# gone", pointer: "/b", trailing: false }])).toThrow(
      "1 of the comments belong to an entry the value does not hold",
    );
    expect(() => stringifyYaml({ a: 1 }, [{ line: 4, text: "not one", pointer: "/a", trailing: true }])).toThrow(
      'the comment of line 4 is not one line starting with "#"',
    );
  });
});
