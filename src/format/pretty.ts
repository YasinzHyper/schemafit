import { displayPointer } from "../pointer.js";
import { providers } from "../providers/index.js";
import type { AppliedFix, Finding, LintResult, ProviderSummary, RuleMeta } from "../types.js";

export interface FileReport {
  file: string;
  wrapper: string | null;
  result: LintResult;
}

export interface FixReport {
  file: string;
  wrapper: string | null;
  applied: readonly AppliedFix[];
  findings: readonly Finding[];
  summary: readonly ProviderSummary[];
}

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, bold: 1, dim: 2 } as const;

type Paint = (style: keyof typeof CODES, text: string) => string;

function painter(color: boolean): Paint {
  return (style, text) => (color ? `[${CODES[style]}m${text}[0m` : text);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function status(summary: ProviderSummary, paint: Paint): string {
  if (summary.errors > 0) {
    const warnings = summary.warnings > 0 ? `, ${plural(summary.warnings, "warning")}` : "";
    return paint("red", `✖ ${plural(summary.errors, "error")}${warnings}`);
  }
  if (summary.warnings > 0) return paint("yellow", `⚠ compatible, ${plural(summary.warnings, "warning")}`);
  return paint("green", "✔ compatible");
}

function finding(item: Finding, paint: Paint): string[] {
  const label = item.severity === "error" ? paint("red", "error") : paint("yellow", "warn ");
  const lines = [`    ${label}  ${paint("bold", displayPointer(item.path))}  ${paint("dim", item.ruleId)}`];
  lines.push(`           ${item.message}`);
  if (item.hint) lines.push(`           ${paint("cyan", "fix:")} ${item.hint}`);
  return lines;
}

export function formatPretty(reports: readonly FileReport[], options: { color: boolean }): string {
  const paint = painter(options.color);
  const lines: string[] = [];

  for (const { file, wrapper, result } of reports) {
    lines.push(paint("bold", file) + (wrapper ? paint("dim", `  (${wrapper})`) : ""));
    lines.push("");

    const width = Math.max(...result.summary.map((summary) => providers[summary.provider].name.length));
    for (const summary of result.summary) {
      lines.push(`  ${providers[summary.provider].name.padEnd(width)}  ${status(summary, paint)}`);
      for (const item of result.findings) {
        if (item.provider === summary.provider) lines.push(...finding(item, paint));
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** The stderr report of `--fix`: what was rewritten, and what is left to do by hand. */
export function formatFixed(report: FixReport, options: { color: boolean }): string {
  const paint = painter(options.color);
  const lines = [paint("bold", report.file) + (report.wrapper ? paint("dim", `  (${report.wrapper})`) : ""), ""];

  if (report.applied.length === 0) {
    lines.push(`  ${paint("dim", "Nothing to fix; the schema is unchanged.")}`);
  }
  for (const item of report.applied) {
    lines.push(`  ${paint("green", "fixed")}  ${paint("bold", displayPointer(item.path))}  ${paint("dim", item.ruleId)}`);
    lines.push(`         ${item.title}`);
  }

  for (const summary of report.summary) {
    const name = providers[summary.provider].name;
    const remaining = report.findings.filter((item) => item.provider === summary.provider);
    lines.push("", `  ${name}  ${status(summary, paint)}`);
    if (remaining.length > 0) lines.push(`  ${paint("dim", "No automatic rewrite for these; the hint says what to change.")}`);
    for (const item of remaining) lines.push(...finding(item, paint));
  }

  lines.push("");
  return lines.join("\n");
}

export function formatRules(rules: readonly RuleMeta[], options: { color: boolean }): string {
  const paint = painter(options.color);
  const width = Math.max(...rules.map((rule) => rule.id.length));
  return rules
    .map((rule) => {
      const label = rule.severity === "error" ? paint("red", "error") : paint("yellow", "warn ");
      const fixable = rule.fixable ? paint("green", " [--fix]") : "";
      return `${rule.id.padEnd(width)}  ${label}  ${rule.summary}${fixable}`;
    })
    .join("\n");
}
