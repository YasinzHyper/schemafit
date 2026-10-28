import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fix } from "./fix.js";
import { formatFixed, formatPretty, formatRules } from "./format/pretty.js";
import type { FileReport, FixReport, SchemaSource } from "./format/pretty.js";
import { lint, lintRequest, lintSchema, summarize } from "./lint.js";
import { movedPointer } from "./moves.js";
import { fixOpenApi, openApiSchemas, withoutCopiedFindings } from "./openapi.js";
import { displayPointer, resolvePointer } from "./pointer.js";
import { providers } from "./providers/index.js";
import { PROVIDER_IDS } from "./types.js";
import type { AppliedFix, FixResult, LintResult, ProviderId, RuleMeta } from "./types.js";
import { jsonRpcBatch, jsonRpcMessage, rewrap, unwrapAll } from "./unwrap.js";
import type { JsonRpcMessage, UnwrappedSchema } from "./unwrap.js";
import type { OpenApiSchema } from "./openapi.js";
import { readYaml } from "./yaml.js";
import type { YamlBlank, YamlComment } from "./yaml.js";
import { stringifyYaml } from "./yaml-write.js";

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
      --openapi           Read each file as an OpenAPI document and check every
                          schema under components.schemas
  -h, --help              Show this help
  -v, --version           Show the version

Files may hold a bare JSON Schema, a tool / response-format definition
(OpenAI tools, Anthropic input_schema, MCP inputSchema), or a whole request body
or array of tool definitions, in which case every schema in it is reported on its own.
An MCP "tools/list" response may come in the JSON-RPC envelope it arrives in
({"jsonrpc": "2.0", "id": 1, "result": {"tools": [...]}}), so a response captured
off the wire needs no unwrapping by hand. A JSON-RPC batch, which is an array of
those envelopes, is read as one too, and every tool of every response in it is
reported under the index of its own message. A JSON-RPC message that declares no
schema is named for what it is rather than reported as an empty document: an
error response names the code and message of the call that failed, a request or
a notification names its method, and a batch names each of its messages.

A file whose name ends in .yaml or .yml is read as YAML, and stdin is read as
JSON first and as YAML if that is not what it holds. Any of the above may be
written in it. The YAML schemafit reads is the plain kind a schema is written in
— block mappings and sequences, flow collections, quoted and plain scalars,
block scalars, comments — and anything else is an error naming the line and the
construct rather than a guess at what the file meant: an anchor, an alias, a
tag, a second document in one file. A rewrite is written in the format of the
file it goes to: --fix --write rewrites a YAML file as YAML, and so does --out
<file.yaml>, while stdout gets JSON. The comments of a YAML file go back to the
entry they belong to: a comment on a line of its own to the entry below it, and
one after a value to that value's entry, which follows the entry when a fix
moves it: a oneOf renamed to anyOf, a root wrapped in an object, a minimum or a
format folded into description. A comment on an entry the rewrite removes has
nowhere to go, so --write refuses to rewrite a file that holds one, naming its
line, rather than delete it. An empty line between two entries goes back above
the entry below it in the same way, so tool definitions a file kept apart stay
apart.

--openapi checks every schema an OpenAPI document keeps under components.schemas,
each reported under its component name as the schema it would be on its own: the
components it references are copied under $defs, and every
"#/components/schemas/<name>" reference is rewritten to "#/$defs/<name>", which is
how the schema has to be sent for its references to resolve. A finding inside a
copied component is reported once, on that component's own report, unless only the
schema around it shows it. A component that is only ever part of another, an enum
say, is still checked as a root, so expect openai/root-object on it; the schemas are
checked as written, so an OpenAPI 3.0 "nullable" is read as the keyword it is.
With --fix, each component is rewritten as that schema and put back under
components.schemas without the copies, so a fix lands once, in the component it
belongs to. A component's root is not wrapped in an object for openai/root-object,
because every reference to it would change meaning with it.

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

/** The file names schemafit reads as YAML rather than as JSON. */
const YAML_EXTENSIONS = [".yaml", ".yml"];

