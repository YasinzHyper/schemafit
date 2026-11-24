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
    expect(readYaml(text).layout).toEqual({
      indentSequences: false,
      sequences: [
        { pointer: "/anyOf", indented: false },
        { pointer: "/anyOf/1/properties/a/anyOf", indented: false },
        { pointer: "/items", indented: false },
      ],
      blockLists: false,
      folds: [],
      flows: [{ pointer: "/anyOf/1/required", kind: "sequence", padded: false, width: 15 }],
    });
    expect(stringifyYaml(value, comments)).toBe(stringifyYaml(value, comments, [], { indentSequences: true }));
  });

  it("indents each sequence the way the file indented it, where the file writes them both ways", () => {
    const text = `type: object
properties:
  status:
    enum:
      - open
      - closed
  tags:
    anyOf:
    - type: string
    - type: "null"
required:
- status
- tags
`;
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("keeps a list of scalars the file wrote one item to a line on its lines, as it grows", () => {
    const { layout } = readYaml("required:\n  - query\nenum: [a, b]\n");
    const value = { required: ["query", "status", "limit"], enum: ["a", "b", "c"], type: ["integer", "null"] };
    expect(stringifyYaml(value, [], [], layout)).toBe(`required:
  - query
  - status
  - limit
enum: [a, b, c]
type: [integer, "null"]
`);
  });

  it("gives a sequence the file did not hold the indentation of its first one", () => {
    const { layout } = readYaml("a:\n- x: 1\nb:\n  - x: 2\n");
    expect(stringifyYaml({ a: [{ x: 1 }], b: [{ x: 2 }], c: [{ x: 3 }] }, [], [], layout)).toBe(`a:
- x: 1
b:
  - x: 2
c:
- x: 3
`);
  });

  it("keeps a list of scalars a sequence item holds over lines on its lines", () => {
    const text = "examples:\n  - - a\n    - b\n  - [c]\n";
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("writes a list of scalars the file did not hold one item to a line, where the file writes every list that way", () => {
    // What PyYAML's safe_dump writes with default_flow_style=False: keys sorted, and every
    // sequence at the indentation of its key.
    const { layout } = readYaml(`properties:
  limit:
    type: integer
  query:
    type: string
required:
- query
type: object
`);
    const value = {
      properties: { limit: { type: ["integer", "null"] }, query: { type: "string" }, tags: { type: "array", examples: [["a", "b"]] } },
      required: ["query", "limit"],
      type: "object",
    };
    expect(stringifyYaml(value, [], [], layout)).toBe(`properties:
  limit:
    type:
    - integer
    - "null"
  query:
    type: string
  tags:
    type: array
    examples:
    - - a
      - b
required:
- query
- limit
type: object
`);
  });

  it("writes a list of scalars the file did not hold in flow style, where the file writes a collection that way", () => {
    const { layout } = readYaml("required:\n- query\nitems: {type: string}\n");
    const value = { required: ["query", "limit"], items: { type: "string" }, type: ["integer", "null"] };
    expect(stringifyYaml(value, [], [], layout)).toBe(`required:
- query
- limit
items: {type: string}
type: [integer, "null"]
`);
  });

  it("keeps a flow mapping, and a flow sequence that holds one, on the line the file wrote it on", () => {
    const text = `type: object
properties:
  id: { type: string, pattern: "^[a-z]+$" }
  owner:
    anyOf: [{type: string}, {type: "null"}]
  tags:
    type: array
    items:
      - {type: string}
      - { const: 1 }
required: [id, owner, tags]
`;
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("keeps a flow collection on its line as a fix adds to it, spacing what it adds as the file spaces its first one", () => {
    const { layout } = readYaml("b: [ x ]\na: [{ type: string }]\nc: {type: integer}\n");
    const value = {
      b: ["x", "z"],
      a: [{ type: "string" }, { type: "null" }],
      c: { type: "integer", additionalProperties: false },
      d: { type: ["integer", "null"] },
    };
    expect(stringifyYaml(value, [], [], layout)).toBe(`b: [ x, z ]
a: [{ type: string }, { type: "null" }]
c: {type: integer, additionalProperties: false}
d:
  type: [ integer, "null" ]
`);
  });

  it("keeps a line the file wrote past the flow width, and moves one a fix lengthened past both into block style", () => {
    const long = `  items: {type: string, enum: [alpha, beta, gamma, delta, epsilon, zeta, eta, theta]}`;
    const text = `${long}\nanyOf: [{type: string, format: uri}, {type: "null"}]\n`;
    const { value, layout } = readYaml(`properties:\n${text}`);
    expect(long.length).toBeGreaterThan(80);
    expect(stringifyYaml(value, [], [], layout)).toBe(`properties:\n${text}`);
    const fixed = {
      ...(value as Record<string, unknown>),
      anyOf: [{ type: "string", description: "Must be an absolute URI, such as https://example.com/a." }, { type: "null" }],
    };
    // The branch that no longer fits goes into block style, and the one beside it keeps its line.
    expect(stringifyYaml(fixed, [], [], layout)).toBe(`properties:
${long}
anyOf:
  - type: string
    description: Must be an absolute URI, such as https://example.com/a.
  - {type: "null"}
`);
  });

  it("keeps a list of scalars the file wrote in flow style past the flow width on its line", () => {
    const text = `enum: [alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa, lambda, mu]\n`;
    const { value, layout } = readYaml(text);
    expect(text.length).toBeGreaterThan(80);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
    expect(stringifyYaml(value)).toBe(`enum:\n  - ${(value as { enum: string[] }).enum.join("\n  - ")}\n`);
  });

  it("quotes what a flow collection would read as something else", () => {
    const { layout } = readYaml("properties: {a: {type: string}}\n");
    const value = { properties: { "a:b": { type: "string", description: "one, two", default: "true" } } };
    expect(stringifyYaml(value, [], [], layout)).toBe(
      'properties: {"a:b": {type: string, description: "one, two", default: "true"}}\n',
    );
  });

  it("keeps a document the file wrote as one flow mapping on its line", () => {
    const text = "{type: object, properties: {id: {type: string}}, required: [id]}\n";
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("writes a flow collection in block style where a comment belongs to an entry inside it", () => {
    const { value, layout } = readYaml("items: {type: string}\n");
    const comment = { line: 1, text: "# always a string", pointer: "/items/type", trailing: true };
    expect(stringifyYaml(value, [comment], [], layout)).toBe("items:\n  type: string # always a string\n");
  });

  it("keeps a flow collection the file spread one entry to a line on those lines", () => {
    // What Prettier writes for the collections that outgrew their lines.
    const text = `properties:
  status:
    anyOf:
      [
        {
          type: string,
          description: "The status of the ticket, as the help desk shows it",
        },
        { type: "null" },
      ]
  tags:
    items:
      {
        enum:
          [alpha, beta, gamma, delta, epsilon, zeta, eta, theta, iota, kappa],
      }
  steps:
    type: array
    items:
      - {
          type: string,
          description: "A step of the ticket's workflow, in the order it runs",
        }
required:
  [
    status,
    tags,
    steps,
  ]
`;
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("keeps a JSON document saved as YAML spread over its lines", () => {
    const { value, layout } = readYaml('{\n  "type": "object",\n  "required": [\n    "id"\n  ]\n}\n');
    expect(stringifyYaml({ ...(value as object), additionalProperties: false }, [], [], layout)).toBe(`{
  type: object,
  required: [
    id
  ],
  additionalProperties: false
}
`);
  });

  it("writes what a fix adds to a collection spread over lines one entry to a line, spacing it as the file spaces its others", () => {
    const { layout } = readYaml(`anyOf:
  [
    {
      type: string,
      description: "The status of the ticket, as the help desk shows it",
    },
  ]
items: { type: string }
`);
    const value = {
      anyOf: [
        { type: "string", description: "The status of the ticket, as the help desk shows it", maxLength: 40 },
        { type: "null" },
        { type: "object", properties: { reason: { type: "string" }, since: { type: "string", format: "date" } } },
      ],
      items: { type: "string" },
    };
    // A collection the file did not hold goes on one line where it fits, and is spread the way
    // the collection around it is where it does not.
    expect(stringifyYaml(value, [], [], layout)).toBe(`anyOf:
  [
    {
      type: string,
      description: "The status of the ticket, as the help desk shows it",
      maxLength: 40,
    },
    { type: "null" },
    {
      type: object,
      properties:
        { reason: { type: string }, since: { type: string, format: date } },
    },
  ]
items: { type: string }
`);
  });

  it("moves a flow collection a fix lengthened past its line below its key, and spreads it where it does not fit there either", () => {
    const { layout } = readYaml(`properties:
  ticket:
    {
      type: object,
      properties: { title: { type: string, description: "Short title" } },
    }
required: [ticket]
`);
    const value = {
      properties: {
        ticket: {
          type: "object",
          properties: { title: { type: ["string", "null"], description: "Short title. Must be at most 120 characters long." } },
        },
      },
      required: ["ticket", "a_property_whose_name_runs_long", "another_property_whose_name_runs"],
    };
    expect(stringifyYaml(value, [], [], layout)).toBe(`properties:
  ticket:
    {
      type: object,
      properties:
        {
          title:
            {
              type: [string, "null"],
              description: Short title. Must be at most 120 characters long.,
            },
        },
    }
required:
  [ticket, a_property_whose_name_runs_long, another_property_whose_name_runs]
`);
    const longer = { ...value, required: [...value.required, "and_one_more"] };
    expect(stringifyYaml(longer, [], [], layout).split("required:")[1]).toBe(`
  [
    ticket,
    a_property_whose_name_runs_long,
    another_property_whose_name_runs,
    and_one_more,
  ]
`);
  });

  it("spreads a collection a fix puts around one the file spread, so that one keeps its lines", () => {
    const { layout } = readYaml('{\n  "type": "array",\n  "items": {\n    "type": "string"\n  }\n}\n');
    // Where openai/root-object moves what the root said about its value.
    const flows = layout.flows.map((flow) => (flow.pointer === "/items" ? { ...flow, pointer: "/properties/result/items" } : flow));
    const value = {
      type: "object",
      properties: { result: { type: "array", items: { type: "string" } } },
      required: ["result"],
      additionalProperties: false,
    };
    expect(stringifyYaml(value, [], [], { ...layout, flows })).toBe(`{
  type: object,
  properties: {
    result: {
      type: array,
      items: {
        type: string
      }
    }
  },
  required: [result],
  additionalProperties: false
}
`);
  });

  it("puts a comment inside a collection spread over lines on its key's line or above it, as for one on a line", () => {
    const { value, attached, layout } = readYaml(`anyOf: # the two shapes
  [
    # a string first
    { type: string },
    { type: integer },
  ]
`);
    expect(stringifyYaml(value, attached, [], layout)).toBe(`# a string first
anyOf: # the two shapes
  [
    { type: string },
    { type: integer },
  ]
`);
  });

  it("writes in block style a collection spread over lines that would close under its key in a block mapping", () => {
    // Inside a JSON document a closing bracket may sit under its key, and in a block mapping it may not.
    const json = { entries: 2, close: 0, trailing: false };
    const layout = { flows: [{ pointer: "/required", kind: "sequence" as const, padded: false, width: 15, spread: json }] };
    expect(stringifyYaml({ type: "object", required: ["id", "name"] }, [], [], layout)).toBe(`type: object
required:
  - id
  - name
`);
  });

  it("keeps a flow collection the file wrapped over lines on those lines", () => {
    // What yaml.safe_dump(schema, default_flow_style=None) writes, a hand-wrapped list, and
    // collections with several entries to a line.
    const text = `properties:
  category:
    type: string
    enum: [billing, outage, feature-request, account, security, integrations, performance,
      other]
  owner:
    type: [string,
      "null"]
  status:
    anyOf:
      [
        {type: string}, {type: integer},
        {type: "null"},
      ]
  steps:
    - [ open, triaged,
        closed ]
required:
  [category, owner,
   status, steps]
`;
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("keeps a document the file wrote as one flow mapping wrapped over lines on those lines", () => {
    const { value, layout } = readYaml("{type: object, properties: {a: {type: string}},\n  required: [a]}\n");
    expect(stringifyYaml({ ...(value as object), additionalProperties: false }, [], [], layout)).toBe(
      "{type: object, properties: {a: {type: string}},\n  required: [a], additionalProperties: false}\n",
    );
  });

  it("fills the last line of a wrapped collection with what a fix adds, and wraps it where the file's longest line ends", () => {
    const { layout } = readYaml(`required: [category, priority,
  title]
anyOf: [
    {type: string},
    {type: integer}, {type: boolean}
  ]
`);
    const value = {
      required: ["category", "priority", "title", "assignee", "a_property_whose_name_runs_long"],
      anyOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }, { type: "null" }],
    };
    // The entry that gains a comma keeps its line, though the comma takes that line past the longest.
    expect(stringifyYaml(value, [], [], layout)).toBe(`required: [category, priority,
  title, assignee,
  a_property_whose_name_runs_long]
anyOf: [
    {type: string},
    {type: integer}, {type: boolean},
    {type: "null"}
  ]
`);
  });

  it("starts a new line of a wrapped collection before an entry a fix lengthened past the file's longest line", () => {
    const { layout } = readYaml("anyOf: [{type: string}, {type: integer},\n  {type: boolean}]\n");
    const value = { anyOf: [{ type: "string" }, { type: ["integer", "null"], description: "A count" }, { type: "boolean" }] };
    expect(stringifyYaml(value, [], [], layout)).toBe(`anyOf: [{type: string},
  {type: [integer, "null"], description: A count},
  {type: boolean}]
`);
  });

  it("writes a wrapped collection that would not read back on its lines as any other flow collection the file held", () => {
    // A closing bracket under its key, which a block mapping does not allow.
    const wrap = { lines: [0, 2], entries: 2, close: 0, trailing: false, width: 10 };
    const layout = { flows: [{ pointer: "/required", kind: "sequence" as const, padded: false, width: 11, wrap }] };
    expect(stringifyYaml({ type: "object", required: ["id", "name"] }, [], [], layout)).toBe("type: object\nrequired: [id, name]\n");
  });

  it("keeps a schema yaml.safe_dump wrote as one flow mapping on the lines it wrote, the collections and descriptions wrapped inside it included", () => {
    // What yaml.safe_dump(schema, default_flow_style=True, sort_keys=False) writes.
    const text = `{type: object, description: 'A support ticket as the customer filed it, and the state
    it is in now.', properties: {status: {type: string, enum: [open, pending, closed]},
    assignee: {type: string, description: Who to assign it to. Omit to leave it in
        the queue for triage.}, labels: {type: array, items: {type: string, enum: [
          bug, feature, question, duplicate]}}}, required: [status]}
`;
    const { value, layout } = readYaml(text);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("follows a collection wrapped inside another on its last line with what a fix adds, and starts a line at the column of the collection's depth", () => {
    const { value, layout } = readYaml(`{type: object, properties: {status: {type: string, enum: [open, pending, closed]},
    assignee: {type: string, description: Who to assign it to. Omit to leave it in
        the queue for triage.}}, required: [status]}
`);
    const schema = value as { properties: { assignee: { type: unknown } }; required: string[] };
    schema.properties.assignee.type = ["string", "null"];
    // A line the file started stays started, the description keeps its lines, and a collection
    // whose entries start no line starts one two columns further in than the collection it is in,
    // as PyYAML indents each it nests: the root at 2, `assignee` inside `properties` at 6.
    expect(stringifyYaml({ ...schema, required: ["status", "assignee"], additionalProperties: false }, [], [], layout)).toBe(
      `{type: object, properties: {status: {type: string, enum: [open, pending, closed]},
    assignee: {type: [string, "null"],
      description: Who to assign it to. Omit to leave it in
        the queue for triage.}}, required: [status, assignee],
  additionalProperties: false}
`,
    );
  });

  it("wraps a sentence a fix added to a plain or quoted scalar wrapped inside a flow collection on the lines the file wrapped it on", () => {
    // What yaml.safe_dump(schema, default_flow_style=True, sort_keys=False) writes.
    const { layout } = readYaml(`{type: object, properties: {code: {type: string, description: The short code the warehouse
        prints on the label of every parcel it ships., maxLength: 8}, note: {type: string,
      description: 'Anything the courier should know, such as a gate code or a safe
        place to leave it.', minLength: 1}}, required: [code, note], additionalProperties: false}
`);
    const value = {
      type: "object",
      properties: {
        code: { type: "string", description: "The short code the warehouse prints on the label of every parcel it ships. Must be at most 8 characters long." },
        note: { type: "string", description: "Anything the courier should know, such as a gate code or a safe place to leave it. Must be at least 1 character long." },
      },
      required: ["code", "note"],
      additionalProperties: false,
    };
    expect(stringifyYaml(value, [], [], layout)).toBe(`{type: object, properties: {code: {type: string, description: The short code the warehouse
        prints on the label of every parcel it ships. Must be at most 8 characters long.},
    note: {type: string,
      description: 'Anything the courier should know, such as a gate code or a safe
        place to leave it. Must be at least 1 character long.'}}, required: [code, note],
  additionalProperties: false}
`);
  });

  it("writes a plain scalar wrapped inside a flow collection on one line, quoted, once a fix adds a comma to it", () => {
    const { layout } = readYaml("{type: string, description: The page the\n    ticket links to, format: uri}\n");
    const value = { type: "string", description: "The page the ticket links to Must be an absolute URI, such as https://example.com/a." };
    expect(stringifyYaml(value, [], [], layout)).toBe(
      '{type: string,\n  description: "The page the ticket links to Must be an absolute URI, such as https://example.com/a."}\n',
    );
  });

  it("quotes a string holding a '?' inside a flow collection, which PyYAML ends a plain scalar at", () => {
    // What yaml.safe_dump(schema, default_flow_style=None, sort_keys=False) writes: PyYAML quotes
    // the description, and `yaml.safe_load` fails on `{..., description: Is it urgent?}`.
    const { value, layout } = readYaml("type: object\nproperties:\n  urgent: {type: boolean, description: 'Is it urgent?'}\n");
    expect(stringifyYaml({ ...(value as object), additionalProperties: false }, [], [], layout)).toBe(
      'type: object\nproperties:\n  urgent: {type: boolean, description: "Is it urgent?"}\nadditionalProperties: false\n',
    );
    // A key holding one, and a '?' in block context, which ends nothing there.
    expect(stringifyYaml({ items: { "why?": "yes or no?" }, description: "Is it urgent?" }, [], [], readYaml("items: {a: b}\n").layout)).toBe(
      'items: {"why?": "yes or no?"}\ndescription: Is it urgent?\n',
    );
  });

  it("writes a plain scalar holding a '?' that a file wrapped inside a flow collection on one line, quoted", () => {
    // YAML 1.2 reads the '?' as a character, so this reader does, but PyYAML refuses the file.
    const { value, layout } = readYaml("{type: string, description: Is the ticket\n    urgent? Say so here., maxLength: 80}\n");
    const { maxLength: _, ...rest } = value as { description: string; maxLength: number };
    const fixed = { ...rest, description: `${rest.description} Must be at most 80 characters long.` };
    expect(stringifyYaml(fixed, [], [], layout)).toBe(
      '{type: string,\n  description: "Is the ticket urgent? Say so here. Must be at most 80 characters long."}\n',
    );
  });

  it("writes a value as it would any other where the sequence the file held there is gone", () => {
    const { layout } = readYaml("type:\n  - string\n  - 'null'\n");
    expect(stringifyYaml({ type: "string" }, [], [], layout)).toBe("type: string\n");
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
        style: ">",
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

  it("keeps a fold that no longer matches the value out of the way of a value that is not a string", () => {
    const { layout } = readYaml("d: >\n  one\n  two\n");
    expect(stringifyYaml({ d: { type: "string" } }, [], [], layout)).toBe("d:\n  type: string\n");
  });

  it("writes a plain scalar spread over lines back on the lines the file wrapped it on", () => {
    const text = `query:
  description: Words to look for in the title and the body, which
    the server matches case-insensitively.
tags:
- one tag that runs on
  over a second line

  and a paragraph after it
`;
    const { value, layout } = readYaml(text);
    expect(layout.folds).toEqual([
      {
        pointer: "/query/description",
        style: "plain",
        lines: ["Words to look for in the title and the body, which", "the server matches case-insensitively."],
      },
      { pointer: "/tags/0", style: "plain", lines: ["one tag that runs on", "over a second line", "", "and a paragraph after it"] },
    ]);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("wraps a sentence a fix added to a plain scalar spread over lines where the file's longest line ends", () => {
    const { layout } = readYaml("d: The number of results to return, counted\n  from the first match.\n");
    const description = "The number of results to return, counted from the first match. Must be at least 1. Must be at most 50.";
    expect(stringifyYaml({ d: description }, [], [], layout)).toBe(`d: The number of results to return, counted
  from the first match. Must be at least 1.
  Must be at most 50.
`);
  });

  it.each([
    ["a string the fix did not extend", "Something else entirely."],
    ["a string whose first line would read as an indicator", "- one two"],
  ])("writes %s that the file's lines cannot hold as any other string", (_, d) => {
    const layout = { folds: [{ pointer: "/d", style: "plain" as const, lines: d.startsWith("-") ? ["- one", "two"] : ["one", "two"] }] };
    const written = stringifyYaml({ d }, [], [], layout);
    expect(written).toBe(stringifyYaml({ d }));
    expect(parseYaml(written)).toEqual({ d });
  });

  it("puts a comment after a plain or quoted scalar spread over lines after its last line, where the scalar ends", () => {
    const text = `query:
  description: Words to look for in the title and the body, which
    the server matches case-insensitively. # from the API docs
  examples:
  - one example that runs on
    over a second line # the first
  - "a quoted one that runs
    on as well" # the second
sort:
  anyOf:
  - description: 'The field to sort by, which the server
      reads case-insensitively.' # after the dash
    type: string
  - - title: a sequence in a sequence
        over two lines # after both dashes
`;
    const { value, attached, layout } = readYaml(text);
    expect(attached.map(({ pointer, trailing }) => [pointer, trailing])).toEqual([
      ["/query/description", true],
      ["/query/examples/0", true],
      ["/query/examples/1", true],
      ["/sort/anyOf/0", true],
      ["/sort/anyOf/1", true],
    ]);
    expect(stringifyYaml(value, attached, [], layout)).toBe(text);
  });

  it("puts a comment after the sentence a fix added to a plain scalar spread over lines", () => {
    const { attached, layout } = readYaml("d: The number of results to return, counted\n  from the first match. # the page size\n");
    const description = "The number of results to return, counted from the first match. Must be at least 1. Must be at most 50.";
    expect(stringifyYaml({ d: description }, attached, [], layout)).toBe(`d: The number of results to return, counted
  from the first match. Must be at least 1.
  Must be at most 50. # the page size
`);
  });

  it.each([
    ["spread over lines", [{ pointer: "/d", style: "plain" as const, lines: ["one", 'say "hi'] }], 'd: one\n  say "hi\n'],
    ["on one line", [], 'd: one say "hi\n'],
  ])("keeps a comment after a plain scalar %s that holds an unclosed quote", (_, folds, entry) => {
    // A quote in the middle of a plain scalar opens nothing, so the "#" after it starts a comment.
    const d = 'one say "hi';
    const comments = [{ line: 2, text: "# a note", pointer: "/d", trailing: true }];
    const written = stringifyYaml({ d }, comments, [], { folds });
    expect(written).toBe(`${entry.slice(0, -1)} # a note\n`);
    const lines = entry.split("\n").length - 1;
    expect(readYaml(written)).toMatchObject({
      value: { d },
      attached: [{ line: lines, text: "# a note", pointer: "/d", trailing: true }],
    });
  });

  it("writes a quoted scalar spread over lines back on the lines the file wrapped it on, escapes and all", () => {
    const text = `query:
  description: "Words to look for, \\"quoted\\" or\\tnot, which
    the server   matches\\
    case-insensitively.

    A second paragraph."
tags:
- 'one tag that''s
  wrapped'
`;
    const { value, layout } = readYaml(text);
    expect(value).toEqual({
      query: { description: 'Words to look for, "quoted" or\tnot, which the server   matchescase-insensitively.\nA second paragraph.' },
      tags: ["one tag that's wrapped"],
    });
    expect(layout.folds).toEqual([
      {
        pointer: "/query/description",
        style: '"',
        lines: ['"Words to look for, \\"quoted\\" or\\tnot, which', "the server   matches\\", "case-insensitively.", "", 'A second paragraph."'],
      },
      { pointer: "/tags/0", style: "'", lines: ["'one tag that''s", "wrapped'"] },
    ]);
    expect(stringifyYaml(value, [], [], layout)).toBe(text);
  });

  it("leaves a quoted scalar that closes on the line it opens on out of the folds", () => {
    expect(readYaml('d: "one # two" # three\ne: \'x\'\n').layout.folds).toEqual([]);
  });

  it.each([
    ['"', 'd: "The number of results to return, counted\n  from the first match."\n', ' Must be "at least" 1. Must be at most 50.', 'd: "The number of results to return, counted\n  from the first match. Must be \\"at least\\"\n  1. Must be at most 50."\n'],
    ["'", "d: 'The number of results to return, counted\n  from the first match.'\n", " Must be 'at least' 1. Must be at most 50.", "d: 'The number of results to return, counted\n  from the first match. Must be ''at least''\n  1. Must be at most 50.'\n"],
  ])("wraps a sentence a fix added to a %s-quoted scalar before its closing quote, escaped for those quotes", (_, text, sentence, expected) => {
    const { value, layout } = readYaml(text);
    const d = `${(value as { d: string }).d}${sentence}`;
    const written = stringifyYaml({ d }, [], [], layout);
    expect(written).toBe(expected);
    expect(parseYaml(written)).toEqual({ d });
  });

  it.each([
    ['"', "its closing quote on a line of its own", 'd: "The number of results to return, counted\n  from the first match.\n  "\n', 'd: "The number of results to return, counted\n  from the first match. Must be at least 1.\n  Must be at most 50."\n'],
    ["'", "an empty line above its closing quote", "d: 'The number of results to return, counted\n  from the first match.\n\n  '\n", "d: 'The number of results to return, counted\n  from the first match. Must be at least 1.\n  Must be at most 50.'\n"],
    ['"', "spaces before its closing quote", 'd: "The number of results to return, counted\n  from the first match.   "\n', 'd: "The number of results to return, counted\n  from the first match. Must be at least 1.\n  Must be at most 50."\n'],
  ])("puts a sentence a fix added to a %s-quoted scalar with %s before that quote", (_, __, text, expected) => {
    const { value, layout } = readYaml(text);
    // A fix trims the description before it adds its sentence, which takes off the white space it ends in.
    const d = `${(value as { d: string }).d.trim()} Must be at least 1. Must be at most 50.`;
    const written = stringifyYaml({ d }, [], [], layout);
    expect(written).toBe(expected);
    expect(parseYaml(written)).toEqual({ d });
  });

  it("writes a string the file's quoted lines cannot hold as any other string", () => {
    const d = "Something else entirely.";
    const layout = { folds: [{ pointer: "/d", style: '"' as const, lines: ['"one', 'two"'] }] };
    const written = stringifyYaml({ d }, [], [], layout);
    expect(written).toBe(stringifyYaml({ d }));
    expect(parseYaml(written)).toEqual({ d });
  });

  it("puts a comment after the closing quote of a sentence a fix added to a quoted scalar spread over lines", () => {
    const { attached, layout } = readYaml("d: 'The number of results to return, counted\n  from the first match.' # the page size\n");
    const description = "The number of results to return, counted from the first match. Must be at least 1. Must be at most 50.";
    expect(stringifyYaml({ d: description }, attached, [], layout)).toBe(`d: 'The number of results to return, counted
  from the first match. Must be at least 1.
  Must be at most 50.' # the page size
`);
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
