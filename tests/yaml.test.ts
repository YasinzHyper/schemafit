import { describe, expect, it } from "vitest";
import { YamlError, parseYaml } from "../src/yaml.js";

/** The error a document is refused with, for the assertions on what the reader declines. */
function refusal(text: string): string {
  try {
    parseYaml(text);
  } catch (error) {
    expect(error).toBeInstanceOf(YamlError);
    return (error as YamlError).message;
  }
  throw new Error("expected parseYaml to throw");
}

describe("parseYaml", () => {
  it("reads a schema written as a block mapping", () => {
    expect(
      parseYaml(`type: object
properties:
  title:
    type: string
    minLength: 1
  count:
    type: integer
additionalProperties: false
`),
    ).toEqual({
      type: "object",
      properties: { title: { type: "string", minLength: 1 }, count: { type: "integer" } },
      additionalProperties: false,
    });
  });

  it("reads a sequence indented under its key and one at the key's own indentation", () => {
    expect(parseYaml("required:\n  - title\n  - count\n")).toEqual({ required: ["title", "count"] });
    expect(parseYaml("required:\n- title\n- count\n")).toEqual({ required: ["title", "count"] });
    expect(parseYaml("required:\n- title\n- count\ntype: object\n")).toEqual({
      required: ["title", "count"],
      type: "object",
    });
  });

  it("ends a sequence at its key's own indentation when the mapping's next key follows", () => {
    expect(
      parseYaml(`name: create_ticket
input_schema:
  type: object
  properties:
    title:
      type: string
  required:
  - title
  additionalProperties: false
`),
    ).toEqual({
      name: "create_ticket",
      input_schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    // Example 8.22 of the YAML 1.2.2 specification, without the tags this reader refuses.
    expect(parseYaml("sequence:\n- entry\n- - nested\nmapping:\n  foo: bar\n")).toEqual({
      sequence: ["entry", ["nested"]],
      mapping: { foo: "bar" },
    });
  });

  it("reads a sequence item with nothing after its dash as null, not as the items below it", () => {
    expect(parseYaml("-\n- a\n")).toEqual([null, "a"]);
    // Example 8.15 of the specification, which opens with an empty item.
    expect(
      parseYaml(`- # Empty
- |
 block node
- - one # Compact
  - two # sequence
- one: two # Compact mapping
`),
    ).toEqual([null, "block node\n", ["one", "two"], { one: "two" }]);
    // A list of tool definitions with one entry left blank: the rest keep their place in it.
    expect(
      parseYaml(`-
- name: search_tickets
  input_schema:
    type: object
`),
    ).toEqual([null, { name: "search_tickets", input_schema: { type: "object" } }]);
    // An item's own block still has to sit past the dash, and there it is the item's value.
    expect(parseYaml("-\n  a: 1\n- b\n")).toEqual([{ a: 1 }, "b"]);
  });

  it("reads a mapping that starts on a sequence item's dash", () => {
    expect(
      parseYaml(`anyOf:
  - type: string
    maxLength: 8
  - type: "null"
`),
    ).toEqual({ anyOf: [{ type: "string", maxLength: 8 }, { type: "null" }] });
  });

  it("reads nested sequences and a sequence of sequences", () => {
    expect(parseYaml("enum:\n  - - 1\n    - 2\n  - []\n")).toEqual({ enum: [[1, 2], []] });
  });

  it("reads flow collections", () => {
    expect(parseYaml('type: [string, "null"]\n')).toEqual({ type: ["string", "null"] });
    expect(parseYaml("items: { type: integer, minimum: 0 }\n")).toEqual({ items: { type: "integer", minimum: 0 } });
    expect(parseYaml("a: []\nb: {}\nc: [[1], { x: [2, 3] }]\n")).toEqual({ a: [], b: {}, c: [[1], { x: [2, 3] }] });
    expect(parseYaml("enum: [a, b,]\n")).toEqual({ enum: ["a", "b"] });
  });

  it("reads a flow collection written below its key", () => {
    expect(parseYaml("type:\n  [string, integer]\n")).toEqual({ type: ["string", "integer"] });
  });

  it("resolves plain scalars the way the YAML 1.2 core schema does", () => {
    expect(
      parseYaml(`a: null
b: ~
c:
d: true
e: False
f: 42
g: -1.5
h: 1e3
i: 0x1f
j: 0o17
k: on
l: 2026-10-11
m: schemafit
`),
    ).toEqual({
      a: null,
      b: null,
      c: null,
      d: true,
      e: false,
      f: 42,
      g: -1.5,
      h: 1000,
      i: 31,
      j: 15,
      // YAML 1.2 resolves neither "on" nor a date as anything but a string.
      k: "on",
      l: "2026-10-11",
      m: "schemafit",
    });
  });

  it("keeps a quoted scalar a string", () => {
    expect(parseYaml('type: "null"\nconst: "42"\npattern: \'^\\d+$\'\n')).toEqual({
      type: "null",
      const: "42",
      pattern: "^\\d+$",
    });
  });

  it("reads the escapes of a double-quoted scalar", () => {
    expect(parseYaml('a: "tab\\there"\nb: "quote: \\" and backslash: \\\\"\nc: "\\u00e9\\x41"\n')).toEqual({
      a: "tab\there",
      b: 'quote: " and backslash: \\',
      c: "éA",
    });
  });

  it("spells a quote in a single-quoted scalar by doubling it", () => {
    expect(parseYaml("description: 'the user''s name'\n")).toEqual({ description: "the user's name" });
    // The doubled quote leaves the scalar open, so what follows it is still inside the string.
    expect(parseYaml("description: 'don''t # open a duplicate'\n")).toEqual({
      description: "don't # open a duplicate",
    });
    expect(parseYaml("'don''t': 1\n")).toEqual({ "don't": 1 });
  });

  it("strips comments and blank lines, and keeps a # that is part of a scalar", () => {
    expect(
      parseYaml(`# the schema
type: object   # a comment

properties:
  # nothing here yet
  tag:
    pattern: "^#[0-9a-f]{6}$"
    description: the user's colour # a comment after an apostrophe
`),
    ).toEqual({
      type: "object",
      properties: { tag: { pattern: "^#[0-9a-f]{6}$", description: "the user's colour" } },
    });
  });

  it("reads a literal block scalar", () => {
    expect(parseYaml("description: |\n  One.\n  Two.\n")).toEqual({ description: "One.\nTwo.\n" });
    expect(parseYaml("description: |-\n  One.\n  Two.\n")).toEqual({ description: "One.\nTwo." });
    expect(parseYaml("a: |\n  one\n\n  two\nb: 1\n")).toEqual({ a: "one\n\ntwo\n", b: 1 });
  });

  it("folds a folded block scalar", () => {
    expect(parseYaml("description: >\n  One line\n  continued.\n\n  A second.\n")).toEqual({
      description: "One line continued.\nA second.\n",
    });
    expect(parseYaml("description: >-\n  One line\n  continued.\n")).toEqual({ description: "One line continued." });
  });

  it("keeps what a block scalar's line holds past the block's indentation, spaces included", () => {
    expect(parseYaml("d: |\n  a\n   \n")).toEqual({ d: "a\n \n" });
    expect(parseYaml("d: |-\n  a\n   \n")).toEqual({ d: "a\n " });
    expect(parseYaml("d: |\n  a\n  \n  b\n")).toEqual({ d: "a\n\nb\n" });
    expect(parseYaml("d: |\n   \n")).toEqual({ d: "" });
  });

  it("reads a comment-shaped line inside a block scalar as the content it is", () => {
    expect(parseYaml("description: |\n  # Usage\n  Open a ticket.\n")).toEqual({
      description: "# Usage\nOpen a ticket.\n",
    });
    expect(parseYaml("description: >-\n  # not a comment\n  continued.\n")).toEqual({
      description: "# not a comment continued.",
    });
    expect(parseYaml("a: |\n  one\n  # in the middle\n  two\nb: 1\n")).toEqual({
      a: "one\n# in the middle\ntwo\n",
      b: 1,
    });
    expect(parseYaml("d: |\n  # a\n  # b\n")).toEqual({ d: "# a\n# b\n" });
  });

  it("ends a block scalar at a comment line written at the key's own indentation", () => {
    expect(
      parseYaml(`- name: create_ticket
  description: |
    # Usage
    Open a support ticket for the customer.
  # the schema below is generated from the Pydantic model
  input_schema:
    type: object
`),
    ).toEqual([
      {
        name: "create_ticket",
        description: "# Usage\nOpen a support ticket for the customer.\n",
        input_schema: { type: "object" },
      },
    ]);
  });

  it("reads an empty document as nothing at all", () => {
    expect(parseYaml("")).toBeNull();
    expect(parseYaml("# just a comment\n")).toBeNull();
  });

  it("reads a document marker and a bare scalar document", () => {
    expect(parseYaml("---\ntype: object\n")).toEqual({ type: "object" });
    expect(parseYaml("---\ntype: object\n...\n")).toEqual({ type: "object" });
    expect(parseYaml("true\n")).toBe(true);
    expect(parseYaml("---\n- a\n- b\n")).toEqual(["a", "b"]);
  });

  it("reads \\r\\n line endings", () => {
    expect(parseYaml("type: object\r\nrequired:\r\n  - a\r\n")).toEqual({ type: "object", required: ["a"] });
  });

  it("refuses what it cannot read, naming the line and the construct", () => {
    expect(refusal("a: &anchor 1\nb: *anchor\n")).toBe(
      'line 1: an anchor ("&name") is not supported; write it out by hand, or convert the file to JSON',
    );
    expect(refusal("a: 1\nb: *anchor\n")).toContain('line 2: an alias ("*name")');
    expect(refusal("a: !!str 1\n")).toContain('line 1: a tag ("!...")');
    expect(refusal("base: &b { a: 1 }\nchild:\n  <<: *b\n")).toContain("line 1: an anchor");
    expect(refusal("%YAML 1.2\n---\na: 1\n")).toContain('line 1: a directive ("%...")');
    expect(refusal("a: 1\n---\nb: 2\n")).toBe("line 2: a second YAML document; schemafit reads one document per file");
    expect(refusal("a:\n\t- 1\n")).toBe("line 2: a tab in the indentation; YAML indents with spaces only");
    expect(refusal("a: 1\na: 2\n")).toBe('line 2: duplicate key "a"');
    expect(refusal("{ a: 1, a: 2 }\n")).toBe('line 1: duplicate key "a"');
    expect(refusal("1: a\n")).toBe('line 1: the key "1" is not a string; quote it to use it as a property name');
    expect(refusal("a: .inf\n")).toBe('line 1: ".inf" has no JSON equivalent; JSON has neither infinity nor NaN');
    expect(refusal("description: a scalar\n  spread over lines\n")).toContain("line 2: a scalar continued on the next line");
    expect(refusal("type: [string,\n  integer]\n")).toContain('line 1: a flow collection with no closing "]"');
    expect(refusal('a: "unterminated\n')).toContain('line 1: a string with no closing "');
    expect(refusal("description: |+\n  one\n")).toContain('line 1: the "keep" chomping indicator ("+")');
    expect(refusal("description: |2\n  one\n")).toContain("line 1: the block scalar header");
    expect(refusal("description: >\n  one\n    deeper\n")).toContain('line 3: a line indented further than the folded block scalar');
    expect(refusal("d: >\n  a\n   \n")).toContain(
      'line 3: a line indented further than the folded block scalar',
    );
    expect(refusal("d: |\n   \n  one\n")).toBe(
      "line 2: a blank line inside a block scalar holding more spaces (3) than the block's first line of content is indented (2); leave it empty",
    );
    expect(refusal("a: 1\nnot a mapping entry\n")).toBe(
      'line 2: expected "key: value"; a key ends at a colon followed by a space',
    );
    expect(refusal("a: 1\n  b: 2\n")).toContain("line 2:");
    expect(refusal("- a\nb: 1\n")).toBe('line 2: expected a sequence item ("- ")');
    expect(refusal("- 1\nb: 2\n")).toBe('line 2: expected a sequence item ("- ")');
    expect(refusal("a:\n- - 1\n  b: 2\n")).toBe('line 3: expected a sequence item ("- ")');
    expect(refusal("a:\n  - 1\n  b: 2\n")).toBe('line 3: expected a sequence item ("- ")');
    expect(refusal('a: "x" y\n')).toBe('line 1: unexpected "y" after the value');
    expect(refusal('a: "\\q"\n')).toBe('line 1: unsupported escape "\\q" in a double-quoted string');
    expect(refusal('a: "\\u00g1"\n')).toBe('line 1: the escape "\\u" needs 4 hexadecimal digits');
  });
});
