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

  it("writes a sequence under a key at the key's indentation when the layout says so", () => {
    const value = {
      anyOf: [{ type: "string" }, { type: "object", required: ["a"], properties: { a: { anyOf: [{ const: 1 }, { const: 2 }] } } }],
      items: [{ x: 1 }],
      tags: [],
    };
    const comments = [
      { line: 1, text: "# a string", pointer: "/anyOf/0", trailing: false },
      { line: 2, text: "# one", pointer: "/anyOf/1/properties/a/anyOf/0", trailing: true },
    ];
    const text = stringifyYaml(value, comments, [], { indentSequences: false });
    expect(text).toBe(`anyOf:
# a string
- type: string
- type: object
  required: [a]
  properties:
    a:
      anyOf:
      - const: 1 # one
      - const: 2
items:
- x: 1
tags: []
`);
    expect(readYaml(text).layout).toEqual({ indentSequences: false, folds: [] });
    expect(stringifyYaml(value, comments)).toBe(stringifyYaml(value, comments, [], { indentSequences: true }));
  });

  it("starts a sequence item's first key on the dash's line when that key holds a sequence at its indentation", () => {
    const value = [{ anyOf: [{ type: "string" }, { type: "null" }] }];
    expect(stringifyYaml(value, [], [], { indentSequences: false })).toBe(`- anyOf:
  - type: string
  - type: "null"
`);
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

  it("writes a folded block scalar back on the lines the file wrapped it on", () => {
    const text = `description: >-
  Find tickets by text, so the agent can point at an existing one
  instead of opening a duplicate. Two words beat one:

    billing refund      good

  The more indented line above keeps its line breaks.
note: |
  Kept as it is.
`;
    const { value, layout } = readYaml(text);
    expect(layout.folds).toEqual([
      {
        pointer: "/description",
        style: "folded",
        lines: [
          "Find tickets by text, so the agent can point at an existing one",
          "instead of opening a duplicate. Two words beat one:",
          "",
          "  billing refund      good",
          "",
          "The more indented line above keeps its line breaks.",
        ],
      },
    ]);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("wraps a sentence a fix added to a folded string at the width of the file's longest line", () => {
    const { layout } = readYaml("d: >\n  The number of results to return, counted\n  from the first match.\n");
    const description = "The number of results to return, counted from the first match. Must be at least 1. Must be at most 50.";
    expect(stringifyYaml({ d: description }, [], [], layout)).toBe(`d: >-
  The number of results to return, counted
  from the first match. Must be at least
  1. Must be at most 50.
`);
  });

  it("puts a sentence a fix added to a folded string on its one line when the file did not wrap it", () => {
    const { layout } = readYaml("d: >\n  How many.\n");
    expect(stringifyYaml({ d: "How many. Must be at least 1." }, [], [], layout)).toBe("d: >-\n  How many. Must be at least 1.\n");
  });

  it.each([
    ["a string the fix did not extend", "Something else entirely."],
    ["a string that runs on over lines of its own", "The number of results to return, counted from the first match.\nMust be at least 1."],
  ])("writes %s that a folded block cannot hold as any other string", (_, d) => {
    const { layout } = readYaml("d: >\n  The number of results to return, counted\n  from the first match.\n");
    const written = stringifyYaml({ d }, [], [], layout);
    expect(written).toBe(stringifyYaml({ d }));
    expect(parseYaml(written)).toEqual({ d });
  });

  it("writes a plain or quoted scalar the file continued below its key back on the lines the file wrapped it on", () => {
    const text = `tools:
  - description: Words to look for in the title and the body, which
      the server matches case-insensitively.

      A blank line is a line break.
    note: "Quoted, with a \\"quote\\" and an escaped
      line break that\\
      \\ keeps its space."
    other: 'It''s single-quoted,
      over two lines.'
`;
    const { value, layout } = readYaml(text);
    expect(layout.folds).toEqual([
      {
        pointer: "/tools/0/description",
        style: "plain",
        lines: [
          "Words to look for in the title and the body, which",
          "the server matches case-insensitively.",
          "",
          "A blank line is a line break.",
        ],
      },
      {
        pointer: "/tools/0/note",
        style: "double",
        lines: ['"Quoted, with a \\"quote\\" and an escaped', "line break that\\", '\\ keeps its space."'],
      },
      { pointer: "/tools/0/other", style: "single", lines: ["'It''s single-quoted,", "over two lines.'"] },
    ]);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it.each([
    [
      "plain",
      "d: How many results to return, counted\n  from the first match.\n",
      "d: How many results to return, counted\n  from the first match. Must be at\n  least 1.\n",
    ],
    [
      "double-quoted",
      'd: "How many results to return, counted\n  from the first match."\n',
      'd: "How many results to return, counted\n  from the first match. Must be at\n  least 1."\n',
    ],
    [
      "single-quoted",
      "d: 'How many results to return, counted\n  from the first match.'\n",
      "d: 'How many results to return, counted\n  from the first match. Must be at\n  least 1.'\n",
    ],
  ])("wraps a sentence a fix added to a %s string continued below its key, inside its quotes", (_, file, expected) => {
    const { layout } = readYaml(file);
    const d = "How many results to return, counted from the first match. Must be at least 1.";
    expect(stringifyYaml({ d }, [], [], layout)).toBe(expected);
  });

  it("escapes the sentence a fix adds inside the quotes a string was written in", () => {
    const { layout } = readYaml("d: 'The kind of ticket it is, in a word or two,\n  in short.'\nq: \"The kind of ticket it is, in a word or two,\n  in short.\"\n");
    const d = "The kind of ticket it is, in a word or two, in short. Say 'a' or \"b\".";
    const q = "The kind of ticket it is, in a word or two, in short. Say \"b\".";
    expect(stringifyYaml({ d, q }, [], [], layout)).toBe(
      "d: 'The kind of ticket it is, in a word or two,\n  in short. Say ''a'' or \"b\".'\nq: \"The kind of ticket it is, in a word or two,\n  in short. Say \\\"b\\\".\"\n",
    );
  });

  it.each([
    ["a string the fix did not extend", { d: "Something else entirely." }, []],
    ["a word that would start a line as a comment", { d: "One two three four. #five" }, []],
    ["a comment after the string's first line", { d: "One two three four." }, [{ line: 1, text: "# note", pointer: "/d", trailing: true }]],
  ])("writes %s that a continued plain scalar cannot hold on one line", (_, value, comments) => {
    const { layout } = readYaml("d: One two\n  three four.\n");
    const written = stringifyYaml(value, comments, [], layout);
    expect(written).toBe(stringifyYaml(value, comments));
    expect(parseYaml(written)).toEqual(value);
  });

  it("keeps a fold that no longer matches the value out of the way of a value that is not a string", () => {
    const { layout } = readYaml("d: >\n  one\n  two\n");
    expect(stringifyYaml({ d: { type: "string" } }, [], [], layout)).toBe("d:\n  type: string\n");
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
