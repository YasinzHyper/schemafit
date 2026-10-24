import { describe, expect, it } from "vitest";
import { movedPointer } from "../src/moves.js";

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

  it("leaves a pointer alone for a fix that moves nothing", () => {
    const required = { ruleId: "openai/all-required", provider: "openai", path: "", title: "" } as const;
    expect(movedPointer("/properties/a/oneOf", "", required)).toBe("/properties/a/oneOf");
  });
});
