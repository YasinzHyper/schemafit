import { describe, expect, it } from "vitest";
import { YamlError, parseYaml, readYaml } from "../src/yaml.js";

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

  it("reads a flow collection continued on the lines below it", () => {
    expect(parseYaml('type: [string,\n  "null"]\nminLength: 1\n')).toEqual({ type: ["string", "null"], minLength: 1 });
    // The layout a formatter gives a list too long for its line.
    expect(parseYaml('type:\n  [\n    string,\n    "null",\n  ]\ndescription: x\n')).toEqual({
      type: ["string", "null"],
      description: "x",
    });
    expect(parseYaml("items: { type: string,\n  enum: [a,\n    b] }\n")).toEqual({
      items: { type: "string", enum: ["a", "b"] },
    });
    expect(parseYaml("- [a,\n   b]\n- c\n")).toEqual([["a", "b"], "c"]);
    expect(parseYaml("{ a:\n    b }\n")).toEqual({ a: "b" });
  });

  it("reads comments and blank lines between the entries of a flow collection", () => {
    expect(parseYaml("enum: [a, # the first\n  # a whole line\n\n  b]\nc: 1\n")).toEqual({ enum: ["a", "b"], c: 1 });
    // A quoted scalar folds on over a line break inside a collection as it does in a block, and
    // what ends the line it closes on may be a comment.
    expect(parseYaml('enum: ["one\n  two", "x" # note\n  , y]\n')).toEqual({ enum: ["one two", "x", "y"] });
  });

  it("reads a JSON document written over several lines as the YAML it also is", () => {
    const json = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags"] };
    expect(parseYaml(JSON.stringify(json, null, 2))).toEqual(json);
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

  it("folds a quoted scalar continued on the lines below it", () => {
    expect(parseYaml('description: "Words to look for\n  in the title."\ntype: string\n')).toEqual({
      description: "Words to look for in the title.",
      type: "string",
    });
    expect(parseYaml("description: 'the user''s\n  name'\n")).toEqual({ description: "the user's name" });
    // A blank line is a newline, and the white space at either end of a line is not content.
    expect(parseYaml('a: "one   \n\n     two\n\n\n  three"\n')).toEqual({ a: "one\ntwo\n\nthree" });
    // Except just inside the quotes, where it is.
    expect(parseYaml("a: ' one\n  two '\n")).toEqual({ a: " one two " });
    // A line of nothing but the closing quote folds its line break into a space.
    expect(parseYaml('a: "one\n  "\n')).toEqual({ a: "one " });
  });

  it("reads the lines of a quoted scalar as content, not as YAML", () => {
    expect(
      parseYaml('a: "one # not a comment\n  # nor this\n  - nor a sequence: item"\nb: 2\n'),
    ).toEqual({ a: "one # not a comment # nor this - nor a sequence: item", b: 2 });
    expect(parseYaml("a: 'one\n  it''s \"two\"' # a comment\n")).toEqual({ a: 'one it\'s "two"' });
  });

  it("breaks a double-quoted line with an escaped line break, keeping the white space before it", () => {
    expect(parseYaml('a: "abc\\\n  def"\n')).toEqual({ a: "abcdef" });
    expect(parseYaml('a: "or \\t \\\n  \\ \tend"\n')).toEqual({ a: "or \t  \tend" });
    expect(parseYaml('a: "one\\\n\n  two"\n')).toEqual({ a: "one\ntwo" });
    // An escape at the end of a line is content, so the space it spells is not trailing white space.
    expect(parseYaml('a: "one\\t\n  two"\n')).toEqual({ a: "one\t two" });
    expect(parseYaml('a: "one\\ \n  two"\n')).toEqual({ a: "one  two" });
  });

  it("folds a quoted scalar in a sequence item, below its key, and as a whole document", () => {
    expect(parseYaml('enum:\n  - "first\n    choice"\n  - second\n')).toEqual({ enum: ["first choice", "second"] });
    expect(parseYaml("a:\n  'one\n  two'\n")).toEqual({ a: "one two" });
    expect(parseYaml('- name: "a\n    b"\n  type: string\n')).toEqual([{ name: "a b", type: "string" }]);
    expect(parseYaml('"one\ntwo"\n')).toBe("one two");
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

  it("keeps the more indented lines of a folded block scalar as their own lines", () => {
    // YAML 1.2 section 8.1.3: folding does not apply to the line breaks around a line that
    // still begins with a space once the block's indentation is off.
    expect(parseYaml("d: >\n  one\n    two\n  three\n")).toEqual({ d: "one\n  two\nthree\n" });
    expect(parseYaml("d: >\n  a\n    b\n    c\n  d\n")).toEqual({ d: "a\n  b\n  c\nd\n" });
    expect(parseYaml("d: >-\n  a\n    b\n  c\n")).toEqual({ d: "a\n  b\nc" });
    // A blank line beside a more indented one adds its break to the one the line already keeps.
    expect(parseYaml("d: >\n  a\n    b\n\n    c\n")).toEqual({ d: "a\n  b\n\n  c\n" });
    expect(parseYaml("d: >\n  a\n    b\n\n  c\n")).toEqual({ d: "a\n  b\n\nc\n" });
    expect(parseYaml("d: >\n  a\n    b\n\n\n    c\n")).toEqual({ d: "a\n  b\n\n\n  c\n" });
    // A line of nothing but spaces is a more indented line where it has some past the block's
    // indentation, and an empty one where it does not.
    expect(parseYaml("d: >\n  a\n     \n  b\n")).toEqual({ d: "a\n   \nb\n" });
    expect(parseYaml("d: >\n  a\n  \n  b\n")).toEqual({ d: "a\nb\n" });
    // Clip keeps the trailing newline after a more indented last line, and strip takes it off.
    expect(parseYaml("d: >\n  a\n    b\n")).toEqual({ d: "a\n  b\n" });
    expect(parseYaml("d: >\n  a\n     \n")).toEqual({ d: "a\n   \n" });
    // The whole of YAML 1.2's own folded-scalar example, section 8.1.3.
    expect(parseYaml("d: >\n folded\n line\n\n next\n line\n   * bullet\n\n   * list\n   * lines\n\n last\n line\n")).toEqual({
      d: "folded line\nnext line\n  * bullet\n\n  * list\n  * lines\n\nlast line\n",
    });
  });

  it("folds a plain scalar continued on the lines below it", () => {
    expect(parseYaml("description: a name that is\n  long enough to wrap\n")).toEqual({
      description: "a name that is long enough to wrap",
    });
    // The continuation clears the block the scalar sits in, so it folds at the key's own
    // indentation and at any depth past it, and gives up the indentation either way.
    expect(parseYaml("description:\n  a name that is\n  long enough to wrap\n")).toEqual({
      description: "a name that is long enough to wrap",
    });
    expect(parseYaml("description: a name\n      that wrapped\n")).toEqual({ description: "a name that wrapped" });
    expect(parseYaml("description: a name\n two\n")).toEqual({ description: "a name two" });
    // A run of line breaks folds to one fewer newline, the way ">" folds one.
    expect(parseYaml("a: one\n\n  two\n")).toEqual({ a: "one\ntwo" });
    expect(parseYaml("a: one\n\n\n  two\n")).toEqual({ a: "one\n\ntwo" });
    expect(parseYaml("a: one\n\n  two\n\n  three\n")).toEqual({ a: "one\ntwo\nthree" });
    // A line of nothing but spaces is an empty line here, unlike inside a block scalar, where
    // what it holds past the block's indentation is content.
    expect(parseYaml("a: one\n   \n  two\n")).toEqual({ a: "one\ntwo" });
    expect(parseYaml("a: one   \n  two   \n")).toEqual({ a: "one two" });
  });

  it("folds a plain scalar wherever one is written, and ends it where the block does", () => {
    expect(parseYaml("- a long\n  sentence\n")).toEqual(["a long sentence"]);
    expect(parseYaml("- one\n    two\n")).toEqual(["one two"]);
    expect(parseYaml("-\n  foo\n  bar\n")).toEqual(["foo bar"]);
    expect(parseYaml("- a: one\n    two\n")).toEqual([{ a: "one two" }]);
    expect(parseYaml("a:\n  - one\n    two\n  - three\n")).toEqual({ a: ["one two", "three"] });
    expect(parseYaml("hello\nworld\n")).toBe("hello world");
    // The next key of the mapping ends the scalar, and so does the blank line before it.
    expect(parseYaml("a: one\n  two\nb: 3\n")).toEqual({ a: "one two", b: 3 });
    expect(parseYaml("a: one\n  two\n\nb: 3\n")).toEqual({ a: "one two", b: 3 });
    expect(parseYaml("a:\n  b: one\n    two\nc: 3\n")).toEqual({ a: { b: "one two" }, c: 3 });
    expect(parseYaml("a: one\n  two\n...\n")).toEqual({ a: "one two" });
  });

  it("reads a folded plain scalar as the one string it is", () => {
    // Folding leaves a space in the scalar, so what the core schema would have resolved a line
    // of it to on its own is beside the point: the whole scalar is one string.
    expect(parseYaml("a: 1\n  2\n")).toEqual({ a: "1 2" });
    expect(parseYaml("a: true\n  enough\n")).toEqual({ a: "true enough" });
    expect(parseYaml("a: ~\n  tail\n")).toEqual({ a: "~ tail" });
    // Only the first character of the whole scalar is read as an indicator, so a continuation
    // line holds what a plain scalar cannot start with, a dash included.
    expect(parseYaml("a: the\n  *important* part\n")).toEqual({ a: "the *important* part" });
    expect(parseYaml("a: see\n  [the docs]\n")).toEqual({ a: "see [the docs]" });
    expect(parseYaml("description: things\n  - one\n  - two\n")).toEqual({ description: "things - one - two" });
    expect(parseYaml("- foo\n  - bar\n")).toEqual(["foo - bar"]);
  });

  it("ends a folded plain scalar at a comment, and keeps one that follows it", () => {
    expect(parseYaml("a: one\n  two # the comment ends a scalar that was ending anyway\n")).toEqual({ a: "one two" });
    expect(parseYaml("a: one\n  two\n  # a comment below the scalar\nb: 3\n")).toEqual({ a: "one two", b: 3 });
    expect(parseYaml("a: one\n# at the mapping's own indentation\nb: 3\n")).toEqual({ a: "one", b: 3 });
  });

  it("reads a block scalar whose header gives its indentation", () => {
    // YAML 1.2 section 8.1.1.1, Examples 8.1 and 8.2: the indicator is added to the column of
    // the dash or the key, and what a line holds past that is content, leading spaces included.
    expect(parseYaml("- |1\n  explicit\n")).toEqual([" explicit\n"]);
    expect(parseYaml("- >1 # a comment after the header\n  folded\n")).toEqual([" folded\n"]);
    expect(parseYaml("- >1-\n  strip\n")).toEqual([" strip"]);
    expect(parseYaml("d: |-2\n    x\n")).toEqual({ d: "  x" });
    // The first line of content is the one auto-detection would have taken the indentation from.
    expect(parseYaml("d: |2\n    indented\n  next\n")).toEqual({ d: "  indented\nnext\n" });
    expect(parseYaml("a:\n  b: >2\n      example\n    prose\n    folds\nc: 1\n")).toEqual({
      a: { b: "  example\nprose folds\n" },
      c: 1,
    });
    expect(parseYaml("- k: |2\n      x\n")).toEqual([{ k: "  x\n" }]);
    // A leading blank line is no longer ambiguous once the indentation is given, so the spaces
    // it holds past it are content.
    expect(parseYaml("d: |1\n   \n  x\n")).toEqual({ d: "  \n x\n" });
    // Without content, the indicator changes nothing.
    expect(parseYaml("d: |2\ne: 1\n")).toEqual({ d: "", e: 1 });
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
    expect(refusal("a: one\n  two: three\n")).toBe(
      'line 2: the plain scalar "two: three" holds a colon followed by a space; quote it if it is text, or put the nested mapping on its own indented line',
    );
    expect(refusal("a: one\n  two:\n")).toContain('line 2: the plain scalar "two:" holds a colon followed by a space');
    expect(refusal("a:\n  one\n  b: two\n")).toContain('line 3: the plain scalar "b: two" holds a colon');
    expect(refusal("a: one\n  # note\n  two\n")).toBe(
      'line 2: a comment inside a plain scalar spread over lines; YAML folds no comment into a scalar, so move the comment above the scalar, or write the scalar as a block scalar ("|" for the lines as they are, ">" to fold them into one)',
    );
    expect(refusal("a: one # note\n  two\n")).toContain("line 1: a comment inside a plain scalar spread over lines");
    expect(refusal("a: one\n  two # note\n  three\n")).toContain(
      "line 2: a comment inside a plain scalar spread over lines",
    );
    expect(refusal("a: 'one'\n  two\n")).toBe(
      'line 2: "two" is indented under a quoted scalar that already ended at its closing quote; move the text inside the quotes, or indent the line less',
    );
    expect(refusal('a: "one"\n  two\n')).toContain('line 2: "two" is indented under a quoted scalar that already ended');
    expect(refusal('a: "one\n  two"\n  three\n')).toContain('line 3: "three" is indented under a quoted scalar');
    expect(refusal('a: "one # note\nb: two\n')).toBe(
      "line 2: a line inside the quoted scalar opened on line 1 indented less than the scalar's block; close the \" on the line it belongs to, or indent this line further",
    );
    expect(refusal('"a\n  b": 1\n')).toBe(
      "line 2: a quoted key spread over lines, from line 1; YAML holds an implicit key to a single line, so write the key on one",
    );
    expect(refusal('a: "one\n  two" three\n')).toBe('line 2: unexpected "three" after the value');
    expect(refusal('"one\n---\ntwo"\n')).toContain("line 2: a line inside the quoted scalar opened on line 1");
    expect(refusal('a: "one\n\n  two\n')).toBe('line 1: a string with no closing "');
    expect(refusal("a: 'one\n  two\n")).toBe("line 1: a string with no closing '");
    expect(refusal('a: "one\n  \\q"\n')).toBe('line 2: unsupported escape "\\q" in a double-quoted string');
    expect(refusal("type: [string,\n")).toBe('line 1: a flow collection with no closing "]"');
    expect(refusal("a: { b: [1,\n    2]\n")).toBe('line 1: a flow collection with no closing "}"');
    expect(refusal("type: [string,\nb: 1\n")).toBe(
      "line 2: a line inside the flow collection opened on line 1 indented less than the collection's block; close the collection on the line it belongs to, or indent this line further",
    );
    expect(refusal("type: [string,\n]\n")).toBe(
      'line 2: the closing "]" of the flow collection opened on line 1 is not indented further than the block the collection sits in, which YAML asks of every line of it; indent it further',
    );
    expect(refusal("a:\n  b: {\n    c: 1\n  }\n")).toContain('line 4: the closing "}" of the flow collection opened on line 2');
    expect(refusal("[a,\n---\nb]\n")).toBe(
      "line 2: a document marker inside the flow collection opened on line 1; close the collection above it",
    );
    expect(refusal("type: [string\n  integer]\n")).toBe(
      'line 2: expected "," or "]" in a flow collection, found "integer]" on the line below the entry before it; a plain scalar inside a flow collection is read on one line, so quote one that wraps, or put a comma after the entry above if they are two',
    );
    expect(refusal("a: { b: one\n  two }\n")).toContain('line 2: expected "," or "}" in a flow collection, found "two }" on the line below');
    expect(refusal("type: [string]\n  extra\n")).toBe(
      'line 2: "extra" is indented under a flow collection that already ended at its closing bracket; move the text inside the brackets, or indent the line less',
    );
    expect(refusal("type: [string,\n  integer] x\n")).toBe('line 2: unexpected "x" after the value');
    expect(refusal('a: "unterminated\n')).toContain('line 1: a string with no closing "');
    expect(refusal("description: |+\n  one\n")).toContain('line 1: the "keep" chomping indicator ("+")');
    expect(refusal("description: |0\n  one\n")).toBe(
      'line 1: the block scalar header "|0" is not supported; use "|" or ">", followed by "-" to strip the final line break or a digit from 1 to 9 to give the indentation, and quote a scalar that starts with "|" or ">"',
    );
    expect(refusal("description: |10\n  one\n")).toContain('line 1: the block scalar header "|10"');
    expect(refusal("description: >2+\n  one\n")).toContain('line 1: the "keep" chomping indicator ("+")');
    expect(refusal("- |2\n text\n")).toBe(
      'line 2: a line inside a block scalar indented less (1) than its header "|2" says its content is (2); indent the line further, or lower the indentation indicator',
    );
    expect(refusal("a: >3\n   one\n  two\n")).toContain("line 3: a line inside a block scalar indented less (2)");
    expect(refusal("d: |\n   \n  one\n")).toBe(
      "line 2: a blank line inside a block scalar holding more spaces (3) than the block's first line of content is indented (2); leave it empty",
    );
    expect(refusal("a: 1\nnot a mapping entry\n")).toBe(
      'line 2: expected "key: value"; a key ends at a colon followed by a space',
    );
    expect(refusal("a: 1\n  b: 2\n")).toContain('line 2: the plain scalar "b: 2" holds a colon followed by a space');
    expect(refusal("- a\nb: 1\n")).toBe('line 2: expected a sequence item ("- ")');
    expect(refusal("- 1\nb: 2\n")).toBe('line 2: expected a sequence item ("- ")');
    expect(refusal("a:\n- - 1\n  b: 2\n")).toBe('line 3: expected a sequence item ("- ")');
    expect(refusal("a:\n  - 1\n  b: 2\n")).toBe('line 3: expected a sequence item ("- ")');
    expect(refusal('a: "x" y\n')).toBe('line 1: unexpected "y" after the value');
    expect(refusal('a: "\\q"\n')).toBe('line 1: unsupported escape "\\q" in a double-quoted string');
    expect(refusal('a: "\\u00g1"\n')).toBe('line 1: the escape "\\u" needs 4 hexadecimal digits');
  });
});

describe("readYaml", () => {
  it("names the lines that hold a comment, on their own or after a value", () => {
    const { value, comments } = readYaml(`# The schema.
type: object # always
properties:
  # one field
  tags: [a, # first
    b]
  title: "quoted # not a comment" # but this is
`);
    expect(value).toEqual({ type: "object", properties: { tags: ["a", "b"], title: "quoted # not a comment" } });
    expect(comments).toEqual([1, 2, 4, 5, 7]);
  });

  it("leaves out a # that is a character of a block scalar or of a quoted scalar spread over lines", () => {
    const { comments } = readYaml(`description: |
  # a heading in the description
  text
title: "one
  # two" # a comment after the closing quote
note: 'three
  # four'
`);
    expect(comments).toEqual([5]);
  });

  it("finds no comment in a document without one", () => {
    expect(readYaml("type: string\ndescription: issue#12, not a comment\n").comments).toEqual([]);
  });
});
