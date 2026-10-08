import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fix } from "./fix.js";
import { formatFixed, formatPretty, formatRules } from "./format/pretty.js";
import type { FileReport, FixReport, SchemaSource } from "./format/pretty.js";
import { lint, lintRequest, lintSchema } from "./lint.js";
import { displayPointer } from "./pointer.js";
import { providers } from "./providers/index.js";
import { PROVIDER_IDS } from "./types.js";
import type { LintResult, ProviderId, RuleMeta } from "./types.js";
import { rewrap, unwrapAll } from "./unwrap.js";
import type { UnwrappedSchema } from "./unwrap.js";

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
  schemafit --fix [-p <ids>] <file> Rewrite one file for the selected providers
  schemafit --fix --write <file...> Rewrite files in place
  schemafit rules [options]         List the rules

Options
  -p, --provider <ids>    Providers to check: ${PROVIDER_IDS.join(", ")}
                          Comma-separated or repeated. Default: all
  -f, --format <name>     Output format: pretty (default) or json
  -q, --quiet             Report errors only
      --max-warnings <n>  Exit 1 when more than <n> warnings are found
      --fix               Apply every available fix and write the schema out
      --prune-unused-defs
                          With --fix, also remove the definitions the input
                          left unreferenced
  -o, --out <file>        With --fix, write there instead of stdout
  -w, --write             With --fix, rewrite each file in place
      --all-tools         Check every schema a document declares, including the
                          ones it sends non-strictly ("strict": false)
  -h, --help              Show this help
  -v, --version           Show the version

Files may hold a bare JSON Schema, a tool / response-format definition
(OpenAI tools, Anthropic input_schema, MCP inputSchema), or a whole request body
or array of tool definitions, in which case every schema in it is reported on its own.
An MCP "tools/list" response may come in the JSON-RPC envelope it arrives in
({"jsonrpc": "2.0", "id": 1, "result": {"tools": [...]}}), so a response captured
off the wire needs no unwrapping by hand. A JSON-RPC message that declares no
schema — a request, a notification, an error response — is reported as holding
none rather than checked as if the envelope were a schema.

A declaration that sets "strict": false opts out of its provider's strict decoding, and
with it the schema subset these rules check: OpenAI calls such a tool best-effort, and
Anthropic compiles a grammar only for the schemas it is sending strictly. So a schema
declared "strict": false is reported on only with --all-tools. One that says nothing about
strict is checked, because the Responses API normalizes such a tool into strict mode when
the schema allows it.

A limit a provider states per request rather than per schema — Anthropic allows 20 strict
tools, 24 optional parameters, and 16 parameters with union types in one request — is
measured over every schema the request sends strictly and reported for the request as a
whole, after the reports on its schemas. A tool that sets "strict": false is left out.

--fix takes one file and rewrites it for every selected provider at once, so with no
--provider it produces the most portable schema the rules can reach: the one all of them
accept. Narrow it with --provider to keep the constraints the others do not support, which
a portable rewrite has to give up. It keeps the wrapper the schema came in, reports what it
changed on stderr so stdout stays pipeable, and leaves findings that have no fix alone.
"schemafit rules" marks the rules it can fix.

--write rewrites every file given in place instead of writing one to stdout, so --fix
can run over a directory of schemas or as a pre-commit hook. Every file is read and
rewritten before any of them is written out, and a file no fix changed is left untouched.

--prune-unused-defs drops every definition no $ref reaches, not only the ones --fix
orphans itself. It changes nothing about what the schema accepts, and it frees the
size budget an unused definition spends. Leave it off if another document $refs into
this one.

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

function ruleMeta({ id, provider, severity, summary, source, verified, scope, fixable, notes }: RuleMeta): RuleMeta {
  return {
    id,
    provider,
    severity,
    summary,
    source,
    verified,
    ...(scope ? { scope } : {}),
    ...(fixable ? { fixable } : {}),
    ...(notes ? { notes } : {}),
  };
}

