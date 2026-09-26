export const PROVIDER_IDS = ["openai", "anthropic", "gemini"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Severity = "error" | "warn";

/** An object-form JSON Schema. Boolean schemas (`true` / `false`) are never walked. */
export type JsonSchema = Record<string, unknown>;

export interface SchemaNode {
  schema: JsonSchema;
  /** JSON Pointer from the root schema. The root itself is `""`. */
  path: string;
  /** The keyword this subschema sits under (`"properties"`, `"items"`, ...). `null` for the root. */
  parentKeyword: string | null;
}

/**
 * A rewrite that resolves one finding, applied by `fix()` and `schemafit --fix`.
 * `rewrite` is pure: it returns the replacement for the subschema the finding points at
 * and never mutates its argument.
 */
export interface SchemaFix {
  /** What applying it does, in the imperative: `Set "additionalProperties": false.` */
  title: string;
  rewrite(schema: JsonSchema): JsonSchema;
  /**
   * Definitions the rewrite may leave behind, as JSON Pointers from the root (`/$defs/user`).
   * `fix()` removes each one after the rewrite, but only when nothing outside it references it
   * any more, so a rule can name a definition it might orphan without having to know whether
   * the rest of the schema still needs it.
   */
  prunes?: readonly string[];
}

export interface Finding {
  ruleId: string;
  provider: ProviderId;
  severity: Severity;
  /** JSON Pointer to the offending subschema. The root is `""`. */
  path: string;
  message: string;
  /** How to fix it. */
  hint?: string;
  /** Present when the finding can be resolved automatically. */
  fix?: SchemaFix;
  /** Official documentation this rule is derived from. */
  source: string;
}

export interface RuleMeta {
  /** `<provider>/<kebab-case-name>` */
  id: string;
  provider: ProviderId;
  /**
   * `error`: the provider documents this as unsupported or rejected.
   * `warn`: undocumented, ambiguous, or accepted-but-risky behavior.
   */
  severity: Severity;
  summary: string;
  /** Official documentation URL the rule is derived from. */
  source: string;
  /** ISO date the rule was last checked against `source`. */
  verified: string;
  /**
   * True when the rule attaches a `fix` to the findings it can rewrite safely.
   * A rule may still report a finding without one; `notes` says when.
   */
  fixable?: boolean;
  /** Caveats about how the rule interprets the documentation. */
  notes?: string;
}

export interface Report {
  path: string;
  message: string;
  hint?: string;
  fix?: SchemaFix;
}

export interface RuleContext {
  root: JsonSchema;
  /** Every object-form subschema reachable from the root, including the root. */
  nodes: readonly SchemaNode[];
  report(report: Report): void;
}

export interface Rule extends RuleMeta {
  check(ctx: RuleContext): void;
}

export interface Provider {
  id: ProviderId;
  name: string;
  /** Which API feature these rules model. */
  mode: string;
  rules: readonly Rule[];
}

export interface ProviderSummary {
  provider: ProviderId;
  errors: number;
  warnings: number;
  /** True when there are no errors. Warnings do not affect compatibility. */
  compatible: boolean;
}

export interface LintOptions {
  /** Providers to check. Defaults to all. */
  providers?: readonly ProviderId[];
}

export interface LintResult {
  findings: Finding[];
  summary: ProviderSummary[];
}

/** One fix that `fix()` applied, recorded where it was applied. */
export interface AppliedFix {
  ruleId: string;
  provider: ProviderId;
  /** JSON Pointer to the subschema that was rewritten, in the schema as it was then. */
  path: string;
  title: string;
}

export interface FixResult {
  /** The rewritten schema. The input is never mutated. */
  schema: JsonSchema;
  /** Fixes applied, in the order they were applied. */
  applied: AppliedFix[];
  /** Findings that remain in `schema`. */
  findings: Finding[];
  summary: ProviderSummary[];
}
