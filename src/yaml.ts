/**
 * A reader for the YAML a JSON Schema is written in.
 *
 * It covers what schemas use — block mappings and sequences, flow collections, quoted and
 * plain scalars spread over as many lines as they need, literal and folded block scalars,
 * comments, the YAML 1.2 core resolution of `null`, `true`, numbers — and refuses the rest by
 * name instead of guessing at it: an anchor, an alias, a tag, a merge key, a second document, a
 * tab in the indentation, a quoted scalar or a flow collection continued on the next line. A
 * linter that misreads its input reports findings against a schema nobody wrote, so a construct
 * this cannot read with certainty is an error naming the line it is on rather than a value that
 * may or may not be what the file said.
 */

/** A YAML this reader declined to read, and the line it gave up on. */
export class YamlError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

/** One line of the document, tokenized once so the parser can look ahead by line. */
interface Line {
  /** 1-based, for the errors. */
  n: number;
  /** The line as written, which a block scalar takes verbatim. */
  raw: string;
  indent: number;
  /** The content, with the indentation, any trailing comment, and trailing spaces removed. */
  text: string;
  /** Whether a trailing comment was taken off, which ends the plain scalar on the line. */
  comment: boolean;
}

/** The lines, and how far through them the parser is. */
interface State {
  lines: Line[];
  index: number;
}

/** One line being read left to right, for the scalars and flow collections written on it. */
interface Scanner {
  text: string;
  pos: number;
  line: Line;
}

const DOCUMENT_START = "---";
const DOCUMENT_END = "...";

