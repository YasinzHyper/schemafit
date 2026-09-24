import { resolvePointer } from "../pointer.js";
import { resolveLocalRef } from "../refs.js";
import type { JsonSchema, Provider, Rule, RuleMeta } from "../types.js";
import { children, isJsonSchema, isObjectSchema, typesOf, walk } from "../walk.js";
import { additionalPropertiesFalse, allowedFormats, forbiddenKeywords } from "./shared.js";

const SOURCE = "https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas";
const VERIFIED = "2026-09-22";

const MAX_NESTING_LEVELS = 10;
const MAX_TOTAL_PROPERTIES = 5000;
const MAX_TOTAL_ENUM_VALUES = 1000;
const LARGE_ENUM_THRESHOLD = 250;
const LARGE_ENUM_MAX_CHARS = 15_000;
const MAX_STRING_BUDGET = 120_000;

const SUPPORTED_FORMATS = [
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
];

function meta(name: string, rest: Omit<RuleMeta, "id" | "provider" | "source" | "verified">): RuleMeta {
  return { id: `openai/${name}`, provider: "openai", source: SOURCE, verified: VERIFIED, ...rest };
}

/** The property the root is wrapped in, when it is not an object itself. */
const WRAPPER_KEY = "result";

/** Keywords that describe the document rather than what it accepts, and so stay at the root. */
const DOCUMENT_KEYWORDS = ["$schema", "$id"];
const DEFINITION_KEYWORDS = ["$defs", "definitions"];

/**
 * The root schema as the single required property of a strict object, which is the shape
 * the docs ask for. Definitions stay at the root, so `#/$defs/...` references still resolve;
 * everything the root said about the value it accepts moves inside, where it still says it.
 * Returns null when there is nothing to wrap — a root that carries only definitions.
 */
function wrappedRoot(schema: JsonSchema): JsonSchema | null {
  const before: JsonSchema = {};
  const after: JsonSchema = {};
  const inner: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (DOCUMENT_KEYWORDS.includes(keyword)) before[keyword] = value;
    else if (DEFINITION_KEYWORDS.includes(keyword)) after[keyword] = value;
    else inner[keyword] = value;
  }
  if (Object.keys(inner).length === 0) return null;

  return {
    ...before,
    type: "object",
    properties: { [WRAPPER_KEY]: inner },
    required: [WRAPPER_KEY],
    additionalProperties: false,
    ...after,
  };
}

const rootObject: Rule = {
  ...meta("root-object", {
    severity: "error",
    summary: "The root schema must be an object and must not use anyOf.",
    fixable: true,
    notes:
      `The fix wraps the root in an object with one required property, "${WRAPPER_KEY}", and the model then ` +
      `returns { "${WRAPPER_KEY}": ... } instead of the bare value, so the code that reads the response has to ` +
      "unwrap it. Definitions stay at the root, where references to them keep resolving. A root that carries " +
      "nothing but definitions has nothing to wrap and is reported without a fix.",
  }),
  check(ctx) {
    const wrapped = wrappedRoot(ctx.root);
    const fix = wrapped
      ? {
          fix: {
            title: `Wrap the root in an object with one property, "${WRAPPER_KEY}".`,
            rewrite: (schema: JsonSchema) => wrappedRoot(schema) ?? schema,
          },
        }
      : {};

    if ("anyOf" in ctx.root) {
      ctx.report({
        path: "",
        message: 'The root schema uses "anyOf". The root must be a plain object.',
        hint: 'Wrap the union in an object: { "type": "object", "properties": { "result": { "anyOf": [...] } } }.',
        ...fix,
      });
    } else if (!typesOf(ctx.root).includes("object")) {
      ctx.report({
        path: "",
        message: 'The root schema must have "type": "object".',
        hint: "Wrap arrays, unions, and primitives in an object property.",
        ...fix,
      });
    }
  },
};

/**
 * The same schema, also accepting null. This is how the docs keep a field optional
 * under strict mode: "You can denote optional fields by adding `null` as a `type` option."
 * A schema with nothing to extend — a bare `enum`, a `const`, an empty schema — is
 * returned unchanged, because there is no documented way to make it nullable.
 */
