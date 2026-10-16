import { joinPointer, unescapeToken } from "./pointer.js";
import type { Finding, JsonSchema, LintResult } from "./types.js";
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

/** The component a `$ref` names, when it names one: `#/components/schemas/Pet/properties/id` names `Pet`. */
function referencedComponent(ref: string): string | undefined {
  if (!ref.startsWith(COMPONENT_REF)) return undefined;
  const [token] = ref.slice(COMPONENT_REF.length).split("/");
  if (!token) return undefined;
  try {
    return unescapeToken(decodeURIComponent(token));
  } catch {
    return undefined;
  }
}

/** A copy of `value` with every reference to a component rewritten to the same name under `$defs`. */
function retarget(value: unknown, names: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => retarget(item, names));
  if (!isJsonSchema(value)) return value;

  const copy: JsonSchema = {};
  for (const [key, child] of Object.entries(value)) {
    const name = key === "$ref" && typeof child === "string" ? referencedComponent(child) : undefined;
    copy[key] =
      name !== undefined && names.has(name) ? DEFS_REF + (child as string).slice(COMPONENT_REF.length) : retarget(child, names);
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
        const name = referencedComponent(child);
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
 * One component as it would be sent on its own: the schema, with every component it reaches
 * copied under `$defs` and every `#/components/schemas/<name>` reference rewritten to
 * `#/$defs/<name>`, so the references resolve inside the schema the way a provider resolves them.
 * Throws a TypeError when the component's own `$defs` already holds a different schema under
 * one of those names, because the bundle could not hold both.
 */
function bundle(components: JsonSchema, name: string): { schema: unknown; copied: string[] } {
  const component = components[name];
  const copied = reachable(components, name);
  if (!isJsonSchema(component) || copied.length === 0) return { schema: component, copied };

  const names = new Set(copied);
  const schema = retarget(component, names) as JsonSchema;
  const own = schema.$defs;
  if (own !== undefined && !isJsonSchema(own)) {
    throw new TypeError(`Component "${name}": "$defs" must be an object to bundle the components it references into.`);
  }
  const defs: JsonSchema = { ...own };
  for (const copy of copied) {
    const definition = retarget(components[copy], names);
    if (copy in defs && JSON.stringify(defs[copy]) !== JSON.stringify(definition)) {
      throw new TypeError(`Component "${name}": "$defs" already defines "${copy}", the name of a component it references.`);
    }
    defs[copy] = definition;
  }
  schema.$defs = defs;
  return { schema, copied };
}

/** One component of an OpenAPI document, ready to lint. */
export interface OpenApiSchema extends UnwrappedSchema {
  /** The components copied under `$defs` because this one references them. */
  copied: string[];
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
    const { schema, copied } = bundle(components, name);
    const keys = [...COMPONENTS, name];
    return {
      schema,
      wrapper: copied.length > 0 ? "OpenAPI component, with the components it references under $defs" : "OpenAPI component",
      keys,
      kind: null,
      pointer: joinPointer("", ...keys),
      name,
      copied,
    };
  });
}

/** The component a finding in a bundle sits in, and its path inside that component. */
function copiedLocation(path: string, copied: readonly string[]): { name: string; path: string } | undefined {
  if (!path.startsWith("/$defs/")) return undefined;
  const [token = "", ...rest] = path.slice("/$defs/".length).split("/");
  const name = unescapeToken(token);
  if (!copied.includes(name)) return undefined;
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
    const copied = components[index]?.copied ?? [];
    const findings = result.findings.filter((item) => {
      const location = copiedLocation(item.path, copied);
      return location === undefined || !own.get(location.name)?.has(`${item.ruleId} ${location.path}`);
    });
    return findings.length === result.findings.length ? result : { findings, summary: summarize(findings) };
  });
}
