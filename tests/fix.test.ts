import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/index.js";
import { fix, lint, rewrap, unwrap } from "../src/index.js";
import { resolvePointer, setPointer } from "../src/pointer.js";
import { strictObject } from "./helpers.js";

describe("setPointer", () => {
  it("replaces a nested value in place", () => {
    const root = { properties: { name: { type: "string" } } };
    expect(setPointer(root, "/properties/name", { type: "number" })).toBe(true);
    expect(root.properties.name).toEqual({ type: "number" });
  });

  it("replaces an array element", () => {
    const root = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(setPointer(root, "/anyOf/1", { type: "null" })).toBe(true);
    expect(root.anyOf[1]).toEqual({ type: "null" });
  });

  it("refuses the root pointer and pointers that do not resolve", () => {
    const root = { properties: {} };
    expect(setPointer(root, "", { type: "string" })).toBe(false);
    expect(setPointer(root, "/nowhere/deep", 1)).toBe(false);
    expect(setPointer({ anyOf: [] }, "/anyOf/3", 1)).toBe(false);
  });
});

describe("fix", () => {
  const nested = {
    type: "object",
    properties: {
      user: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    required: ["user"],
  };

  it("adds additionalProperties: false at every level", () => {
    const result = fix(nested, { providers: ["openai"] });
    expect(result.schema).toEqual({
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
      required: ["user"],
      additionalProperties: false,
    });
    expect(result.applied.map((item) => item.path)).toEqual(["/properties/user", ""]);
    expect(result.applied[0]).toMatchObject({ ruleId: "openai/additional-properties-false", provider: "openai" });
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(nested);
    fix(nested, { providers: ["openai"] });
    expect(JSON.stringify(nested)).toBe(before);
  });

  it("produces a schema that no longer reports the fixed rule", () => {
    const { schema } = fix(nested, { providers: ["anthropic"] });
    const ruleIds = lint(schema, { providers: ["anthropic"] }).findings.map((finding) => finding.ruleId);
    expect(ruleIds).not.toContain("anthropic/additional-properties-false");
  });

  it("replaces an additionalProperties subschema with false", () => {
    const { schema } = fix(
      { type: "object", properties: {}, additionalProperties: { type: "string" } },
      { providers: ["openai"] },
    );
    expect(schema.additionalProperties).toBe(false);
  });

  it("reports the findings it cannot fix and applies nothing for them", () => {
    const result = fix(
      {
        type: "object",
        properties: { id: { allOf: [{ type: "string" }, { type: "number" }] } },
        required: ["id"],
      },
      { providers: ["openai"] },
    );
    const remaining = result.findings.map((finding) => finding.ruleId);
    expect(remaining).toContain("openai/unsupported-composition");
    expect(remaining).not.toContain("openai/additional-properties-false");
    expect(result.summary[0]?.errors).toBe(remaining.length);
  });

  it("renames oneOf to anyOf, at every depth and in place", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: {
            description: "A string or a number.",
            oneOf: [{ type: "string" }, { oneOf: [{ type: "integer" }, { type: "number" }] }],
            title: "Id",
          },
        },
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      id: {
        description: "A string or a number.",
        anyOf: [{ type: "string" }, { anyOf: [{ type: "integer" }, { type: "number" }] }],
        title: "Id",
      },
    });
    // The rename keeps the keyword where it was, so the schema still reads in its original order.
    expect(Object.keys(resolvePointer(schema, "/properties/id") as object)).toEqual(["description", "anyOf", "title"]);
    expect(applied.map((item) => item.path)).toEqual(["/properties/id/oneOf/1", "/properties/id"]);
    expect(applied[0]?.title).toBe('Rename "oneOf" to "anyOf".');
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a oneOf that sits next to an anyOf for a human", () => {
    const union = { anyOf: [{ type: "string" }], oneOf: [{ type: "integer" }] };
    const result = fix(
      { type: "object", additionalProperties: false, required: ["id"], properties: { id: union } },
      { providers: ["openai"] },
    );

    expect(result.schema.properties).toEqual({ id: union });
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["openai/no-one-of"]);
  });

  it("merges an allOf of objects into the object that holds it", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        description: "A ticket.",
        allOf: [
          {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "Tracking fields.",
            properties: { opened_at: { type: "string", format: "date-time" } },
            required: ["opened_at"],
          },
        ],
      },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      type: "object",
      description: "A ticket. Tracking fields.",
      properties: { id: { type: "string" }, opened_at: { type: "string", format: "date-time" } },
      required: ["id", "opened_at"],
      additionalProperties: false,
    });
    expect(applied.map((item) => item.title)).toContain('Merge the 2 "allOf" branches into the object.');
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("inlines the definition behind a bare $ref branch and merges it in", () => {
    const { schema, applied } = fix(
      strictObject(
        { reporter: { allOf: [{ $ref: "#/$defs/user" }], description: "Who filed it." } },
        { $defs: { user: strictObject({ name: { type: "string" } }) } },
      ),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      reporter: {
        description: "Who filed it.",
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    });
    expect(applied.map((item) => item.title)).toEqual([
      'Merge the "allOf" branch into the object, inlining #/$defs/user.',
      "Remove #/$defs/user, which nothing references any more.",
    ]);
    // Inlining was the definition's last use, so the empty "$defs" map goes with it.
    expect(schema).not.toHaveProperty("$defs");
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("inlines a definition that describes a string and prunes it once it is merged", () => {
    const { schema, applied } = fix(
      strictObject(
        { priority: { allOf: [{ $ref: "#/$defs/Priority" }], description: "How urgent the ticket is." } },
        { $defs: { Priority: { type: "string", enum: ["low", "normal", "high"] } } },
      ),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      priority: {
        description: "How urgent the ticket is.",
        type: "string",
        enum: ["low", "normal", "high"],
      },
    });
    expect(applied.map((item) => item.title)).toEqual([
      'Merge the "allOf" branch into the schema, inlining #/$defs/Priority.',
      "Remove #/$defs/Priority, which nothing references any more.",
    ]);
    expect(schema).not.toHaveProperty("$defs");
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("merges an allOf of scalar constraints down to what every branch allows", () => {
    const { schema } = fix(
      strictObject({
        score: { type: "integer", allOf: [{ minimum: 1, maximum: 100 }, { minimum: 10, maximum: 50 }] },
        unit: { allOf: [{ type: "string", enum: ["C", "F", "K"] }, { enum: ["C", "K"] }] },
      }),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      score: { type: "integer", minimum: 10, maximum: 50 },
      unit: { type: "string", enum: ["C", "K"] },
    });
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("keeps a definition that other parts of the schema still reach", () => {
    const { schema, applied } = fix(
      strictObject(
        { reporter: { allOf: [{ $ref: "#/$defs/user" }] }, owner: { $ref: "#/$defs/account" } },
        {
          $defs: {
            user: strictObject({ name: { type: "string" } }),
            account: strictObject({ id: { type: "string" } }),
          },
        },
      ),
      { providers: ["openai"] },
    );

    // Only the inlined definition goes; the map stays for the one still in use.
    expect(schema.$defs).toEqual({ account: strictObject({ id: { type: "string" } }) });
    expect(applied.map((item) => item.path)).toContain("/$defs/user");
  });

  it("prunes a definition once the last reference to it is inlined", () => {
    const { schema, applied } = fix(
      strictObject(
        { reporter: { allOf: [{ $ref: "#/$defs/user" }] }, assignee: { allOf: [{ $ref: "#/$defs/user" }] } },
        { $defs: { user: strictObject({ name: { type: "string" } }) } },
      ),
      { providers: ["openai"] },
    );

    expect(schema).not.toHaveProperty("$defs");
    // The copy is reported once: the first merge leaves the other reference behind.
    expect(applied.filter((item) => item.path === "/$defs/user")).toHaveLength(1);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("never removes a property an allOf branch referenced, only a definition", () => {
    const { schema } = fix(
      strictObject({
        base: strictObject({ id: { type: "string" } }),
        ticket: { allOf: [{ $ref: "#/properties/base" }] },
      }),
      { providers: ["openai"] },
    );

    // A local $ref can point anywhere. "base" is a property of the object, not a definition,
    // so inlining it must not take it out of the schema.
    expect(schema.properties).toHaveProperty("base");
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it.each(["$defs", "definitions"])("keeps what a property named %s describes", (name) => {
    const items = strictObject({ a: { type: "string" } });
    const { schema, applied } = fix(
      strictObject({
        [name]: { type: "array", items },
        ticket: { allOf: [{ $ref: `#/properties/${name}/items` }] },
      }),
      { providers: ["openai"] },
    );

    // The last two tokens of #/properties/$defs/items spell a definition entry, but the map
    // they sit in is the object's "properties", not a definition map, so "items" is a
    // constraint the schema declares and pruning it would widen what the schema accepts.
    expect((schema.properties as Record<string, JsonSchema>)[name]).toEqual({ type: "array", items });
    expect(applied.map((item) => item.path)).not.toContain(`/properties/${name}/items`);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("prunes a definition map that belongs to a nested subschema", () => {
    const { schema, applied } = fix(
      strictObject({
        ticket: {
          ...strictObject({ reporter: { allOf: [{ $ref: "#/properties/ticket/$defs/user" }] } }),
          $defs: { user: strictObject({ name: { type: "string" } }) },
        },
      }),
      { providers: ["openai"] },
    );

    // Here "$defs" is the keyword, and its owner #/properties/ticket is a subschema, so the
    // entry is a definition and goes once its last reference is inlined.
    expect((schema.properties as Record<string, JsonSchema>).ticket).not.toHaveProperty("$defs");
    expect(applied.map((item) => item.path)).toContain("/properties/ticket/$defs/user");
  });

  it("leaves an unused definition the fix never touched alone", () => {
    const unused = strictObject({ code: { type: "string" } });
    const { schema } = fix(
      strictObject({ reporter: { allOf: [{ $ref: "#/$defs/user" }] } }, { $defs: { user: strictObject({ name: { type: "string" } }), unused } }),
      { providers: ["openai"] },
    );

    // Pruning follows the fix, so a definition nobody referenced to begin with is not the
    // fix's to remove.
    expect(schema.$defs).toEqual({ unused });
  });

  describe("pruneUnusedDefs", () => {
    const withOrphans = (): JsonSchema =>
      strictObject(
        { user: { $ref: "#/$defs/user" } },
        {
          $defs: {
            user: strictObject({ name: { type: "string" } }),
            legacy: strictObject({ code: { $ref: "#/$defs/code" } }),
            code: { type: "string" },
          },
        },
      );

    it("removes a definition the input left unreferenced, and what only it referenced", () => {
      const { schema, applied } = fix(withOrphans(), { providers: ["openai"], pruneUnusedDefs: true });

      // "code" is reachable only through "legacy", so it is an orphan as soon as "legacy" goes.
      expect(schema.$defs).toEqual({ user: strictObject({ name: { type: "string" } }) });
      expect(applied.map((item) => item.path)).toEqual(["/$defs/legacy", "/$defs/code"]);
      expect(applied[0]).toEqual({ path: "/$defs/legacy", title: "Remove #/$defs/legacy, which nothing references." });
    });

    it("keeps every definition when the option is off", () => {
      const before = withOrphans();
      const { schema, applied } = fix(before, { providers: ["openai"] });
      expect(schema.$defs).toEqual(before.$defs);
      expect(applied).toEqual([]);
    });

    it("removes the definition map it empties, at any depth", () => {
      const { schema } = fix(
        strictObject({ ticket: { ...strictObject({ id: { type: "string" } }), $defs: { unused: { type: "string" } } } }),
        { providers: ["openai"], pruneUnusedDefs: true },
      );
      expect((schema.properties as Record<string, JsonSchema>).ticket).not.toHaveProperty("$defs");
    });

    it("removes a draft-07 \"definitions\" entry too", () => {
      const { schema } = fix(strictObject({ id: { type: "string" } }, { definitions: { unused: { type: "string" } } }), {
        providers: ["openai"],
        pruneUnusedDefs: true,
      });
      expect(schema).not.toHaveProperty("definitions");
    });

    it("keeps a definition that only a fix stopped referencing, reporting it as the fix's", () => {
      const { schema, applied } = fix(
        strictObject({ reporter: { allOf: [{ $ref: "#/$defs/user" }] } }, { $defs: { user: strictObject({ name: { type: "string" } }) } }),
        { providers: ["openai"], pruneUnusedDefs: true },
      );

      // The fix's own prune runs first, so the removal still names the rule that caused it.
      expect(schema).not.toHaveProperty("$defs");
      expect(applied.find((item) => item.path === "/$defs/user")).toMatchObject({
        ruleId: "openai/unsupported-composition",
        title: "Remove #/$defs/user, which nothing references any more.",
      });
    });

    it.each([
      ["an anchor reference", { $ref: "#user" }],
      ["a $dynamicRef", { $dynamicRef: "#node" }],
      ["a $recursiveRef that resolves to nothing", { $recursiveRef: "#node" }],
      ["an external reference", { $ref: "https://example.com/user.json" }],
      ["a $ref that resolves to nothing", { $ref: "#/$defs/typo" }],
    ])("prunes nothing when the schema holds %s", (_name, reference) => {
      const $defs = { user: strictObject({ name: { type: "string" } }) };
      const { schema } = fix(strictObject({ user: reference as JsonSchema }, { $defs }), {
        providers: ["openai"],
        pruneUnusedDefs: true,
      });

      // The reference cannot be followed, so "user" only looks unreferenced.
      expect(schema.$defs).toEqual($defs);
    });

    it("prunes nothing below a subschema that re-bases references with its own $id", () => {
      const inner = { ...strictObject({ name: { type: "string" } }), $id: "https://example.com/user" };
      const { schema } = fix(strictObject({ user: { $ref: "#/$defs/user" } }, { $defs: { user: inner, spare: { type: "string" } } }), {
        providers: ["openai"],
        pruneUnusedDefs: true,
      });
      expect(schema.$defs).toHaveProperty("spare");
    });

    it.each([
      [
        'draft-07 "dependencies"',
        { dependencies: { card: { $ref: "#/definitions/billing" } } },
      ],
      [
        "a contentSchema",
        { contentMediaType: "application/json", contentSchema: { $ref: "#/definitions/billing" } },
      ],
    ])("prunes nothing when a reference sits under %s, which walk() does not visit", (_name, holder) => {
      const definitions = { billing: strictObject({ address: { type: "string" } }) };
      const { schema, applied } = fix(
        { ...strictObject({ card: { type: "string" } }), ...(holder as JsonSchema), definitions },
        { providers: ["openai"], pruneUnusedDefs: true },
      );

      // Neither keyword is one walk() descends into, so the reference is invisible to the
      // walker and "billing" looks unreferenced. Removing it would hand back a schema whose
      // $ref points at nothing, under a title claiming nothing referenced it.
      expect(schema.definitions).toEqual(definitions);
      expect(applied).toEqual([]);
    });

    it("keeps a definition a reference walk() does not visit still needs", () => {
      const user = strictObject({ name: { type: "string" } });
      const { schema } = fix(
        {
          ...strictObject({ reporter: { allOf: [{ $ref: "#/$defs/user" }] } }),
          dependencies: { reporter: { $ref: "#/$defs/user" } },
          $defs: { user },
        },
        { providers: ["openai"], pruneUnusedDefs: true },
      );

      // The allOf fix inlines its own reference and names #/$defs/user as an orphan it may
      // have made. The reference under "dependencies" is the one still holding it in place.
      expect(schema.$defs).toEqual({ user });
    });

    it.each(["$defs", "definitions"])("keeps a property named %s, which is not a definition map", (name) => {
      const property = strictObject({ code: { type: "string" } });
      const { schema, applied } = fix(strictObject({ [name]: property }), { providers: ["openai"], pruneUnusedDefs: true });

      // Nothing references #/properties/$defs/properties/code either, but "properties" is a
      // map of names, not a definition map, so everything below it is what the schema accepts.
      expect((schema.properties as Record<string, JsonSchema>)[name]).toEqual(property);
      expect(applied).toEqual([]);
    });
  });

  it("copies a definition the rest of the schema also references, and keeps it where it was", () => {
    const user = strictObject({ name: { type: "string" } });
    const { schema, applied } = fix(
      strictObject(
        { reporter: { allOf: [{ $ref: "#/$defs/user" }] }, assignee: { $ref: "#/$defs/user" } },
        { $defs: { user } },
      ),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      reporter: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      // The other reference still needs the definition, so it stays exactly as it was.
      assignee: { $ref: "#/$defs/user" },
    });
    expect(schema.$defs).toEqual({ user });
    // The copy shares nothing with the definition, so rewriting one never touches the other.
    const reporter = (schema.properties as Record<string, JsonSchema>).reporter as JsonSchema;
    const original = (schema.$defs as Record<string, JsonSchema>).user as JsonSchema;
    expect(reporter.properties).not.toBe(original.properties);
    expect(applied.map((item) => item.title)).toContain(
      'Merge the "allOf" branch into the object, copying #/$defs/user, because the schema references it elsewhere too.',
    );
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("names the inlined and the copied definitions apart in one title", () => {
    const { applied } = fix(
      strictObject(
        {
          reporter: { allOf: [{ $ref: "#/$defs/user" }, { $ref: "#/$defs/badge" }] },
          assignee: { $ref: "#/$defs/user" },
        },
        {
          $defs: {
            user: strictObject({ name: { type: "string" } }),
            badge: strictObject({ colour: { type: "string" } }),
          },
        },
      ),
      { providers: ["openai"] },
    );

    expect(applied.map((item) => item.title)).toContain(
      'Merge the 2 "allOf" branches into the object, inlining #/$defs/badge, and copying #/$defs/user, ' +
        "because the schema references it elsewhere too.",
    );
  });

  it("leaves an allOf whose $ref branch is recursive alone", () => {
    const recursive = fix(
      strictObject(
        { tree: { allOf: [{ $ref: "#/$defs/node" }] } },
        { $defs: { node: strictObject({ child: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] } }) } },
      ),
      { providers: ["openai"] },
    );
    expect(recursive.schema.properties).toEqual({ tree: { allOf: [{ $ref: "#/$defs/node" }] } });
    expect(recursive.findings.map((finding) => finding.ruleId)).toContain("openai/unsupported-composition");
  });

  it("merges an allOf nested inside another one, deepest first", () => {
    const { schema, applied } = fix(
      strictObject({
        ticket: {
          type: "object",
          additionalProperties: false,
          allOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
              allOf: [{ type: "object", properties: { kind: { type: "string" } }, required: ["kind"] }],
            },
          ],
        },
      }),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      ticket: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, kind: { type: "string" } },
        required: ["id", "kind"],
      },
    });
    const merges = applied.filter((item) => item.ruleId === "openai/unsupported-composition");
    expect(merges.map((item) => item.path)).toEqual(["/properties/ticket/allOf/0", "/properties/ticket"]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves an allOf whose branches constrain the same property differently", () => {
    const intersection = {
      allOf: [
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    };
    const result = fix(strictObject({ ticket: intersection }), { providers: ["openai"] });

    expect(result.schema.properties).toMatchObject({ ticket: { allOf: intersection.allOf } });
    expect(result.applied.map((item) => item.ruleId)).not.toContain("openai/unsupported-composition");
    expect(result.findings.map((finding) => finding.ruleId)).toContain("openai/unsupported-composition");
  });

  it("requires every property and keeps the missing ones optional with null", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          score: { type: ["integer", "string"] },
          owner: { anyOf: [{ type: "string" }, { type: "integer" }] },
          reply: { $ref: "#/$defs/reply", description: "The last reply." },
        },
        required: ["id"],
        $defs: {
          reply: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
        },
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      id: { type: "string" },
      score: { type: ["integer", "string", "null"] },
      owner: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }] },
      reply: { description: "The last reply.", anyOf: [{ $ref: "#/$defs/reply" }, { type: "null" }] },
    });
    expect(schema.required).toEqual(["id", "score", "owner", "reply"]);
    expect(applied).toEqual([
      {
        ruleId: "openai/all-required",
        provider: "openai",
        path: "",
        title: 'Add score, owner, reply to "required", and "null" to the type of score, owner, reply.',
      },
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a property it cannot make nullable alone, and says so in the title", () => {
    const { schema, applied } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: { kind: { enum: ["a", "b"] }, at: { type: ["string", "null"] } },
        required: [],
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({ kind: { enum: ["a", "b"] }, at: { type: ["string", "null"] } });
    expect(schema.required).toEqual(["kind", "at"]);
    expect(applied[0]?.title).toBe('Add kind, at to "required".');
  });

  it("requires properties of nested objects and definitions too", () => {
    const { schema } = fix(
      {
        type: "object",
        additionalProperties: false,
        properties: { user: { type: "object", properties: { name: { type: "string" } } } },
        required: ["user"],
      },
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      user: {
        type: "object",
        properties: { name: { type: ["string", "null"] } },
        required: ["name"],
        additionalProperties: false,
      },
    });
  });

  it("moves Anthropic's unsupported numeric and string constraints into the description", () => {
    const { schema, applied } = fix(
      strictObject({
        score: { type: "integer", minimum: 100, maximum: 500, multipleOf: 5 },
        name: { type: "string", description: "The display name.", minLength: 1, maxLength: 80 },
      }),
      { providers: ["anthropic"] },
    );

    expect(schema.properties).toEqual({
      score: {
        type: "integer",
        description: "Must be at least 100. Must be at most 500. Must be a multiple of 5.",
      },
      name: {
        type: "string",
        description: "The display name. Must be at least 1 character long. Must be at most 80 characters long.",
      },
    });
    expect(applied.map((item) => item.title)).toEqual([
      'Remove "minimum" and state it in "description".',
      'Remove "maximum" and state it in "description".',
      'Remove "multipleOf" and state it in "description".',
      'Remove "minLength" and state it in "description".',
      'Remove "maxLength" and state it in "description".',
    ]);
    expect(lint(schema, { providers: ["anthropic"] }).findings).toEqual([]);
  });

  it("lowers minItems to 1 and describes the array constraints it drops", () => {
    const { schema, applied } = fix(
      strictObject({
        tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10, uniqueItems: true },
      }),
      { providers: ["anthropic"] },
    );

    expect(schema.properties).toEqual({
      tags: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Must have at least 2 items. Must have at most 10 items. Items must be unique.",
      },
    });
    expect(applied[0]?.title).toBe('Lower "minItems" to 1 and state the real minimum in "description".');
    expect(lint(schema, { providers: ["anthropic"] }).findings).toEqual([]);
  });

  it('drops a "uniqueItems": false that constrains nothing, without a note', () => {
    const { schema, applied } = fix(strictObject({ tags: { type: "array", items: {}, uniqueItems: false } }), {
      providers: ["anthropic"],
    });

    expect(schema.properties).toEqual({ tags: { type: "array", items: {} } });
    expect(applied.map((item) => item.title)).toEqual(['Remove "uniqueItems".']);
  });

  it("leaves a constraint it cannot put into words for a human", () => {
    // The draft-04 spelling, where exclusiveMinimum is a flag on minimum rather than a bound.
    const result = fix(strictObject({ n: { type: "number", exclusiveMinimum: true } }), {
      providers: ["anthropic"],
    });

    expect(result.schema.properties).toEqual({ n: { type: "number", exclusiveMinimum: true } });
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["anthropic/no-numeric-constraints"]);
  });

  it("drops an unsupported format and keeps what it required in the description", () => {
    const { schema, applied } = fix(
      strictObject({
        website: { type: "string", format: "uri", description: "Where to find them." },
        avatar: { type: "string", format: "uri-reference" },
        id: { type: "string", format: "uuid" },
      }),
      { providers: ["openai"] },
    );

    expect(schema.properties).toEqual({
      website: {
        type: "string",
        description: "Where to find them. Must be an absolute URI, such as https://example.com/a.",
      },
      avatar: { type: "string", description: "Must be a URI, absolute or relative." },
      // uuid is on OpenAI's documented list, so it stays.
      id: { type: "string", format: "uuid" },
    });
    expect(applied.map((item) => [item.path, item.title])).toEqual([
      ["/properties/website", 'Remove "format": "uri" and state it in "description".'],
      ["/properties/avatar", 'Remove "format": "uri-reference" and state it in "description".'],
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a format Gemini only leaves undocumented in place", () => {
    const portable = strictObject({ email: { type: "string", format: "email" } });
    const result = fix(portable, { providers: ["gemini"] });

    expect(result.schema).toEqual(portable);
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("gemini/undocumented-format");
  });

  it("wraps a union root in an object and keeps the definitions where refs find them", () => {
    const { schema, applied } = fix(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        description: "A ticket or an error.",
        anyOf: [{ $ref: "#/$defs/ticket" }, { $ref: "#/$defs/error" }],
        $defs: {
          ticket: strictObject({ id: { type: "string" } }),
          error: strictObject({ message: { type: "string" } }),
        },
      },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        result: {
          description: "A ticket or an error.",
          anyOf: [{ $ref: "#/$defs/ticket" }, { $ref: "#/$defs/error" }],
        },
      },
      required: ["result"],
      additionalProperties: false,
      $defs: {
        ticket: strictObject({ id: { type: "string" } }),
        error: strictObject({ message: { type: "string" } }),
      },
    });
    expect(applied).toEqual([
      {
        ruleId: "openai/root-object",
        provider: "openai",
        path: "",
        title: 'Wrap the root in an object with one property, "result".',
      },
    ]);
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("wraps an array root, and fixes what the wrapping exposes", () => {
    const { schema } = fix(
      { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      { providers: ["openai"] },
    );

    expect(schema).toEqual({
      type: "object",
      properties: {
        result: {
          type: "array",
          items: strictObject({ id: { type: "string" } }),
        },
      },
      required: ["result"],
      additionalProperties: false,
    });
    expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
  });

  it("leaves a root with nothing to wrap for a human", () => {
    const definitionsOnly = { $defs: { ticket: strictObject({ id: { type: "string" } }) } };
    const result = fix(definitionsOnly, { providers: ["openai"] });

    expect(result.schema).toEqual(definitionsOnly);
    expect(result.applied).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toContain("openai/root-object");
  });

  it("does nothing to a schema that is already compatible", () => {
    const portable = { type: "object", properties: {}, required: [], additionalProperties: false };
    const result = fix(portable, { providers: ["openai"] });
    expect(result.applied).toEqual([]);
    expect(result.schema).toEqual(portable);
  });

  it("rejects a non-object schema the way lint does", () => {
    expect(() => fix("nope")).toThrow(TypeError);
  });
});

describe("rewrap", () => {
  it("puts a fixed schema back into the tool definition it came from", () => {
    const tool = {
      name: "get_weather",
      description: "Look up the weather.",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    };
    const { schema, keys } = unwrap(tool);
    const { schema: fixed } = fix(schema, { providers: ["anthropic"] });
    const document = rewrap(tool, keys, fixed) as typeof tool;

    expect(document.name).toBe("get_weather");
    expect(document.description).toBe("Look up the weather.");
    expect(document.input_schema).toMatchObject({ additionalProperties: false });
    expect(tool.input_schema).not.toHaveProperty("additionalProperties");
  });

  it("returns the schema itself for a bare document", () => {
    const bare = { type: "object" };
    expect(rewrap(bare, [], { type: "string" })).toEqual({ type: "string" });
  });

  it("records where nested wrappers keep the schema", () => {
    const tool = { type: "function", function: { name: "f", parameters: { type: "object" } } };
    const { keys } = unwrap(tool);
    expect(keys).toEqual(["function", "parameters"]);
    expect(resolvePointer(rewrap(tool, keys, { type: "string" }), "/function/parameters")).toEqual({ type: "string" });
  });
});