function nullable(schema: JsonSchema): JsonSchema {
  const types = typesOf(schema);
  if (types.includes("null")) return schema;
  if (types.length > 0) return { ...schema, type: [...types, "null"] };

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf;
    if (branches.some((branch) => isJsonSchema(branch) && typesOf(branch).includes("null"))) return schema;
    return { ...schema, anyOf: [...branches, { type: "null" }] };
  }

  // A $ref cannot carry a type of its own, so the union goes around it.
  if (typeof schema.$ref === "string") {
    const { $ref, ...rest } = schema;
    return { ...rest, anyOf: [{ $ref }, { type: "null" }] };
  }

  return schema;
}

/** The properties of `schema` that are not listed in its `required`, in declaration order. */
function unrequired(schema: JsonSchema): string[] {
  if (!isJsonSchema(schema.properties)) return [];
  const listed = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(schema.properties).filter((key) => !listed.has(key));
}

const allRequired: Rule = {
  ...meta("all-required", {
    severity: "error",
    summary: 'Every key in "properties" must be listed in "required".',
  }),
  fixable: true,
  check(ctx) {
    for (const node of ctx.nodes) {
      const properties = node.schema.properties;
      if (!isJsonSchema(properties)) continue;
      const missing = unrequired(node.schema);
      if (missing.length === 0) continue;

      // Naming the keys the fix can keep optional keeps its title true to what it does.
      const nullified = missing.filter((key) => {
        const property = properties[key];
        return isJsonSchema(property) && nullable(property) !== property;
      });

      ctx.report({
        path: node.path,
        message: `Properties missing from "required": ${missing.join(", ")}.`,
        hint: 'Add them to "required". To keep a field optional, make it nullable: "type": ["string", "null"].',
        fix: {
          title:
            nullified.length > 0
              ? `Add ${missing.join(", ")} to "required", and "null" to the type of ${nullified.join(", ")}.`
              : `Add ${missing.join(", ")} to "required".`,
          rewrite(schema) {
            const current = schema.properties;
            if (!isJsonSchema(current)) return schema;
            const absent = unrequired(schema);
            if (absent.length === 0) return schema;

            const rewritten: JsonSchema = { ...current };
            for (const key of absent) {
              const property = current[key];
              if (isJsonSchema(property)) rewritten[key] = nullable(property);
            }
            const listed = Array.isArray(schema.required) ? schema.required : [];
            return { ...schema, properties: rewritten, required: [...listed, ...absent] };
          },
        },
      });
    }
  },
};

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** True when a schema describes an object and nothing else, or constrains the type not at all. */
function describesObject(schema: JsonSchema): boolean {
  const types = typesOf(schema);
  return types.length === 0 || (types.length === 1 && types[0] === "object");
}

/** The two property maps as one, or null when both define the same key differently. */
function mergeProperties(left: unknown, right: unknown): JsonSchema | null {
  if (!isJsonSchema(left) || !isJsonSchema(right)) return null;
  const merged: JsonSchema = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key in merged && !same(merged[key], value)) return null;
    merged[key] = value;
  }
  return merged;
}

/** The `$ref` of a branch that is nothing but a reference, so inlining it loses nothing. */
function refOnly(branch: JsonSchema): string | null {
  const keywords = Object.keys(branch);
  return keywords.length === 1 && keywords[0] === "$ref" && typeof branch.$ref === "string" ? branch.$ref : null;
}

/** True when the subschema at `path` refers back to itself, directly or through another definition. */
function refersToItself(root: JsonSchema, path: string): boolean {
  const seen = new Set<string>([path]);

  const visit = (schema: JsonSchema, at: string): boolean => {
    const reachable = [...children(schema, at)];
    if (typeof schema.$ref === "string") {
      const target = resolveLocalRef(root, schema.$ref);
      if (target?.path === path) return true;
      if (target) reachable.push({ schema: target.schema, path: target.path, parentKeyword: "$ref" });
    }
    for (const next of reachable) {
      if (seen.has(next.path)) continue;
      seen.add(next.path);
      if (visit(next.schema, next.path)) return true;
    }
    return false;
  };

  const start = resolvePointer(root, path);
  return isJsonSchema(start) ? visit(start, path) : false;
}

/** How many subschemas point at `path` with a local `$ref`. */
function refCount(root: JsonSchema, path: string): number {
  return walk(root).filter((node) => {
    const { $ref } = node.schema;
    return typeof $ref === "string" && resolveLocalRef(root, $ref)?.path === path;
  }).length;
}

/**
 * The definition a bare `$ref` branch names, when putting it in the branch's place is safe:
 * the definition must be an object, must not refer back to itself — such a branch cannot be
 * inlined at all — and must be used nowhere else, because inlining a shared definition would
 * leave the schema carrying two copies that drift apart. The copy is deep, so the merged
 * object shares nothing with the definition it came from.
 */