/** What the YAML 1.2 core schema resolves a plain scalar to, where JSON has an equivalent. */
const NULLS = new Set(["", "~", "null", "Null", "NULL"]);
const TRUES = new Set(["true", "True", "TRUE"]);
const FALSES = new Set(["false", "False", "FALSE"]);
const INTEGER = /^[-+]?[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;
const OCTAL = /^0o[0-7]+$/;
const FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/;
const SPECIAL_FLOAT = /^[-+]?\.(inf|Inf|INF|nan|NaN|NAN)$/;

/** What a plain scalar cannot start with, and the YAML feature that character introduces. */
const INDICATORS: ReadonlyArray<[RegExp, string]> = [
  [/^&\S/, 'an anchor ("&name")'],
  [/^\*\S/, 'an alias ("*name")'],
  [/^!/, 'a tag ("!...")'],
  [/^\?(\s|$)/, 'an explicit key ("? ")'],
  [/^<<(\s*:|$)/, 'a merge key ("<<")'],
  [/^%/, 'a directive ("%...")'],
  [/^[@`]/, "a character YAML reserves"],
];

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  " ": " ",
  N: "\u0085",
  _: " ",
  L: " ",
  P: " ",
};

/** The width of the hex escapes, by their letter. */
const HEX_ESCAPES: Record<string, number> = { x: 2, u: 4, U: 8 };

/**
 * Reads a YAML document into the value it describes. Throws a `YamlError` for a YAML it does
 * not cover, naming the construct and the line, and for one that is not valid YAML at all.
 */
export function parseYaml(text: string): unknown {
  const state: State = { lines: tokenize(text), index: 0 };

  const first = peek(state);
  if (first === undefined) return null;
  if (first.text === DOCUMENT_START) state.index += 1;
  else if (first.text.startsWith(`${DOCUMENT_START} `)) {
    throw new YamlError(first.n, `content on the same line as "${DOCUMENT_START}"; put it on the line below`);
  }

  const value = parseNode(state, 0);

  const rest = peek(state);
  if (rest === undefined) return value;
  if (rest.text === DOCUMENT_END) {
    state.index += 1;
    const after = peek(state);
    if (after === undefined) return value;
    throw new YamlError(after.n, `content after the "${DOCUMENT_END}" end-of-document marker`);
  }
  throw new YamlError(rest.n, "a second YAML document; schemafit reads one document per file");
}

/** Splits the text into lines and strips what the parser never looks at. */
function tokenize(text: string): Line[] {
  return text.split("\n").map((written, index) => {
    const n = index + 1;
    const raw = written.endsWith("\r") ? written.slice(0, -1) : written;
    const indent = raw.length - raw.trimStart().length;
    if (raw.slice(0, indent).includes("\t")) {
      throw new YamlError(n, "a tab in the indentation; YAML indents with spaces only");
    }
    const content = raw.slice(indent);
    const text = stripComment(content);
    return { n, raw, indent, text, comment: text !== content.trimEnd() };
  });
}

/**
 * The content of a line without its trailing comment. A `#` counts as one where YAML says it
 * does: at the start, or after a space, and outside a quoted scalar. A quote only opens a
 * scalar where one can start — at the beginning, or after a space or a flow punctuation mark —
 * so the apostrophe in `title: the user's name # a comment` is a character of the scalar and
 * leaves the comment a comment. The `''` a single-quoted scalar spells a quote with leaves that
 * scalar open, the way `readSingleQuoted` reads it, so the `#` in `title: 'don''t # here'` is a
 * character of the string rather than the start of a comment.
 */
function stripComment(content: string): string {
  let quote: string | undefined;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') i += 1;
      // `''` is one quote inside the scalar, not the end of it and the start of another.
      else if (char === "'" && quote === "'" && content[i + 1] === "'") i += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if ((char === '"' || char === "'") && (i === 0 || " ,[{".includes(content[i - 1] ?? ""))) quote = char;
    else if (char === "#" && (i === 0 || content[i - 1] === " ")) return content.slice(0, i).trimEnd();
  }
  return content.trimEnd();
}

/** The next line that holds content, skipping the blank and comment-only ones. */
function peek(state: State): Line | undefined {
  while (state.index < state.lines.length && state.lines[state.index]?.text === "") state.index += 1;
  return state.lines[state.index];
}

function isDocumentMarker(text: string): boolean {
  return text === DOCUMENT_START || text === DOCUMENT_END || text.startsWith(`${DOCUMENT_START} `);
}

/** Whether a line starts a sequence item. A `-` not followed by a space is a plain scalar. */
function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/** Where a block mapping's line ends its key, or undefined when the line is not one. */
function findKeyEnd(line: Line): number | undefined {
  const { text } = line;
  if (text.startsWith('"') || text.startsWith("'")) {
    let end: number;
    try {
      const scanner: Scanner = { text, pos: 0, line };
      readQuoted(scanner);
      end = scanner.pos;
    } catch {
      return undefined;
    }
    const after = text.slice(end);
    return after === ":" || after.startsWith(": ") ? end : undefined;
  }
  // A flow collection is a node of its own, not a key, and it is the only thing a `[` or `{`
  // can start here. Anywhere else they are part of a plain scalar, which may be a key.
  if (text.startsWith("[") || text.startsWith("{")) return undefined;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ":" && (i === text.length - 1 || text[i + 1] === " ")) return i;
  }
  return undefined;
}

/** The node that starts on the next line, at `indent`. */
function parseNode(state: State, indent: number): unknown {
  const line = peek(state);
  if (line === undefined || isDocumentMarker(line.text) || line.indent < indent) return null;
  if (isSequenceEntry(line.text)) return parseSequence(state, line.indent, false);
  if (findKeyEnd(line) === undefined) {
    // Not a mapping entry, so the line is the whole node: a scalar, or a flow collection.
    state.index += 1;
    // A continuation line clears the indentation of the line the scalar starts on, not one
    // more: the `one` and `two` of a `key:` whose value is written below it line up, and the
    // two of them are the one scalar.
    return parseScalarOnLines(state, line, line.text, line.indent);
  }
  return parseMapping(state, line.indent);
}

function parseMapping(state: State, indent: number): Record<string, unknown> {
  const mapping: Record<string, unknown> = {};
  for (;;) {
    const line = peek(state);
    if (line === undefined || isDocumentMarker(line.text) || line.indent < indent) return mapping;
    if (line.indent > indent) {
      throw new YamlError(line.n, "indented further than the mapping it belongs to");
    }
    if (isSequenceEntry(line.text)) {
      throw new YamlError(line.n, 'a sequence item ("- ") where a mapping key was expected');
    }
    rejectIndicators(line, line.text);

    const end = findKeyEnd(line);
    if (end === undefined) {
      throw new YamlError(line.n, 'expected "key: value"; a key ends at a colon followed by a space');
    }
    const key = parseKey(line, line.text.slice(0, end));
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlError(line.n, `duplicate key ${JSON.stringify(key)}`);
    }

    const rest = line.text.slice(end + 1).trim();
    state.index += 1;
    mapping[key] = rest === "" ? parseNodeBelow(state, indent) : parseValueOnLine(state, line, rest, indent);
  }
}