function isYamlFile(file: string): boolean {
  const lower = file.toLowerCase();
  return YAML_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A document as read, with its comments and empty lines when it was read as YAML. */
interface ReadDocument {
  label: string;
  document: unknown;
  comments?: YamlComment[];
  blanks?: YamlBlank[];
}

/**
 * Reads one file as the format its name declares: YAML for a `.yaml` or `.yml` file, JSON for
 * everything else. Stdin has no name to read the format off, so it is parsed as JSON first and
 * as YAML only if that fails — every JSON document is YAML too, so trying JSON first costs
 * nothing and keeps its error for the far more common case of a JSON document with a typo.
 */
async function readDocument(file: string, io: CliIo): Promise<ReadDocument> {
  const label = file === "-" ? "<stdin>" : file;
  let text: string;
  try {
    text = file === "-" ? await io.readStdin() : await readFile(file, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read ${label}: ${(error as Error).message}`);
  }

  if (isYamlFile(file)) {
    try {
      return { label, ...yamlDocument(text) };
    } catch (error) {
      throw new UsageError(`${label} is not YAML schemafit can read: ${(error as Error).message}`);
    }
  }

  try {
    return { label, document: JSON.parse(text) as unknown };
  } catch (error) {
    if (file !== "-") throw new UsageError(`${label} is not valid JSON: ${(error as Error).message}`);
    try {
      return { label, ...yamlDocument(text) };
    } catch (yamlError) {
      throw new UsageError(`${label} is neither valid JSON nor YAML schemafit can read: ${(yamlError as Error).message}`);
    }
  }
}

function yamlDocument(text: string): { document: unknown; comments: YamlComment[]; blanks: YamlBlank[] } {
  const { value, attached, blanks } = readYaml(text);
  return { document: value, comments: attached, blanks };
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

/** How many of a batch's messages a reason names one by one before it counts the rest. */
const NAMED_BATCH_MESSAGES = 3;

/** What one message of a batch is, as a phrase a sentence can list several of. */
function messagePhrase({ kind, method, code, message }: JsonRpcMessage): string {
  switch (kind) {
    case "error": {
      const detail = [code, message === undefined ? undefined : JSON.stringify(message)]
        .filter((part) => part !== undefined)
        .join(": ");
      return detail ? `an error response (error ${detail})` : "an error response";
    }
    case "request":
      return `a request for ${JSON.stringify(method)}`;
    case "notification":
      return `a notification of ${JSON.stringify(method)}`;
    case "result":
      return "a response whose result declares none";
    case "invalid":
      return "an entry that is not a JSON-RPC message";
    default:
      return "a message with neither a result nor an error nor a method";
  }
}

/**
 * Why a JSON-RPC batch holds no schema, which names every message in it the way a single
 * message is named: a batch of failures reads as the failures it is rather than as an empty
 * file. Long batches are named up to a few messages in and counted after that, so a capture of
 * fifty notifications says what it is in one line.
 */
function noSchemaInBatch(label: string, messages: readonly JsonRpcMessage[]): string {
  const named = messages.slice(0, NAMED_BATCH_MESSAGES).map(messagePhrase);
  const rest = messages.length - named.length;
  const listed = [...named, ...(rest > 0 ? [`and ${rest} more`] : [])].join("; ");
  const count = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  return `${label} is a JSON-RPC batch of ${count}, none of which declares a schema: ${listed}. A schema arrives in the result of a "tools/list" call, one per tool under "inputSchema".`;
}

/**
 * Why a document holds no schema. A JSON-RPC message is named for what it is, because a call
 * captured off the wire is a far more likely input than a file that happens to hold none, and
 * a failed call read as an empty file sends you looking for the wrong mistake: the reason the
 * response carries no tool is in its own error object.
 */
function noSchemaReason(label: string, document: unknown): string {
  const batch = jsonRpcBatch(document);
  if (batch !== undefined) return noSchemaInBatch(label, batch);

  const message = jsonRpcMessage(document);
  if (message === undefined) {
    return `${label} holds no schema to check; no tool or response format in it declares one.`;
  }
  const { kind, method, code, message: text } = message;
  switch (kind) {
    case "error": {
      const detail = code === undefined ? "" : ` ${code}`;
      const quoted = text === undefined ? "" : `: ${JSON.stringify(text)}`;
      return `${label} is a JSON-RPC error response: the call failed with error${detail}${quoted}. A failed call carries no result, and so no schema to check.`;
    }
    case "request":
      return `${label} is a JSON-RPC request for ${JSON.stringify(method)}, not a response: a schema arrives in the result of a "tools/list" call, not in the call itself.`;
    case "notification":
      return `${label} is a JSON-RPC notification of ${JSON.stringify(method)}, which is answered by no response and so declares no schema.`;
    case "result":
      return `${label} is a JSON-RPC response, but its result declares no schema; a "tools/list" result declares one per tool, under "inputSchema".`;
    default:
      return `${label} is a JSON-RPC message with neither a result nor an error nor a method, so it declares no schema.`;
  }
}

/**
 * Reads one file as an OpenAPI document and finds every schema component in it. A document
 * with none is a usage error, and so is a component whose `$defs` cannot take the components
 * it references.
 */
async function readOpenApi(file: string, io: CliIo): Promise<ReadDocument & { schemas: OpenApiSchema[] }> {
  const read = await readDocument(file, io);
  const { label, document } = read;
  let schemas: OpenApiSchema[];
  try {
    schemas = openApiSchemas(document);
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(`${label}: ${error.message}`);
    throw error;
  }
  if (schemas.length === 0) {
    throw new UsageError(`${label} declares no schema under components.schemas, which is where --openapi looks.`);
  }
  return { ...read, schemas };
}

/** Lints every schema component of an OpenAPI document, each as its own request. */
async function lintOpenApi(file: string, selected: readonly ProviderId[], io: CliIo): Promise<FileReport[]> {
  const { label, schemas } = await readOpenApi(file, io);
  const results = schemas.map((found) => {
    try {
      return lint(found.schema, { providers: selected });
    } catch (error) {
      if (error instanceof TypeError) throw new UsageError(`${at(label, found)}: ${error.message}`);
      throw error;
    }
  });
  const deduplicated = withoutCopiedFindings(schemas, results, (findings) => summarize(findings, selected));
  return schemas.map((found, index) => ({
    ...sourceOf(label, found, true),
    result: deduplicated[index] as LintResult,
  }));
}

/** Reads one file and finds every schema in it. A document with none is a usage error. */
async function readSchemas(file: string, io: CliIo): Promise<ReadDocument & { schemas: UnwrappedSchema[] }> {
  const read = await readDocument(file, io);
  const schemas = unwrapAll(read.document);
  if (schemas.length === 0) throw new UsageError(noSchemaReason(read.label, read.document));
  return { ...read, schemas };
}

/** What `--fix` was asked to do, beyond the files it reads. */
interface FixRequest {
  providers: readonly ProviderId[];
  out: string | undefined;
  write: boolean;
  pruneUnusedDefs: boolean;
  allTools: boolean;
  openapi: boolean;
}

/** One file rewritten in memory: the document to write out, and one report per schema in it. */
interface PlannedFix {
  file: string;
  output: string;
  reports: FixReport[];
  /** What the run left out, and what it did to the file's format, when there is anything to say. */
  notes: string[];
}

/** Rewrites every schema of one file for the selected providers, without writing anything. */
async function planFix(file: string, request: FixRequest, io: CliIo): Promise<PlannedFix> {
  const { providers, out, write, pruneUnusedDefs, allTools } = request;
  const { label, document, schemas, comments = [], blanks = [] } = request.openapi
    ? await readOpenApi(file, io)
    : await readSchemas(file, io);
  // The reports name the file the schemas end up in, which --out renames and --write does not.
  const destination = write ? label : (out ?? label);
  // A schema the request does not send strictly is left exactly as it was. The rewrites trade a
  // constraint away for a subset rule — a "minimum" moved into "description", a dropped
  // "format" — and a non-strict schema is bound by no such rule: the model is still shown the
  // constraint, and your own validator still reads it, so the trade would be a loss for nothing.
  // A component of an OpenAPI document declares no "strict", so every one of them is fixed.
  const { checked, skipped } = selectStrict(schemas, allTools);
  const components = request.openapi ? fixComponents(label, document, { providers, pruneUnusedDefs }) : undefined;

  const reports: FixReport[] = [];
  // Each comment and empty line follows its entry through the fixes that move one, a rename or
  // a wrapped root.
  let moved = comments;
  let movedBlanks = blanks;
  let rewritten: unknown = document;
  for (const [index, found] of checked.entries()) {
    let result: FixResult;
    try {
      result = components?.[index] ?? fix(found.schema, { providers, pruneUnusedDefs });
    } catch (error) {
      if (error instanceof TypeError) throw new UsageError(`${at(label, found)}: ${error.message}`);
      throw error;
    }
    // Each rewrite goes back where it came from, so a request body comes out whole, and a
    // component without the copies of the components it references.
    rewritten = rewrap(rewritten, found.keys, result.schema);
    for (const applied of result.applied) {
      moved = moved.map((comment) => follow(comment, found.pointer, applied));
      movedBlanks = movedBlanks.map((blank) => follow(blank, found.pointer, applied));
    }
    reports.push({ ...sourceOf(destination, found, request.openapi || schemas.length > 1), ...result });
  }

  // The rewrite is written in the format the name of the file it goes to declares. Stdout has
  // no name, so it gets JSON, and a YAML file rewritten there is said to have changed format.
  const yaml = isYamlFile(write ? file : (out ?? ""));
  const changed = reports.some((report) => report.applied.length > 0);
  // Each comment goes back to the entry it belongs to, which the rewrite may have taken out.
  const kept = moved.filter((comment) => keepsEntry(comment, rewritten));
  const lost = moved.filter((comment) => !kept.includes(comment)).map(({ line }) => line);
  if (write && yaml && changed && lost[0] !== undefined) {
    // Writing the rewrite over the file would delete those comments, and an in-place rewrite
    // must not lose what it cannot see.
    throw new UsageError(
      `--write cannot rewrite ${label} in place: ${linesOf(lost)} a comment on an entry the rewrite removes or moves, which it would drop. Move the comment to an entry the rewrite keeps, or write the rewrite to --out <file> and carry it over by hand.`,
    );
  }
  const formatNote = isYamlFile(file) && !yaml ? `schemafit: ${label}: read as YAML, rewritten as JSON.\n` : undefined;
  const commentNote =
    !write && yaml && lost[0] !== undefined
      ? `schemafit: ${label}: ${linesOf(lost)} a comment on an entry the rewrite removes or moves, which ${destination} does not carry over.\n`
      : undefined;
  const notes = [formatNote, commentNote, skippedNote(label, skipped, checked.length)].filter((note) => note !== undefined);
  // --write leaves a file no fix changed as it is, so there is nothing to write out for it.
  const unwritten = write && !changed;
  // An empty line on an entry the rewrite removes says nothing, so it goes without a word.
  const keptBlanks = movedBlanks.filter((blank) => keepsEntry(blank, rewritten));
  const output = unwritten ? "" : yaml ? stringifyYaml(rewritten, kept, keptBlanks) : `${JSON.stringify(rewritten, null, 2)}\n`;
  return { file, output, reports, notes };
}

/**
 * Every schema component of an OpenAPI document, fixed and back in its own shape: what a fix
 * made of the copies of other components is dropped, since each is fixed where it is declared.
 */
function fixComponents(label: string, document: unknown, options: Pick<FixRequest, "providers" | "pruneUnusedDefs">): FixResult[] {
  try {
    return fixOpenApi(document, options).components.map(({ schema, applied, findings, summary }) => ({
      schema,
      applied,
      findings,
      summary,
    }));
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(`${label}: ${error.message}`);
    throw error;
  }
}

/** A comment or an empty line, moved to where `applied` put its entry. */
function follow<T extends { pointer: string | null }>(item: T, schema: string, applied: AppliedFix): T {
  return item.pointer === null ? item : { ...item, pointer: movedPointer(item.pointer, schema, applied) };
}

/** Whether the entry a comment or an empty line belongs to is still in the rewritten document. */
function keepsEntry({ pointer }: { pointer: string | null }, document: unknown): boolean {
  return pointer === null || resolvePointer(document, pointer) !== undefined;
}

/** "line 3 holds", "lines 3 and 7 hold", "lines 3, 7 and 9 hold". */
function linesOf(lines: readonly number[]): string {
  if (lines.length === 1) return `line ${lines[0]} holds`;
  return `lines ${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]} hold`;
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
  for (const { file, output, reports, notes } of planned) {
    for (const note of notes) io.stderr(note);
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
        openapi: { type: "boolean", default: false },
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
        openapi: values.openapi,
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
      // A component is a schema of its own, not one tool of a request, so each one is measured
      // as the whole request it would be when sent, and there is no request around them to report.
      if (values.openapi) {
        reports.push(...(await lintOpenApi(file, selected, io)));
        continue;
      }
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