async function readDocument(file: string, io: CliIo): Promise<{ label: string; document: unknown }> {
  const label = file === "-" ? "<stdin>" : file;
  let text: string;
  try {
    text = file === "-" ? await io.readStdin() : await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${label}: ${(error as Error).message}`);
  }

  try {
    return { label, document: JSON.parse(text) as unknown };
  } catch (error) {
    throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

/** Names a schema inside a document, for an error about that schema alone. */
function at(label: string, found: UnwrappedSchema): string {
  return found.pointer ? `${label} at ${displayPointer(found.pointer)}` : label;
}

/**
 * Where one schema of a document sits, for the report header and the JSON output. The pointer
 * is what tells several reports on one file apart, so a document that holds a single schema
 * is reported by its file name alone, exactly as it was before a document could hold several.
 */
function sourceOf(file: string, found: UnwrappedSchema, several: boolean): SchemaSource {
  return {
    file,
    wrapper: found.wrapper,
    ...(several && found.pointer ? { pointer: found.pointer } : {}),
    ...(found.name ? { name: found.name } : {}),
  };
}

/**
 * The schemas to check, and the ones the document declares but does not send strictly.
 *
 * A declaration that sets `"strict": false` opts out of the provider's strict decoding, and
 * with it the schema subset these rules describe: OpenAI documents such a tool as "non-strict,
 * best-effort function calling", and only "if you send `strict: true` and your schema does not
 * meet the requirements" is the request rejected; Anthropic's limitations are the ones "JSON
 * outputs and strict tool use share", and a non-strict tool's `input_schema` is never compiled
 * into a grammar. Reporting the subset against such a schema is a false positive, so it is left
 * out unless `--all-tools` asks for it.
 *
 * A declaration that says nothing about `strict` is checked: the Responses API "will attempt to
 * normalize your schema into strict mode when possible", so whether the subset is met is what
 * decides between strict and best-effort decoding there.
 */
function selectStrict(
  schemas: readonly UnwrappedSchema[],
  allTools: boolean,
): { checked: UnwrappedSchema[]; skipped: UnwrappedSchema[] } {
  if (allTools) return { checked: [...schemas], skipped: [] };
  return {
    checked: schemas.filter((found) => found.strict !== false),
    skipped: schemas.filter((found) => found.strict === false),
  };
}

/** How the note names one schema that was left out: its definition's name, or where it sits. */
function labelOf(found: UnwrappedSchema): string {
  return found.name ?? (found.pointer ? displayPointer(found.pointer) : "the schema");
}

/**
 * The stderr note for the schemas a run left out, so a report that covers fewer says so rather
 * than looking like a clean bill of health. Returns undefined when nothing was left out.
 */
function skippedNote(label: string, skipped: readonly UnwrappedSchema[], checked: number): string | undefined {
  if (skipped.length === 0) return undefined;
  const what = checked === 0 ? "every schema it declares" : skipped.map(labelOf).join(", ");
  return `schemafit: ${label}: skipped ${what} — "strict": false, so the strict subset does not apply. Use --all-tools to check them too.\n`;
}

/** Reads one file and finds every schema in it. A document with none is a usage error. */
async function readSchemas(file: string, io: CliIo): Promise<{ label: string; document: unknown; schemas: UnwrappedSchema[] }> {
  const { label, document } = await readDocument(file, io);
  const schemas = unwrapAll(document);
  if (schemas.length === 0) {
    throw new UsageError(`${label} holds no schema to check; no tool or response format in it declares one.`);
  }
  return { label, document, schemas };
}

/** What `--fix` was asked to do, beyond the files it reads. */
interface FixRequest {
  providers: readonly ProviderId[];
  out: string | undefined;
  write: boolean;
  pruneUnusedDefs: boolean;
  allTools: boolean;
}

/** One file rewritten in memory: the document to write out, and one report per schema in it. */
interface PlannedFix {
  file: string;
  output: string;
  reports: FixReport[];
  /** What the run left out, when it left anything out. */
  note: string | undefined;
}

/** Rewrites every schema of one file for the selected providers, without writing anything. */
async function planFix(file: string, { providers, out, write, pruneUnusedDefs, allTools }: FixRequest, io: CliIo): Promise<PlannedFix> {
  const { label, document, schemas } = await readSchemas(file, io);
  // The reports name the file the schemas end up in, which --out renames and --write does not.
  const destination = write ? label : (out ?? label);
  // A schema the request does not send strictly is left exactly as it was. The rewrites trade a
  // constraint away for a subset rule — a "minimum" moved into "description", a dropped
  // "format" — and a non-strict schema is bound by no such rule: the model is still shown the
  // constraint, and your own validator still reads it, so the trade would be a loss for nothing.
  const { checked, skipped } = selectStrict(schemas, allTools);

  const reports: FixReport[] = [];
  let rewritten: unknown = document;
  for (const found of checked) {
    let result;
    try {
      result = fix(found.schema, { providers, pruneUnusedDefs });
    } catch (error) {
      if (error instanceof TypeError) throw new UsageError(`${at(label, found)}: ${error.message}`);
      throw error;
    }
    // Each rewrite goes back where it came from, so a request body comes out whole.
    rewritten = rewrap(rewritten, found.keys, result.schema);
    reports.push({ ...sourceOf(destination, found, schemas.length > 1), ...result });
  }

  const note = skippedNote(label, skipped, checked.length);
  return { file, output: `${JSON.stringify(rewritten, null, 2)}\n`, reports, note };
}

async function writeOut(file: string, output: string): Promise<void> {
  try {
    await writeFile(file, output);
  } catch (error) {
    throw new UsageError(`Cannot write ${file}: ${(error as Error).message}`);
  }
}

/** Rewrites every given file for the selected providers and reports what changed on stderr. */
async function runFix(files: readonly string[], request: FixRequest, io: CliIo): Promise<number> {
  // Nothing is written until every file has been read and rewritten, so a file that cannot
  // be read or parsed fails the run before --write has rewritten the files ahead of it.
  const planned: PlannedFix[] = [];
  for (const file of files) planned.push(await planFix(file, request, io));

  let rewritten = 0;
  let printed = 0;
  for (const { file, output, reports, note } of planned) {
    if (note) io.stderr(note);
    if (request.write) {
      // Only a file some fix actually changed is written, so a run over a tree of schemas
      // leaves the ones that already fit as they are, formatting and mtime included.
      if (reports.some((report) => report.applied.length > 0)) {
        await writeOut(file, output);
        rewritten += 1;
      }
    } else if (request.out !== undefined) {
      await writeOut(request.out, output);
    } else {
      io.stdout(output);
    }
    // A blank line between reports, so a run over many files or schemas is readable.
    for (const report of reports) {
      io.stderr(printed > 0 ? `\n${formatFixed(report, io)}` : formatFixed(report, io));
      printed += 1;
    }
  }

  if (request.write && planned.length > 1) io.stderr(`schemafit: rewrote ${rewritten} of ${planned.length} files.\n`);
  const reports = planned.flatMap(({ reports: own }) => own);
  return reports.some((report) => report.summary.some((summary) => summary.errors > 0)) ? EXIT_FINDINGS : EXIT_OK;
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
        fix: { type: "boolean", default: false },
        "prune-unused-defs": { type: "boolean", default: false },
        out: { type: "string", short: "o" },
        write: { type: "boolean", short: "w", default: false },
        "all-tools": { type: "boolean", default: false },
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

    if (values.out !== undefined && !values.fix) {
      throw new UsageError("--out only applies with --fix.");
    }
    if (values.write && !values.fix) {
      throw new UsageError("--write only applies with --fix.");
    }
    if (values.out !== undefined && values.write) {
      throw new UsageError("--out and --write cannot be combined; --write rewrites each file in place.");
    }
    if (values["prune-unused-defs"] && !values.fix) {
      throw new UsageError("--prune-unused-defs only applies with --fix.");
    }

    if (values.fix) {
      if (positionals[0] === "rules") throw new UsageError("--fix does not apply to the rules subcommand.");
      if (positionals.length === 0) {
        throw new UsageError(values.write ? "--fix --write takes at least one file." : "--fix takes exactly one file.");
      }
      if (!values.write && positionals.length > 1) {
        throw new UsageError("--fix takes exactly one file; add --write to rewrite several in place.");
      }
      if (values.write && positionals.includes("-")) {
        throw new UsageError("--write cannot rewrite stdin; drop it to get the rewritten schema on stdout.");
      }
      const request = {
        providers: selected,
        out: values.out,
        write: values.write,
        pruneUnusedDefs: values["prune-unused-defs"],
        allTools: values["all-tools"],
      };
      return await runFix(positionals, request, io);
    }

    if (positionals[0] === "rules") {
      const listed = selected
        .flatMap((id) => [...providers[id].rules, ...(providers[id].requestRules ?? [])])
        .map(ruleMeta);
      io.stdout(format === "json" ? `${JSON.stringify(listed, null, 2)}\n` : `${formatRules(listed, io)}\n`);
      return EXIT_OK;
    }

    if (positionals.length === 0) {
      io.stderr(HELP);
      return EXIT_USAGE;
    }

    const reports: FileReport[] = [];
    for (const file of positionals) {
      const { label, document, schemas } = await readSchemas(file, io);
      const { checked, skipped } = selectStrict(schemas, values["all-tools"]);
      const note = skippedNote(label, skipped, checked.length);
      if (note) io.stderr(note);
      // A document that holds one schema is that schema's whole request, so `lint` covers both
      // what the schema says and what the request-wide limits make of it. Several schemas are
      // measured together instead, in one report of their own, so neither is reported twice.
      // Which schemas are reported on does not change that: a request body is still a request,
      // and `lintRequest` counts the ones it sends strictly whether or not they were reported.
      const several = schemas.length > 1;
      for (const found of checked) {
        try {
          const result = several
            ? lintSchema(found.schema, { providers: selected })
            : lint(found.schema, { providers: selected });
          reports.push({ ...sourceOf(label, found, several), result });
        } catch (error) {
          if (error instanceof TypeError) throw new UsageError(`${at(label, found)}: ${error.message}`);
          throw error;
        }
      }
      if (several) {
        const result = lintRequest(document, { providers: selected });
        // A request within every limit has nothing to add to the reports on its schemas.
        if (result.findings.length > 0) reports.push({ file: label, wrapper: null, scope: "request", result });
      }
    }

    const count = (key: "errors" | "warnings"): number =>
      reports.reduce((sum, { result }) => sum + result.summary.reduce((n, summary) => n + summary[key], 0), 0);
    const errors = count("errors");
    const warnings = count("warnings");

    const shown = values.quiet ? reports.map((report) => ({ ...report, result: withoutWarnings(report.result) })) : reports;

    if (format === "json") {
      const files = shown.map(({ result, ...source }) => ({ ...source, ...result }));
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