/**
 * A mapping key, which JSON needs to be a string. A plain key YAML resolves to something else
 * is an error rather than a key stringified behind your back: `1: x` and `null: x` are the kind
 * of mistake a schema's author wants to hear about.
 */
function parseKey(line: Line, text: string): string {
  const value = parseInline(text, line);
  if (typeof value === "string") return value;
  throw new YamlError(line.n, `the key ${JSON.stringify(text)} is not a string; quote it to use it as a property name`);
}

/**
 * The value of a key with nothing after its colon, which is the block below it. A sequence may
 * sit at the key's own indentation, which is how most YAML writes one; anything else has to be
 * indented further, and a key followed by neither has an empty value.
 */
function parseNodeBelow(state: State, indent: number): unknown {
  const next = peek(state);
  if (next !== undefined && !isDocumentMarker(next.text) && next.indent === indent && isSequenceEntry(next.text)) {
    return parseSequence(state, indent, true);
  }
  return parseBlockIndentedBelow(state, indent);
}

/**
 * The block indented further than the line above it, and nothing else. This is all an empty
 * sequence entry can take its value from: YAML 1.2 section 8.2.1 puts a collection nested in an
 * entry past the dash (productions 183 and 186, at `n+1+m`), so a dash at the entry's own
 * indentation starts the next entry rather than a sequence inside this one, and an entry left
 * with nothing is the `e-node` of production 185, which section 7.2 resolves to null.
 */
function parseBlockIndentedBelow(state: State, indent: number): unknown {
  const next = peek(state);
  if (next === undefined || isDocumentMarker(next.text) || next.indent <= indent) return null;
  return parseNode(state, next.indent);
}

/** The value written after a key's colon, or after a sequence item's dash. */
function parseValueOnLine(state: State, line: Line, rest: string, indent: number): unknown {
  if (rest.startsWith("|") || rest.startsWith(">")) return parseBlockScalar(state, line, rest, indent);
  rejectIndicators(line, rest);
  return parseScalarOnLines(state, line, rest, indent + 1);
}

/**
 * The value written on a line, together with the lines below that continue it. A plain scalar
 * runs on over every line indented to at least `minIndent`, and they are folded into it, which
 * is YAML 1.2 section 7.3.3 (production 135, `ns-plain-multi(n,c)`) and how a description long
 * enough to wrap is written without a block scalar. A quoted scalar and a flow collection may
 * span lines in YAML as well, but this reader takes each from the one line it is written on, so
 * a line below either is refused by name rather than folded in.
 */
function parseScalarOnLines(state: State, line: Line, text: string, minIndent: number): unknown {
  const continuation = takeContinuation(state, minIndent);
  const next = continuation[0];
  if (next === undefined) return parseInline(text, line);
  if (text.startsWith('"') || text.startsWith("'")) {
    throw new YamlError(
      next.n,
      "a quoted scalar continued on the next line; schemafit reads a quoted scalar written on a single line",
    );
  }
  if (text.startsWith("[") || text.startsWith("{")) {
    throw new YamlError(
      next.n,
      "a flow collection continued on the next line; schemafit reads one written on a single line",
    );
  }
  return resolvePlain(foldPlain(line, text, continuation), line);
}

/**
 * The lines that continue a plain scalar: every line below it indented to at least `minIndent`,
 * with the empty lines in between, which fold into the scalar as its line breaks. An empty line
 * is held until a line of content follows it, so the blank line between a folded value and the
 * next key of its mapping is left where it is rather than taken into the scalar.
 */
function takeContinuation(state: State, minIndent: number): Line[] {
  const taken: Line[] = [];
  const empty: Line[] = [];
  let index = state.index;
  let end = state.index;
  while (index < state.lines.length) {
    const next = state.lines[index];
    if (next === undefined) break;
    index += 1;
    if (next.text === "") {
      empty.push(next);
      continue;
    }
    if (next.indent < minIndent || isDocumentMarker(next.text)) break;
    taken.push(...empty, next);
    empty.length = 0;
    end = index;
  }
  state.index = end;
  return taken;
}