function inlinableRef(root: JsonSchema, ref: string): JsonSchema | null {
  const target = resolveLocalRef(root, ref);
  if (!target || target.path === "") return null;
  if (refersToItself(root, target.path) || refCount(root, target.path) !== 1) return null;
  return structuredClone(target.schema);
}

/**
 * The branches of `allOf`, with a branch that is nothing but a `$ref` replaced by the
 * definition it names. Returns null when a branch cannot stand as a plain object.
 */
function allOfBranches(schema: JsonSchema, root: JsonSchema): { branches: JsonSchema[]; inlined: string[] } | null {
  const raw = schema.allOf;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const branches: JsonSchema[] = [];
  const inlined: string[] = [];
  for (const branch of raw) {
    if (!isJsonSchema(branch)) return null;
    const ref = refOnly(branch);
    const resolved = ref === null ? branch : inlinableRef(root, ref);
    if (!resolved || !isObjectSchema(resolved) || !describesObject(resolved)) return null;
    if (ref !== null) inlined.push(ref);
    branches.push(resolved);
  }
  return { branches, inlined };
}

/**
 * The schema with its `allOf` merged into it: the properties of every branch on one object.
 * Returns null when the branches cannot be merged without changing what the schema accepts —
 * a branch that is not a plain object, or two of them constraining the same thing differently.
 */
function mergedAllOf(schema: JsonSchema, branches: readonly JsonSchema[] | null): JsonSchema | null {
  if (!branches) return null;

  const { allOf: _merged, ...host } = schema;
  if (!describesObject(host)) return null;

  const merged: JsonSchema = {};
  for (const participant of [host, ...branches]) {
    for (const [keyword, value] of Object.entries(participant)) {
      const current = merged[keyword];
      if (current === undefined || same(current, value)) {
        merged[keyword] = value;
        continue;
      }
      switch (keyword) {
        case "properties": {
          const properties = mergeProperties(current, value);
          if (!properties) return null;
          merged.properties = properties;
          break;
        }
        case "required": {
          if (!Array.isArray(current) || !Array.isArray(value)) return null;
          merged.required = [...new Set([...current, ...value])];
          break;
        }
        case "description": {
          if (typeof current !== "string" || typeof value !== "string") return null;
          merged.description = `${current} ${value}`;
          break;
        }
        case "additionalProperties": {
          // The intersection of an open and a closed object is the closed one.
          if (current !== false && value !== false) return null;
          merged.additionalProperties = false;
          break;
        }
        default:
          return null;
      }
    }
  }
  return merged;
}

const unsupportedComposition = forbiddenKeywords(
  meta("unsupported-composition", {
    severity: "error",
    summary: "allOf, not, dependentRequired, dependentSchemas, if, then, and else are not supported.",
    fixable: true,
    notes:
      'Only "allOf" can be rewritten, and only when every branch is a plain object: the fix puts their properties, ' +
      'required keys, and descriptions on one object. A branch that is nothing but a "$ref" is inlined first, but ' +
      "only when the definition it names is used nowhere else and does not refer back to itself: inlining a shared " +
      "definition would leave two copies to drift apart, and a self-referential one cannot be inlined at all. The " +
      'definition stays under "$defs" once its only use is inlined, unused but harmless. Merging widens an ' +
      '"additionalProperties": false in a branch, which then no longer rejects the properties of its siblings — ' +
      "which is what a single strict object has to accept anyway. Branches that constrain the same key differently " +
      'are left to be merged by hand, and "not", "if"/"then"/"else", "dependentRequired", and "dependentSchemas" ' +
      "carry no fix, because dropping them would change what the schema accepts.",
  }),
  ["allOf", "not", "dependentRequired", "dependentSchemas", "if", "then", "else"],
  (keyword, node, ctx) => {
    if (keyword !== "allOf") {
      return {
        message: `"${keyword}" is not supported.`,
        hint: 'Model the alternatives with "anyOf", or move the condition into "description".',
      };
    }
    const root = ctx.root;
    const resolved = allOfBranches(node.schema, root);
    const merged = mergedAllOf(node.schema, resolved?.branches ?? null);
    const count = Array.isArray(node.schema.allOf) ? node.schema.allOf.length : 0;
    const subject = count === 1 ? 'the "allOf" branch' : `the ${count} "allOf" branches`;
    const naming = resolved && resolved.inlined.length > 0 ? `, inlining ${resolved.inlined.join(" and ")}` : "";
    return {
      message: '"allOf" is not supported.',
      hint: merged ? "Merge the subschemas into a single object." : "Merge the subschemas into a single object by hand.",
      ...(merged
        ? {
            fix: {
              title: `Merge ${subject} into the object${naming}.`,
              rewrite: (schema: JsonSchema) => mergedAllOf(schema, allOfBranches(schema, root)?.branches ?? null) ?? schema,
            },
          }
        : {}),
    };
  },
);

