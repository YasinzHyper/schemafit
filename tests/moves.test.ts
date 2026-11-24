import { describe, expect, it } from "vitest";
import { movedPointer, pointerMover, rewrappedRoot } from "../src/moves.js";

const rename = { ruleId: "openai/no-one-of", provider: "openai", path: "/properties/status", title: "" } as const;
const wrap = { ruleId: "openai/root-object", provider: "openai", path: "", title: "" } as const;

describe("movedPointer", () => {
  it("follows a oneOf renamed to anyOf, and leaves its neighbours alone", () => {
    expect(movedPointer("/properties/status/oneOf", "", rename)).toBe("/properties/status/anyOf");
    expect(movedPointer("/properties/status/oneOf/1/const", "", rename)).toBe("/properties/status/anyOf/1/const");
    expect(movedPointer("/properties/status/oneOfs", "", rename)).toBe("/properties/status/oneOfs");
    expect(movedPointer("/properties/status/type", "", rename)).toBe("/properties/status/type");
  });

  it("moves what a wrapped root said about its value into the wrapper, and keeps the document keywords at the root", () => {
    expect(movedPointer("/items/type", "", wrap)).toBe("/properties/result/items/type");
    expect(movedPointer("/$defs/tag", "", wrap)).toBe("/$defs/tag");
    expect(movedPointer("/$schema", "", wrap)).toBe("/$schema");
  });

  it("reads the fix's path from the schema it applied to, inside a larger document", () => {
    expect(movedPointer("/tools/0/input_schema/type", "/tools/0/input_schema", wrap)).toBe("/tools/0/input_schema/properties/result/type");
    expect(movedPointer("/tools/0/input_schema", "/tools/0/input_schema", wrap)).toBe("/tools/0/input_schema");
    expect(movedPointer("/tools/1/input_schema/type", "/tools/0/input_schema", wrap)).toBe("/tools/1/input_schema/type");
  });

  it("moves what was said about a keyword folded into description onto the description", () => {
    const fold = { ruleId: "anthropic/no-string-length", provider: "anthropic", path: "/properties/code", title: 'Remove "maxLength" and state it in "description".' } as const;
    expect(movedPointer("/properties/code/maxLength", "", fold)).toBe("/properties/code/description");
    expect(movedPointer("/properties/code/minLength", "", fold)).toBe("/properties/code/minLength");
    expect(movedPointer("/properties/code/maxLength", "/tools/0/input_schema", fold)).toBe("/properties/code/maxLength");
    const format = { ruleId: "openai/unsupported-format", provider: "openai", path: "/items", title: 'Remove "format": "uri" and state it in "description".' } as const;
    expect(movedPointer("/tools/0/input_schema/items/format", "/tools/0/input_schema", format)).toBe("/tools/0/input_schema/items/description");
  });

  it("leaves a keyword the fix keeps or removes without describing it where it was", () => {
    const lowered = { ruleId: "anthropic/array-constraints", provider: "anthropic", path: "", title: 'Lower "minItems" to 1 and state the real minimum in "description".' } as const;
    expect(movedPointer("/minItems", "", lowered)).toBe("/minItems");
    const removed = { ruleId: "anthropic/array-constraints", provider: "anthropic", path: "", title: 'Remove "uniqueItems".' } as const;
    expect(movedPointer("/uniqueItems", "", removed)).toBe("/uniqueItems");
  });

  it("leaves a pointer alone for a fix that moves nothing", () => {
    const required = { ruleId: "openai/all-required", provider: "openai", path: "", title: "" } as const;
    expect(movedPointer("/properties/a/oneOf", "", required)).toBe("/properties/a/oneOf");
  });
});

describe("pointerMover", () => {
  it("is undefined for a fix that moves nothing, so a caller can pass over it", () => {
    const required = { ruleId: "openai/all-required", provider: "openai", path: "", title: "" } as const;
    const lowered = { ruleId: "anthropic/array-constraints", provider: "anthropic", path: "", title: 'Lower "minItems" to 1 and state the real minimum in "description".' } as const;
    expect(pointerMover("", required)).toBeUndefined();
    expect(pointerMover("", lowered)).toBeUndefined();
  });

  it("moves a pointer as movedPointer does for a fix that moves entries", () => {
    const fold = { ruleId: "anthropic/no-string-length", provider: "anthropic", path: "/properties/code", title: 'Remove "maxLength" and state it in "description".' } as const;
    expect(pointerMover("", fold)?.("/properties/code/maxLength")).toBe("/properties/code/description");
    expect(pointerMover("", rename)?.("/properties/status/oneOf/0")).toBe("/properties/status/anyOf/0");
    const wrapped = pointerMover("/tools/0/input_schema", wrap);
    expect(wrapped?.("/tools/0/input_schema/type")).toBe("/tools/0/input_schema/properties/result/type");
    expect(wrapped?.("/tools/0/input_schema/$defs/tag")).toBe("/tools/0/input_schema/$defs/tag");
    expect(wrapped?.("/tools/1/input_schema/type")).toBe("/tools/1/input_schema/type");
  });
});

describe("rewrappedRoot", () => {
  it("names the root openai/root-object wraps, inside a larger document too, and nothing for any other fix", () => {
    expect(rewrappedRoot("", wrap)).toBe("");
    expect(rewrappedRoot("/tools/0/input_schema", wrap)).toBe("/tools/0/input_schema");
    expect(rewrappedRoot("", rename)).toBeUndefined();
  });
});
