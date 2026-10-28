import { fixExcept } from "./fix.js";
import { summarize } from "./lint.js";
import { joinPointer, unescapeToken } from "./pointer.js";
import { PROVIDER_IDS } from "./types.js";
import type { Finding, FixOptions, FixResult, JsonSchema, LintResult } from "./types.js";
import type { UnwrappedSchema } from "./unwrap.js";
import { isJsonSchema } from "./walk.js";

/** Where an OpenAPI document keeps "reusable Schema Objects", and how a reference names one. */
const COMPONENTS = ["components", "schemas"] as const;
const COMPONENT_REF = "#/components/schemas/";
const DEFS_REF = "#/$defs/";

/** The schemas under `components.schemas`, or `undefined` when the document declares none. */
function componentSchemas(document: unknown): JsonSchema | undefined {
  if (!isJsonSchema(document) || !isJsonSchema(document.components)) return undefined;
  const schemas = document.components.schemas;
  return isJsonSchema(schemas) ? schemas : undefined;
}

/**
 * The name a `$ref` names under `prefix`, when it names one: `#/components/schemas/Pet/properties/id`
 * names the component `Pet`, and `#/$defs/Pet/properties/id` the definition `Pet`.
 */
function referencedName(ref: string, prefix: string = COMPONENT_REF): string | undefined {
  if (!ref.startsWith(prefix)) return undefined;
  const [token] = ref.slice(prefix.length).split("/");
  if (!token) return undefined;
  try {
    return unescapeToken(decodeURIComponent(token));
  } catch {
    return undefined;
  }
}

/**
 * A copy of `value` with every reference under `from` to a name `to` maps rewritten under the
 * prefix it maps to, the rest of the reference kept as it was spelled: by default a component's,
 * to the definition `bundle` copies it into.
 */
function retarget(value: unknown, to: ReadonlyMap<string, string>, from = COMPONENT_REF): unknown {
  if (Array.isArray(value)) return value.map((item) => retarget(item, to, from));
  if (!isJsonSchema(value)) return value;

  const copy: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    const name = key === "$ref" && typeof child === "string" ? referencedName(child, from) : undefined;
    const prefix = name === undefined ? undefined : to.get(name);
    copy[key] = prefix !== undefined ? prefix + (child as string).slice(from.length) : retarget(child, to, from);
  }
  return copy;
}

/** The names of the components `value` refers to, wherever in it the reference sits. */
function references(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) references(item, into);
  } else if (isJsonSchema(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const name = referencedName(child);
        if (name !== undefined) into.add(name);
      } else {
        references(child, into);
      }
    }
  }
  return into;
}

/** Every component `start` reaches through its references, `start` excluded unless it refers back to itself. */
function reachable(components: JsonSchema, start: string): string[] {
  const seen = new Set<string>();
  const queue = [...references(components[start], new Set())];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name) || !(name in components)) continue;
    seen.add(name);
    queue.push(...references(components[name], new Set()));
  }
  return [...seen];
}

/**
 * What a copied component is named under `$defs` when the component it is copied into already
 * defines its name there. The name is appended to it as the reference spelled it, so the
 * reference can be spelled the same way again once the copy is taken out.
 */
const RENAMED_COPY = "components.schemas.";

/**
 * One component as it would be sent on its own: the schema, with every component it reaches
 * copied under `$defs` and every `#/components/schemas/<name>` reference rewritten to
 * `#/$defs/<name>`, so the references resolve inside the schema the way a provider resolves them.
 * A copy whose name the component's own `$defs` already uses, for a copy of its own, goes under
 * `components.schemas.<name>` instead, so the references the bundle rewrote stay apart from the
 * ones the component wrote. Throws a TypeError when the component's own `$defs` already holds a
 * different schema under one of those names, because the bundle could not hold both.
 */