/**
 * The same schema with its `oneOf` renamed to `anyOf`, keeping the branches and the
 * position of the keyword. Returns null when there is nothing safe to rename: a `oneOf`
 * that is not a list of branches, or a schema that already has an `anyOf`, which would
 * be overwritten.
 */
function oneOfAsAnyOf(schema: JsonSchema): JsonSchema | null {
  if (!Array.isArray(schema.oneOf) || "anyOf" in schema) return null;
  const rewritten: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === "oneOf") rewritten.anyOf = value;
    else rewritten[keyword] = value;
  }
  return rewritten;
}

const noOneOf = forbiddenKeywords(
  meta("no-one-of", {
    severity: "error",
    summary: 'Unions must use "anyOf"; "oneOf" is not supported.',
    notes:
      'The documentation lists "anyOf" as the only supported union keyword. The fix renames "oneOf" to "anyOf", ' +
      "which widens the union from exactly one matching branch to at least one; make the branches mutually " +
      'exclusive if that matters. A schema that already has an "anyOf" of its own is left to be merged by hand.',
    fixable: true,
  }),
  ["oneOf"],
  (_keyword, node) => ({
    message: '"oneOf" is not supported.',
    hint: 'Replace "oneOf" with "anyOf".',
    ...(oneOfAsAnyOf(node.schema)
      ? {
          fix: {
            title: 'Rename "oneOf" to "anyOf".',
            rewrite: (schema: JsonSchema) => oneOfAsAnyOf(schema) ?? schema,
          },
        }
      : {}),
  }),
);

const unsupportedFormat = allowedFormats(
  meta("unsupported-format", {
    severity: "error",
    summary: 'String "format" must be one of the documented formats.',
    fixable: true,
    notes:
      'The fix removes "format" and states what it required in "description", so the requirement still reaches the ' +
      'model as words: "format": "uri" becomes "Must be an absolute URI, such as https://example.com/a." Nothing ' +
      "checks the format any more, so validate the field in your code.",
  }),
  SUPPORTED_FORMATS,
);

const undocumentedKeyword = forbiddenKeywords(
  meta("undocumented-keyword", {
    severity: "warn",
    summary: "Validation keywords absent from the documented per-type keyword lists.",
    notes:
      "The docs enumerate the supported keywords for strings, numbers, and arrays. These keywords are not on those lists. " +
      "minLength and maxLength are explicitly unsupported on fine-tuned models.",
  }),
  [
    "minLength",
    "maxLength",
    "patternProperties",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "uniqueItems",
    "contains",
    "minContains",
    "maxContains",
    "prefixItems",
    "unevaluatedProperties",
    "unevaluatedItems",
  ],
  (keyword) => ({
    message: `"${keyword}" is not documented as supported and may be rejected.`,
    hint: `Remove "${keyword}" and state the constraint in "description".`,
  }),
);

/**
 * The deepest chain of nested object schemas, following local `$ref`s.
 * `objects` counts the root, so nesting levels are `objects - 1`.
 */
function deepestObjectChain(root: JsonSchema): { objects: number; path: string } {
  type Measure = { objects: number; path: string };
  const memo = new Map<string, Measure>();
  const active = new Set<string>();

  const measure = (schema: JsonSchema, path: string): Measure => {
    const cached = memo.get(path);
    if (cached) return cached;
    if (active.has(path)) return { objects: 0, path };
    active.add(path);

    let best: Measure = { objects: 0, path };
    const consider = (candidate: Measure): void => {
      if (candidate.objects > best.objects) best = candidate;
    };

    for (const child of children(schema, path)) {
      // Definitions only add depth where they are referenced.
      if (child.parentKeyword === "$defs" || child.parentKeyword === "definitions") continue;
      consider(measure(child.schema, child.path));
    }
    if (typeof schema.$ref === "string") {
      const target = resolveLocalRef(root, schema.$ref);
      if (target) consider(measure(target.schema, target.path));
    }

    active.delete(path);
    const result = isObjectSchema(schema) ? { objects: best.objects + 1, path: best.path } : best;
    memo.set(path, result);
    return result;
  };

  return measure(root, "");
}