/**
 * A plain scalar and the lines continuing it, folded into one string the way `>` folds a block
 * scalar: one line break becomes a space, and a run of them becomes one fewer newline. Every
 * line gives up its indentation and its trailing spaces, which section 7.3.3 leaves out of the
 * content, so a line of nothing but spaces counts as an empty one.
 *
 * A continuation line may hold what a plain scalar cannot start with — the `*` of `the
 * *important* part` is a character of the string rather than an alias — because only the first
 * character of the whole scalar is read as an indicator. The same goes for a `-`: a `- one`
 * indented under a value that is already there continues it, so `things` over `- one` is the
 * string "things - one" and not a sequence, which is what every YAML reader makes of it.
 */
function foldPlain(line: Line, first: string, continuation: readonly Line[]): string {
  if (line.comment) throw commentInsidePlain(line);
  rejectPlainColon(line, first);
  const content: string[] = [first];
  for (const [index, next] of continuation.entries()) {
    if (next.raw.trim() === "") {
      content.push("");
      continue;
    }
    // A comment-only line, which is a comment between two lines of the scalar.
    if (next.text === "") throw commentInsidePlain(next);
    // A comment on the last line ends a scalar that was ending there anyway.
    if (next.comment && index < continuation.length - 1) throw commentInsidePlain(next);
    rejectPlainColon(next, next.text);
    content.push(next.text);
  }
  return fold(content);
}

/**
 * A comment ends the plain scalar on its line, so the line below it continues nothing: the
 * folding of YAML 1.2 production 68 (`s-flow-folded`) takes the empty lines between two lines
 * of a plain scalar and no comment at all.
 */
function commentInsidePlain(line: Line): YamlError {
  return new YamlError(
    line.n,
    'a comment inside a plain scalar spread over lines; YAML folds no comment into a scalar, so move the comment above the scalar, or write the scalar as a block scalar ("|" for the lines as they are, ">" to fold them into one)',
  );
}

/**
 * A plain scalar cannot hold a colon followed by a space: that is the mapping key YAML reads
 * there, and the line already had its chance to be one.
 */
function rejectPlainColon(line: Line, text: string): void {
  if (!/:(\s|$)/.test(text)) return;
  throw new YamlError(
    line.n,
    `the plain scalar ${JSON.stringify(text)} holds a colon followed by a space; quote it if it is text, or put the nested mapping on its own indented line`,
  );
}

/**
 * A block sequence. `atKeyIndent` says it sits at the indentation of the mapping key that opened
 * it, which YAML 1.2 section 8.2.3 allows because people perceive the dash as indentation, so
 * "nested block sequences may be indented by one less space to compensate" (production 201,
 * `seq-space(n,BLOCK-OUT) ::= l+block-sequence(n-1)`). It is the spelling PyYAML's dumper writes.
 * The next key of that mapping then sits at the sequence's own indentation, so a line there that
 * is not an entry ends the sequence and the mapping reads it. The exception the
 * same section names — "except, of course, if nested inside another block sequence" — is where
 * `atKeyIndent` is false: no mapping can own such a line there, so it stays an error naming it.
 */
function parseSequence(state: State, indent: number, atKeyIndent: boolean): unknown[] {
  const items: unknown[] = [];
  for (;;) {
    const line = peek(state);
    if (line === undefined || isDocumentMarker(line.text) || line.indent < indent) return items;
    if (line.indent > indent) {
      throw new YamlError(line.n, "indented further than the sequence it belongs to");
    }
    if (!isSequenceEntry(line.text)) {
      if (atKeyIndent) return items;
      throw new YamlError(line.n, 'expected a sequence item ("- ")');
    }

    const after = line.text.slice(1);
    const rest = after.trim();
    if (rest === "") {
      state.index += 1;
      items.push(parseBlockIndentedBelow(state, indent));
      continue;
    }

    const contentIndent = indent + 1 + (after.length - after.trimStart().length);
    if (isSequenceEntry(rest) || findKeyEnd({ ...line, text: rest }) !== undefined) {
      // Blanking the dash leaves the mapping entry or nested item it starts on the column it
      // sits in, so the block that continues below it parses like any other.
      state.lines[state.index] = { ...line, indent: contentIndent, text: rest };
      items.push(parseNode(state, contentIndent));
      continue;
    }

    state.index += 1;
    items.push(parseValueOnLine(state, line, rest, indent));
  }
}