function bundle(components: JsonSchema, name: string): { schema: unknown; copied: string[]; copiedAs: Record<string, string> } {
  const component = components[name];
  const copied = reachable(components, name);
  if (!isJsonSchema(component) || copied.length === 0) return { schema: component, copied, copiedAs: {} };

  const own = component.$defs;
  if (own !== undefined && !isJsonSchema(own)) {
    throw new TypeError(`Component "${name}": "$defs" must be an object to bundle the components it references into.`);
  }
  const copiedAs: Record<string, string> = {};
  const to = new Map<string, string>();
  for (const copy of copied) {
    const renamed = own !== undefined && copy in own;
    copiedAs[copy] = renamed ? RENAMED_COPY + copy : copy;
    to.set(copy, DEFS_REF + (renamed ? RENAMED_COPY : ""));
  }

  const schema = retarget(component, to) as JsonSchema;
  const defs: JsonSchema = { ...(schema.$defs as JsonSchema | undefined) };
  for (const copy of copied) {
    const definition = retarget(components[copy], to);
    const key = copiedAs[copy] as string;
    if (key !== copy && JSON.stringify(defs[copy]) !== JSON.stringify(definition)) {
      throw new TypeError(`Component "${name}": "$defs" already defines "${copy}", the name of a component it references.`);
    }
    if (key in defs) {
      throw new TypeError(`Component "${name}": "$defs" already defines "${key}", the name its copy of "${copy}" needs.`);
    }
    defs[key] = definition;
  }
  schema.$defs = defs;
  return { schema, copied, copiedAs };
}

/** One component of an OpenAPI document, ready to lint. */
export interface OpenApiSchema extends UnwrappedSchema {
  /** The components copied under `$defs` because this one references them. */
  copied: string[];
  /**
   * The key under `$defs` each copied component sits at: its name, or `components.schemas.<name>`
   * when the component's own `$defs` already uses that name.
   */
  copiedAs: Record<string, string>;
}

/**
 * Every schema under `components.schemas` of an OpenAPI document, each as it would be sent on its
 * own, with the components it references bundled under `$defs`. The pointer is the component's
 * place in the document, and the name is its component name. Returns an empty array when the
 * document declares no schema components.
 */
export function openApiSchemas(document: unknown): OpenApiSchema[] {
  const components = componentSchemas(document);
  if (components === undefined) return [];
  return Object.keys(components).map((name) => {
    const { schema, copied, copiedAs } = bundle(components, name);
    const keys = [...COMPONENTS, name];
    return {
      schema,
      wrapper: copied.length > 0 ? "OpenAPI component, with the components it references under $defs" : "OpenAPI component",
      keys,
      kind: null,
      pointer: joinPointer("", ...keys),
      name,
      copied,
      copiedAs,
    };
  });
}

/** The component a finding in a bundle sits in, and its path inside that component. */
function copiedLocation(path: string, copiedAs: Readonly<Record<string, string>>): { name: string; path: string } | undefined {
  if (!path.startsWith("/$defs/")) return undefined;
  const [token = "", ...rest] = path.slice("/$defs/".length).split("/");
  const key = unescapeToken(token);
  const name = Object.keys(copiedAs).find((copy) => copiedAs[copy] === key);
  if (name === undefined) return undefined;
  return { name, path: rest.length > 0 ? `/${rest.join("/")}` : "" };
}

/**
 * The results of linting every component, with what a component's own report already says
 * taken out of the reports it was copied into. A bundle holds a copy of every component it
 * references, so a finding in a shared component would otherwise be reported once per
 * component that uses it. A finding only the bundle shows — one that needs the referencing
 * schema around it, such as a nesting depth reached through the reference — is kept.
 * `summarize` recounts a report after its findings change.
 */
export function withoutCopiedFindings(
  components: readonly OpenApiSchema[],
  results: readonly LintResult[],
  summarize: (findings: readonly Finding[]) => LintResult["summary"],
): LintResult[] {
  const own = new Map<string, Set<string>>();
  components.forEach((component, index) => {
    const result = results[index];
    if (component.name !== undefined && result !== undefined) {
      own.set(component.name, new Set(result.findings.map((item) => `${item.ruleId} ${item.path}`)));
    }
  });

  return results.map((result, index) => {
    const copiedAs = components[index]?.copiedAs ?? {};
    const findings = result.findings.filter((item) => {
      const location = copiedLocation(item.path, copiedAs);
      return location === undefined || !own.get(location.name)?.has(`${item.ruleId} ${location.path}`);
    });
    return findings.length === result.findings.length ? result : { findings, summary: summarize(findings) };
  });
}

