import { describe, expect, it } from "vitest";
import { resolvePointer } from "../src/pointer.js";
import { findRecursiveRefs, resolveLocalRef } from "../src/refs.js";
import { walk } from "../src/walk.js";

describe("walk", () => {
  it("visits the root and every subschema with its JSON Pointer", () => {
    const paths = walk({
      type: "object",
      properties: {
        list: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
      },
      $defs: { id: { type: "integer" } },
    }).map((node) => node.path);

    expect(paths).toEqual([
      "",
      "/properties/list",
      "/properties/list/items",
      "/properties/list/items/anyOf/0",
      "/properties/list/items/anyOf/1",
      "/$defs/id",
    ]);
  });

  it("does not mistake data for schemas", () => {
    const nodes = walk({
      type: "object",
      default: { properties: { fake: { minLength: 1 } } },
      enum: [{ items: { type: "string" } }],
      properties: { real: { const: { not: {} } } },
    });
    expect(nodes.map((node) => node.path)).toEqual(["", "/properties/real"]);
  });

  it("treats a property named like a keyword as a property", () => {
    const nodes = walk({ type: "object", properties: { properties: { type: "string" }, "a/b": { type: "string" } } });
    expect(nodes.map((node) => node.path)).toEqual(["", "/properties/properties", "/properties/a~1b"]);
  });

  it("skips boolean schemas", () => {
    expect(walk({ type: "object", additionalProperties: false, items: true })).toHaveLength(1);
  });
});

describe("refs", () => {
  it("resolves escaped and percent-encoded pointers", () => {
    const root = { $defs: { "a/b": { type: "string" }, "sp ace": { type: "number" } } };
    expect(resolvePointer(root, "/$defs/a~1b")).toEqual({ type: "string" });
    expect(resolveLocalRef(root, "#/$defs/sp%20ace")?.schema).toEqual({ type: "number" });
    expect(resolveLocalRef(root, "#/$defs/missing")).toBeUndefined();
    expect(resolveLocalRef(root, "https://example.com/schema.json")).toBeUndefined();
  });

  it("finds a self reference to the root", () => {
    const root = { type: "object", properties: { children: { type: "array", items: { $ref: "#" } } } };
    expect(findRecursiveRefs(root)).toEqual([{ path: "/properties/children/items", ref: "#" }]);
  });

  it("finds mutual recursion between definitions", () => {
    const root = {
      type: "object",
      properties: { a: { $ref: "#/$defs/a" } },
      $defs: {
        a: { type: "object", properties: { b: { $ref: "#/$defs/b" } } },
        b: { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
      },
    };
    expect(findRecursiveRefs(root)).toHaveLength(1);
  });

  it("does not flag a definition that is merely reused", () => {
    const root = {
      type: "object",
      properties: { from: { $ref: "#/$defs/point" }, to: { $ref: "#/$defs/point" } },
      $defs: { point: { type: "object", properties: { x: { type: "number" } } } },
    };
    expect(findRecursiveRefs(root)).toEqual([]);
  });
});
