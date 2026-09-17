import { providers } from "./providers/index.js";
import { PROVIDER_IDS } from "./types.js";
import type { Finding, LintOptions, LintResult, ProviderSummary } from "./types.js";
import { isJsonSchema, walk } from "./walk.js";

/**
 * Checks a JSON Schema against each provider's structured-output rules.
 * Throws a TypeError when `schema` is not a JSON object.
 */
export function lint(schema: unknown, options: LintOptions = {}): LintResult {
  if (!isJsonSchema(schema)) {
    throw new TypeError("Schema must be a JSON object.");
  }

  const selected = options.providers ?? PROVIDER_IDS;
  const nodes = walk(schema);
  const findings: Finding[] = [];
  const summary: ProviderSummary[] = [];

  for (const id of selected) {
    const before = findings.length;
    for (const rule of providers[id].rules) {
      rule.check({
        root: schema,
        nodes,
        report: (report) =>
          findings.push({
            ruleId: rule.id,
            provider: rule.provider,
            severity: rule.severity,
            source: rule.source,
            ...report,
          }),
      });
    }

    const own = findings.slice(before);
    const errors = own.filter((finding) => finding.severity === "error").length;
    summary.push({ provider: id, errors, warnings: own.length - errors, compatible: errors === 0 });
  }

  return { findings, summary };
}
