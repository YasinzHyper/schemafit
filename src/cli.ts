import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { formatPretty, formatRules } from "./format/pretty.js";
import type { FileReport } from "./format/pretty.js";
import { lint } from "./lint.js";
import { rules } from "./providers/index.js";
import { PROVIDER_IDS } from "./types.js";
import type { LintResult, ProviderId, RuleMeta } from "./types.js";
import { unwrap } from "./unwrap.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  color: boolean;
}

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

const HELP = `schemafit — lint JSON Schemas against LLM structured-output rules

Usage
  schemafit [options] <file...>     Lint schema files ("-" reads stdin)
  schemafit rules [options]         List the rules

Options
  -p, --provider <ids>    Providers to check: ${PROVIDER_IDS.join(", ")}
                          Comma-separated or repeated. Default: all
  -f, --format <name>     Output format: pretty (default) or json
  -q, --quiet             Report errors only
      --max-warnings <n>  Exit 1 when more than <n> warnings are found
  -h, --help              Show this help
  -v, --version           Show the version

Files may hold a bare JSON Schema or a tool / response-format definition
(OpenAI tools, Anthropic input_schema, MCP inputSchema); the schema is found automatically.

Exit codes
  0  compatible with every selected provider
  1  errors found (or --max-warnings exceeded)
  2  bad usage or unreadable input
`;

class UsageError extends Error {}

function parseProviders(values: readonly string[] | undefined): ProviderId[] {
  if (!values || values.length === 0) return [...PROVIDER_IDS];
  const ids = values.flatMap((value) => value.split(",")).map((id) => id.trim().toLowerCase());
  for (const id of ids) {
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
      throw new UsageError(`Unknown provider "${id}". Available: ${PROVIDER_IDS.join(", ")}.`);
    }
  }
  return [...new Set(ids)] as ProviderId[];
}

function withoutWarnings(result: LintResult): LintResult {
  return {
    findings: result.findings.filter((finding) => finding.severity === "error"),
    summary: result.summary.map((summary) => ({ ...summary, warnings: 0 })),
  };
}

async function version(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function ruleMeta({ id, provider, severity, summary, source, verified, notes }: RuleMeta): RuleMeta {
  return { id, provider, severity, summary, source, verified, ...(notes ? { notes } : {}) };
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        provider: { type: "string", short: "p", multiple: true },
        format: { type: "string", short: "f", default: "pretty" },
        quiet: { type: "boolean", short: "q", default: false },
        "max-warnings": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });

    if (values.help) {
      io.stdout(HELP);
      return EXIT_OK;
    }
    if (values.version) {
      io.stdout(`${await version()}\n`);
      return EXIT_OK;
    }

    const format = values.format;
    if (format !== "pretty" && format !== "json") {
      throw new UsageError(`Unknown format "${format}". Available: pretty, json.`);
    }
    const selected = parseProviders(values.provider);

    let maxWarnings = Infinity;
    if (values["max-warnings"] !== undefined) {
      maxWarnings = Number(values["max-warnings"]);
      if (!Number.isInteger(maxWarnings) || maxWarnings < 0) {
        throw new UsageError("--max-warnings expects a non-negative integer.");
      }
    }

    if (positionals[0] === "rules") {
      const listed = rules.filter((rule) => selected.includes(rule.provider)).map(ruleMeta);
      io.stdout(format === "json" ? `${JSON.stringify(listed, null, 2)}\n` : `${formatRules(listed, io)}\n`);
      return EXIT_OK;
    }

    if (positionals.length === 0) {
      io.stderr(HELP);
      return EXIT_USAGE;
    }

    const reports: FileReport[] = [];
    for (const file of positionals) {
      const label = file === "-" ? "<stdin>" : file;
      let text: string;
      try {
        text = file === "-" ? await io.readStdin() : await readFile(file, "utf8");
      } catch (error) {
        throw new UsageError(`Cannot read ${label}: ${(error as Error).message}`);
      }

      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch (error) {
        throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`);
      }

      const { schema, wrapper } = unwrap(document);
      try {
        reports.push({ file: label, wrapper, result: lint(schema, { providers: selected }) });
      } catch (error) {
        if (error instanceof TypeError) throw new UsageError(`${label}: ${error.message}`);
        throw error;
      }
    }

    const count = (key: "errors" | "warnings"): number =>
      reports.reduce((sum, { result }) => sum + result.summary.reduce((n, summary) => n + summary[key], 0), 0);
    const errors = count("errors");
    const warnings = count("warnings");

    const shown = values.quiet ? reports.map((report) => ({ ...report, result: withoutWarnings(report.result) })) : reports;

    if (format === "json") {
      const files = shown.map(({ file, wrapper, result }) => ({ file, wrapper, ...result }));
      io.stdout(`${JSON.stringify({ version: await version(), files }, null, 2)}\n`);
    } else {
      io.stdout(formatPretty(shown, io));
    }

    if (warnings > maxWarnings) {
      io.stderr(`schemafit: ${warnings} warnings exceed --max-warnings ${maxWarnings}.\n`);
      return EXIT_FINDINGS;
    }
    return errors > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (error) {
    // parseArgs reports bad flags as TypeErrors carrying an ERR_PARSE_ARGS_* code.
    const code = (error as { code?: unknown }).code;
    if (error instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      io.stderr(`schemafit: ${(error as Error).message}\nRun "schemafit --help" for usage.\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
}
