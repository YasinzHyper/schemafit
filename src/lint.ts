import { providers } from "./providers/index.js";
import { requestSchemas } from "./request.js";
import { PROVIDER_IDS } from "./types.js";
import type {
  Finding,
  JsonSchema,
  LintOptions,
  LintResult,
  ProviderId,
  ProviderSummary,
  Report,
  RequestSchema,
  RuleMeta,
  SchemaNode,
} from "./types.js";
import { isJsonSchema, walk } from "./walk.js";

/** One report, with the rule that made it. */
function finding(rule: RuleMeta, report: Report): Finding {
  return { ruleId: rule.id, provider: rule.provider, severity: rule.severity, source: rule.source, ...report };
}

function summarize(findings: readonly Finding[], selected: readonly ProviderId[]): ProviderSummary[] {
  return selected.map((id) => {
    const own = findings.filter((item) => item.provider === id);
    const errors = own.filter((item) => item.severity === "error").length;
    return { provider: id, errors, warnings: own.length - errors, compatible: errors === 0 };
  });
}

/** What the rules that check one schema report about it. */
function schemaFindings(schema: JsonSchema, nodes: readonly SchemaNode[], selected: readonly ProviderId[]): Finding[] {
  const findings: Finding[] = [];
  for (const id of selected) {
    for (const rule of providers[id].rules) {
      rule.check({ root: schema, nodes, report: (report) => findings.push(finding(rule, report)) });
    }
  }
  return findings;
}

/** What the rules that measure the request as a whole report about `schemas`. */
function requestFindings(schemas: readonly RequestSchema[], selected: readonly ProviderId[]): Finding[] {
  const findings: Finding[] = [];
  for (const id of selected) {
    for (const rule of providers[id].requestRules ?? []) {
      rule.check({ schemas, report: (report) => findings.push(finding(rule, report)) });
    }
  }
  return findings;
}

function assertSchema(schema: unknown): JsonSchema {
  if (!isJsonSchema(schema)) throw new TypeError("Schema must be a JSON object.");
  return schema;
}

/**
 * Checks a JSON Schema against the rules of each provider that check one schema, leaving out
 * the ones that measure a whole request. `lint` is the two together; this is what the CLI uses
 * for a document that holds several schemas, where `lintRequest` measures them as one request.
 * Throws a TypeError when `schema` is not a JSON object.
 */
export function lintSchema(schema: unknown, options: LintOptions = {}): LintResult {
  const root = assertSchema(schema);
  const selected = options.providers ?? PROVIDER_IDS;
  const findings = schemaFindings(root, walk(root), selected);
  return { findings, summary: summarize(findings, selected) };
}

/**
 * Checks a JSON Schema against each provider's structured-output rules.
 * A limit a provider states per request is measured over this schema alone, which is all it can
 * mean for a schema that arrives without the request around it; `lintRequest` measures it over
 * every schema a request body holds.
 * Throws a TypeError when `schema` is not a JSON object.
 */
export function lint(schema: unknown, options: LintOptions = {}): LintResult {
  const root = assertSchema(schema);
  const selected = options.providers ?? PROVIDER_IDS;
  const nodes = walk(root);
  const one: RequestSchema[] = [{ pointer: "", schema: root, nodes, kind: null }];
  const findings = [...schemaFindings(root, nodes, selected), ...requestFindings(one, selected)];
  return { findings, summary: summarize(findings, selected) };
}

/**
 * Checks a whole document — a request body, an array of tool definitions, or a single schema —
 * against the rules that measure a request rather than one schema, such as Anthropic's limit on
 * the optional parameters of all its strict schemas together. Every schema the document sends
 * strictly is counted, so a request can be over the limit without any one schema being near it.
 *
 * The `path` of each finding is a JSON Pointer from the document, and `""` is the request as a
 * whole. Lint the schemas themselves with `lintSchema`, which this deliberately leaves alone.
 */
export function lintRequest(document: unknown, options: LintOptions = {}): LintResult {
  const selected = options.providers ?? PROVIDER_IDS;
  const findings = requestFindings(requestSchemas(document), selected);
  return { findings, summary: summarize(findings, selected) };
}