/**
 * A literal (`|`) or folded (`>`) block scalar: the lines below the key that are indented
 * further than it. The default chomping keeps one trailing newline and `-` strips it; `+`,
 * which keeps every trailing newline, and an explicit indentation indicator are refused rather
 * than approximated. A folded scalar's more indented lines keep their own line breaks, which is
 * refused for the same reason.
 *
 * What a line is here is read off `raw`, not off the comment-stripped `text` the rest of the
 * parser works from: a block scalar is scalar content, and YAML has no comments inside it
 * (YAML 1.2 section 6.6, "Outside scalar content, comments may appear on a line of their
 * own"), so a `#` in these lines is a character of the string. A line is empty for the block
 * only when it holds nothing but spaces, and any other line sets the block's indentation or
 * ends it, whatever it looks like.
 */
function parseBlockScalar(state: State, line: Line, header: string, indent: number): string {
  const match = /^([|>])([-+]?)$/.exec(header);
  if (match === null) {
    throw new YamlError(
      line.n,
      `the block scalar header ${JSON.stringify(header)} is not supported; use "|", "|-", ">", or ">-", and quote a scalar that starts with "|" or ">"`,
    );
  }
  const [, style, chomping] = match;
  if (chomping === "+") {
    throw new YamlError(line.n, 'the "keep" chomping indicator ("+") is not supported; use "|" or "|-"');
  }

  const content: string[] = [];
  let blockIndent: number | undefined;
  // The empty lines above the block's first line of content, held until that line fixes the
  // indentation they are measured against.
  const leadingEmpty: Line[] = [];
  while (state.index < state.lines.length) {
    const next = state.lines[state.index];
    if (next === undefined) break;
    // A line of nothing but spaces never ends the block, however little it is indented.
    const blank = next.raw.trim() === "";
    if (!blank && next.indent <= indent) break;
    if (!blank && blockIndent === undefined) {
      blockIndent = next.indent;
      rejectDeepLeadingEmpty(leadingEmpty, blockIndent);
    }
    if (blockIndent === undefined) {
      leadingEmpty.push(next);
      content.push("");
      state.index += 1;
      continue;
    }
    if (!blank && next.indent < blockIndent) break;
    // Whatever a line holds past the block's indentation is content, spaces included, so a
    // line of nothing but spaces is a more indented line too where it has some to spare.
    const deeper = blank ? next.raw.length > blockIndent : next.indent > blockIndent;
    if (deeper && style === ">") {
      throw new YamlError(next.n, 'a line indented further than the folded block scalar (">") it is in; use "|" to keep the lines as they are');
    }
    content.push(next.raw.slice(blockIndent));
    state.index += 1;
  }

  // Chomping drops the trailing empty lines, and a line is empty only when nothing of it is
  // left past the block's indentation: one that holds spaces beyond it holds them as content,
  // which neither the clip nor the strip indicator takes away.
  while (content.length > 0 && content[content.length - 1] === "") content.pop();
  if (content.length === 0) return "";

  const text = style === "|" ? content.join("\n") : fold(content);
  return chomping === "-" ? text : `${text}\n`;
}

/**
 * A block scalar takes its indentation from its first line of content, and YAML 1.2 section
 * 8.1.1.1 calls it "an error for any of the leading empty lines to contain more spaces than
 * the first non-empty line". Such a line is ambiguous about where the content starts, so it is
 * refused rather than read one of the two ways.
 */
function rejectDeepLeadingEmpty(leadingEmpty: readonly Line[], blockIndent: number): void {
  for (const empty of leadingEmpty) {
    if (empty.raw.length > blockIndent) {
      throw new YamlError(
        empty.n,
        `a blank line inside a block scalar holding more spaces (${empty.raw.length}) than the block's first line of content is indented (${blockIndent}); leave it empty`,
      );
    }
  }
}