const nestingDepth: Rule = {
  ...meta("nesting-depth", {
    severity: "error",
    summary: `A schema may have up to ${MAX_NESTING_LEVELS} levels of nesting.`,
    notes:
      "Counts object schemas nested below the root object, following $refs. Recursive references are counted once.",
  }),
  check(ctx) {
    const deepest = deepestObjectChain(ctx.root);
    const levels = deepest.objects - 1;
    if (levels <= MAX_NESTING_LEVELS) return;
    ctx.report({
      path: deepest.path,
      message: `Objects are nested ${levels} levels deep; the limit is ${MAX_NESTING_LEVELS}.`,
      hint: "Flatten the structure, or split it across multiple calls.",
    });
  },
};

const maxProperties: Rule = {
  ...meta("max-properties", {
    severity: "error",
    summary: `A schema may have up to ${MAX_TOTAL_PROPERTIES} object properties in total.`,
  }),
  check(ctx) {
    let total = 0;
    for (const node of ctx.nodes) {
      if (isJsonSchema(node.schema.properties)) total += Object.keys(node.schema.properties).length;
    }
    if (total <= MAX_TOTAL_PROPERTIES) return;
    ctx.report({
      path: "",
      message: `The schema declares ${total} object properties; the limit is ${MAX_TOTAL_PROPERTIES}.`,
    });
  },
};

const enumLimits: Rule = {
  ...meta("enum-limits", {
    severity: "error",
    summary: `Up to ${MAX_TOTAL_ENUM_VALUES} enum values in total; an enum with more than ${LARGE_ENUM_THRESHOLD} string values may total at most ${LARGE_ENUM_MAX_CHARS.toLocaleString("en-US")} characters.`,
  }),
  check(ctx) {
    let total = 0;
    for (const node of ctx.nodes) {
      const values = node.schema.enum;
      if (!Array.isArray(values)) continue;
      total += values.length;

      const strings = values.filter((value): value is string => typeof value === "string");
      const chars = strings.reduce((sum, value) => sum + value.length, 0);
      if (strings.length > LARGE_ENUM_THRESHOLD && chars > LARGE_ENUM_MAX_CHARS) {
        ctx.report({
          path: node.path,
          message: `Enum has ${strings.length} string values totalling ${chars} characters; enums with more than ${LARGE_ENUM_THRESHOLD} values may total at most ${LARGE_ENUM_MAX_CHARS}.`,
        });
      }
    }
    if (total > MAX_TOTAL_ENUM_VALUES) {
      ctx.report({
        path: "",
        message: `The schema declares ${total} enum values in total; the limit is ${MAX_TOTAL_ENUM_VALUES}.`,
      });
    }
  },
};

const stringBudget: Rule = {
  ...meta("string-budget", {
    severity: "error",
    summary: `Property names, definition names, enum values, and const values may total at most ${MAX_STRING_BUDGET.toLocaleString("en-US")} characters.`,
  }),
  check(ctx) {
    let chars = 0;
    for (const { schema } of ctx.nodes) {
      for (const keyword of ["properties", "$defs", "definitions"]) {
        const map = schema[keyword];
        if (isJsonSchema(map)) chars += Object.keys(map).reduce((sum, key) => sum + key.length, 0);
      }
      if (Array.isArray(schema.enum)) {
        for (const value of schema.enum) if (typeof value === "string") chars += value.length;
      }
      if (typeof schema.const === "string") chars += schema.const.length;
    }
    if (chars <= MAX_STRING_BUDGET) return;
    ctx.report({
      path: "",
      message: `Names and enum/const values total ${chars} characters; the limit is ${MAX_STRING_BUDGET}.`,
    });
  },
};

export const openai: Provider = {
  id: "openai",
  name: "OpenAI",
  mode: "Structured Outputs (strict: true)",
  rules: [
    rootObject,
    allRequired,
    additionalPropertiesFalse(
      meta("additional-properties-false", {
        severity: "error",
        summary: 'Every object must set "additionalProperties": false.',
      }),
    ),
    unsupportedComposition,
    noOneOf,
    unsupportedFormat,
    undocumentedKeyword,
    nestingDepth,
    maxProperties,
    enumLimits,
    stringBudget,
  ],
};