/**
 * The fixes that rewrite what a component is rather than how it is spelled, held back under
 * `fixOpenApi`. Wrapping a non-object root in `{ "result": ... }` is right for a schema sent on
 * its own, but a component is also what every `#/components/schemas/<name>` reference to it
 * means, so the wrapped one would change the API the document describes, the requests and
 * responses that use it included. Wrap such a component where it is sent instead.
 */
const HELD_IN_COMPONENTS: ReadonlySet<string> = new Set(["openai/root-object"]);

/**
 * A fixed bundle turned back into the component it was made from: the copies `copiedAs` names
 * taken out of its `$defs`, and every reference the bundle pointed at one of them pointed at the
 * component again. The `$defs` goes too once it holds nothing, unless the component declared it.
 */
function unbundle(schema: JsonSchema, copiedAs: Readonly<Record<string, string>>, declared: boolean): JsonSchema {
  const copies = Object.entries(copiedAs);
  if (copies.length === 0) return schema;
  // The renamed copies first: `#/$defs/components.schemas.<name>` is no reference to `<name>`.
  const renamed = new Map(copies.filter(([name, key]) => key !== name).map(([name]) => [name, COMPONENT_REF]));
  const kept = new Map(copies.filter(([name, key]) => key === name).map(([name]) => [name, COMPONENT_REF]));
  const restored = retarget(retarget(schema, renamed, DEFS_REF + RENAMED_COPY), kept, DEFS_REF) as JsonSchema;
  if (!isJsonSchema(restored.$defs)) return restored;
  const keys = new Set(Object.values(copiedAs));
  const defs = Object.fromEntries(Object.entries(restored.$defs).filter(([key]) => !keys.has(key)));
  if (Object.keys(defs).length > 0 || declared) restored.$defs = defs;
  else delete restored.$defs;
  return restored;
}

/** One component of an OpenAPI document after `fixOpenApi`, the schema back in its own shape. */
export type FixedComponent = Omit<OpenApiSchema, "schema"> & FixResult;

/**
 * Applies every available fix to each schema under `components.schemas` and puts it back where
 * it came from, so a fix lands once, in the component it belongs to.
 *
 * Each component is fixed as the bundle `openApiSchemas` lints, so a fix sees the components
 * it references, and an `allOf` of one can be merged. The copies the bundle made under `$defs`
 * are then taken out again and its references pointed back at `#/components/schemas/`, and the
 * fixes made inside a copy are dropped from its report: they are applied, and reported, on the
 * component the copy was made from. What a fix inlined into the component stays in it.
 *
 * The fix for `openai/root-object` is held back: see `HELD_IN_COMPONENTS`. Returns the
 * rewritten document, which is the input left untouched when it declares no schema components,
 * and one result per component. Throws a TypeError for a component that is not a JSON object,
 * or whose `$defs` cannot take the components it references.
 */
export function fixOpenApi(
  document: unknown,
  options: FixOptions = {},
): { document: unknown; components: FixedComponent[] } {
  const components = componentSchemas(document);
  const found = openApiSchemas(document);
  if (components === undefined || found.length === 0) return { document, components: [] };

  const results = found.map((component) => {
    const own = components[component.name as string];
    const declared = isJsonSchema(own) && own.$defs !== undefined;
    let result: FixResult;
    try {
      result = fixExcept(component.schema, options, HELD_IN_COMPONENTS);
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError(`Component "${component.name}": ${error.message}`);
      throw error;
    }
    const applied = result.applied.filter((item) => copiedLocation(item.path, component.copiedAs) === undefined);
    return { ...result, schema: unbundle(result.schema, component.copiedAs, declared), applied };
  });

  const selected = options.providers ?? PROVIDER_IDS;
  const remaining = withoutCopiedFindings(found, results, (findings) => summarize(findings, selected));
  const fixed: JsonSchema = structuredClone(components);
  const out = found.map((component, index): FixedComponent => {
    const { schema: _bundle, ...where } = component;
    const result = results[index] as FixResult;
    fixed[component.name as string] = result.schema;
    return { ...where, ...result, ...(remaining[index] as LintResult) };
  });
  const rewritten = structuredClone(document) as { components: { schemas: JsonSchema } };
  rewritten.components.schemas = fixed;
  return { document: rewritten, components: out };
}