/**
 * Folding, as `>` and a plain scalar spread over lines both define it: the single line break
 * between two lines becomes a space, and a run of breaks becomes one fewer newline, so one
 * blank line separates two paragraphs by one.
 */
function fold(content: readonly string[]): string {
  let folded = "";
  let breaks = 0;
  for (const [index, current] of content.entries()) {
    if (current.trim() === "") {
      breaks += 1;
      continue;
    }
    if (index > 0) folded += breaks > 0 ? "\n".repeat(breaks) : " ";
    folded += current;
    breaks = 0;
  }
  return folded;
}

/** Everything written on one line: a scalar, or a flow collection and what is nested in it. */
function parseInline(text: string, line: Line): unknown {
  const scanner: Scanner = { text, pos: 0, line };
  const value = parseFlowNode(scanner, false);
  skipSpaces(scanner);
  if (scanner.pos < scanner.text.length) {
    throw new YamlError(line.n, `unexpected ${JSON.stringify(scanner.text.slice(scanner.pos))} after the value`);
  }
  return value;
}

function parseFlowNode(scanner: Scanner, inFlow: boolean): unknown {
  skipSpaces(scanner);
  switch (scanner.text[scanner.pos]) {
    case undefined:
      return null;
    case "[":
      return parseFlowSequence(scanner);
    case "{":
      return parseFlowMapping(scanner);
    case '"':
    case "'":
      return readQuoted(scanner);
    default:
      return resolvePlain(readPlain(scanner, inFlow), scanner.line);
  }
}

function parseFlowSequence(scanner: Scanner): unknown[] {
  scanner.pos += 1;
  const items: unknown[] = [];
  skipSpaces(scanner);
  if (scanner.text[scanner.pos] === "]") {
    scanner.pos += 1;
    return items;
  }
  for (;;) {
    items.push(parseFlowNode(scanner, true));
    skipSpaces(scanner);
    const char = scanner.text[scanner.pos];
    scanner.pos += 1;
    if (char === "]") return items;
    if (char !== ",") throw flowError(scanner, '"," or "]"', "]");
    skipSpaces(scanner);
    // A trailing comma, which YAML allows and JSON does not.
    if (scanner.text[scanner.pos] === "]") {
      scanner.pos += 1;
      return items;
    }
  }
}

function parseFlowMapping(scanner: Scanner): Record<string, unknown> {
  scanner.pos += 1;
  const mapping: Record<string, unknown> = {};
  skipSpaces(scanner);
  if (scanner.text[scanner.pos] === "}") {
    scanner.pos += 1;
    return mapping;
  }
  for (;;) {
    skipSpaces(scanner);
    const key = parseFlowKey(scanner);
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlError(scanner.line.n, `duplicate key ${JSON.stringify(key)}`);
    }
    mapping[key] = parseFlowNode(scanner, true);
    skipSpaces(scanner);
    const char = scanner.text[scanner.pos];
    scanner.pos += 1;
    if (char === "}") return mapping;
    if (char !== ",") throw flowError(scanner, '"," or "}"', "}");
    skipSpaces(scanner);
    if (scanner.text[scanner.pos] === "}") {
      scanner.pos += 1;
      return mapping;
    }
  }
}

/** A flow mapping's key, which ends at its colon. */
function parseFlowKey(scanner: Scanner): string {
  const start = scanner.pos;
  const char = scanner.text[scanner.pos];
  let key: unknown;
  if (char === '"' || char === "'") key = readQuoted(scanner);
  else {
    let end = scanner.pos;
    while (end < scanner.text.length && scanner.text[end] !== ":") end += 1;
    key = resolvePlain(scanner.text.slice(scanner.pos, end).trim(), scanner.line);
    scanner.pos = end;
  }
  skipSpaces(scanner);
  if (scanner.text[scanner.pos] !== ":") {
    throw new YamlError(scanner.line.n, `expected ":" after the key ${JSON.stringify(scanner.text.slice(start, scanner.pos))} of a flow mapping`);
  }
  scanner.pos += 1;
  if (typeof key !== "string") {
    throw new YamlError(scanner.line.n, `the key ${JSON.stringify(scanner.text.slice(start, scanner.pos - 1).trim())} is not a string; quote it to use it as a property name`);
  }
  return key;
}

