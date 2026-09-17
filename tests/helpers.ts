import { lint } from "../src/index.js";
import type { Finding, JsonSchema, ProviderId } from "../src/index.js";

export function findingsFor(provider: ProviderId, schema: JsonSchema): Finding[] {
  return lint(schema, { providers: [provider] }).findings;
}

/** The distinct rule ids a schema triggers for one provider, sorted. */
export function ruleIds(provider: ProviderId, schema: JsonSchema): string[] {
  return [...new Set(findingsFor(provider, schema).map((finding) => finding.ruleId))].sort();
}

/** Wraps properties in an object that is valid everywhere, so tests isolate one rule. */
export function strictObject(properties: Record<string, JsonSchema>, extra: JsonSchema = {}): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...extra,
  };
}
