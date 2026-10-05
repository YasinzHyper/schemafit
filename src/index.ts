export { fix } from "./fix.js";
export { lint } from "./lint.js";
export { providers, rules } from "./providers/index.js";
export { rewrap, unwrap, unwrapAll } from "./unwrap.js";
export type { Unwrapped, UnwrappedSchema } from "./unwrap.js";
export { PROVIDER_IDS } from "./types.js";
export type {
  AppliedFix,
  Finding,
  FixOptions,
  FixResult,
  JsonSchema,
  LintOptions,
  LintResult,
  Provider,
  ProviderId,
  ProviderSummary,
  Rule,
  RuleMeta,
  SchemaFix,
  Severity,
} from "./types.js";