/** Why a flow collection stopped making sense: unterminated, or something else where a comma was. */
function flowError(scanner: Scanner, expected: string, close: string): YamlError {
  if (scanner.pos > scanner.text.length) {
    return new YamlError(scanner.line.n, `a flow collection with no closing "${close}"; schemafit reads one written on a single line`);
  }
  return new YamlError(scanner.line.n, `expected ${expected} in a flow collection, found ${JSON.stringify(scanner.text.slice(scanner.pos - 1))}`);
}

function skipSpaces(scanner: Scanner): void {
  while (scanner.pos < scanner.text.length && /\s/.test(scanner.text[scanner.pos] ?? "")) scanner.pos += 1;
}

/**
 * A plain scalar written on one line: everything up to what ends it, which inside a flow
 * collection is more. A scalar carrying a colon followed by a space is a mapping written where
 * YAML cannot read it as such, and it is refused rather than read as the text it is not.
 */
function readPlain(scanner: Scanner, inFlow: boolean): string {
  let end = scanner.pos;
  while (end < scanner.text.length) {
    const char = scanner.text[end] ?? "";
    if (inFlow && ",[]{}".includes(char)) break;
    end += 1;
  }
  const text = scanner.text.slice(scanner.pos, end).trimEnd();
  scanner.pos = end;
  rejectPlainColon(scanner.line, text);
  return text;
}

/** What the YAML 1.2 core schema makes of a plain scalar, where JSON can hold it. */
function resolvePlain(text: string, line: Line): unknown {
  rejectIndicators(line, text);
  if (NULLS.has(text)) return null;
  if (TRUES.has(text)) return true;
  if (FALSES.has(text)) return false;
  if (SPECIAL_FLOAT.test(text)) {
    throw new YamlError(line.n, `${JSON.stringify(text)} has no JSON equivalent; JSON has neither infinity nor NaN`);
  }
  if (INTEGER.test(text) || FLOAT.test(text)) return Number(text);
  if (HEX.test(text)) return Number.parseInt(text.slice(2), 16);
  if (OCTAL.test(text)) return Number.parseInt(text.slice(2), 8);
  return text;
}

/** Refuses the YAML this reader does not cover, naming the feature the text starts with. */
function rejectIndicators(line: Line, text: string): void {
  for (const [pattern, what] of INDICATORS) {
    if (pattern.test(text)) {
      throw new YamlError(line.n, `${what} is not supported; write it out by hand, or convert the file to JSON`);
    }
  }
}

/** A quoted scalar, which has to start and end on the same line. */
function readQuoted(scanner: Scanner): string {
  return scanner.text[scanner.pos] === '"' ? readDoubleQuoted(scanner) : readSingleQuoted(scanner);
}

function readDoubleQuoted(scanner: Scanner): string {
  const { text, line } = scanner;
  let out = "";
  let i = scanner.pos + 1;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (char === '"') {
      scanner.pos = i + 1;
      return out;
    }
    if (char !== "\\") {
      out += char;
      i += 1;
      continue;
    }
    const escape = text[i + 1] ?? "";
    const width = HEX_ESCAPES[escape];
    if (width !== undefined) {
      const digits = text.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
        throw new YamlError(line.n, `the escape "\\${escape}" needs ${width} hexadecimal digits`);
      }
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      i += 2 + width;
      continue;
    }
    const literal = ESCAPES[escape];
    if (literal === undefined) {
      throw new YamlError(line.n, `unsupported escape "\\${escape}" in a double-quoted string`);
    }
    out += literal;
    i += 2;
  }
  throw unterminatedQuote(line, '"');
}

function readSingleQuoted(scanner: Scanner): string {
  const { text, line } = scanner;
  let out = "";
  let i = scanner.pos + 1;
  while (i < text.length) {
    if (text[i] === "'") {
      // `''` is how a single-quoted scalar spells one quote.
      if (text[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      scanner.pos = i + 1;
      return out;
    }
    out += text[i];
    i += 1;
  }
  throw unterminatedQuote(line, "'");
}

function unterminatedQuote(line: Line, quote: string): YamlError {
  return new YamlError(line.n, `a string with no closing ${quote}; schemafit reads a quoted scalar written on a single line`);
}
