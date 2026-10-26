/**
 * A reader for the YAML a JSON Schema is written in.
 *
 * It covers what schemas use — block mappings and sequences, flow collections over as many
 * lines as they need, quoted and
 * plain scalars spread over as many lines as they need, literal and folded block scalars,
 * comments, the YAML 1.2 core resolution of `null`, `true`, numbers — and refuses the rest by
 * name instead of guessing at it: an anchor, an alias, a tag, a merge key, a second document, a
 * tab in the indentation, a plain scalar inside a flow collection continued on the next line. A
 * linter that misreads its input reports findings against a schema nobody wrote, so a construct
 * this cannot read with certainty is an error naming the line it is on rather than a value that
 * may or may not be what the file said.
 */

import { joinPointer } from "./pointer.js";

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
  /** The comment `text` gave up, from its `#`, or the whole of a line that holds nothing else. */
  remark: string;
}

/** The lines, and how far through them the parser is. */
interface State {
  lines: Line[];
  index: number;
  /**
   * The lines read as scalar content off `raw`: a block scalar's, and those a quoted scalar runs
   * on over. What `tokenize` took for a comment on one of them is a character of the string.
   * The empty lines inside a plain scalar or a flow collection are here too, since they are part
   * of the node rather than space between two entries.
   */
  content: Set<number>;
  /** The comments found after a quoted scalar closed on a line of `content`, or between flow entries. */
  comments: Map<number, string>;
  /** The JSON Pointer of each mapping entry and sequence item, by the line it starts on. */
  entries: Map<number, string>;
  /** The JSON Pointer of the node being read. */
  at: string;
}

/** One line being read left to right, for the scalars and flow collections written on it. */
interface Scanner {
  text: string;
  pos: number;
  line: Line;
  /** Where a flow collection written in block context finds the lines it runs on over. */
  more?: Continuation;
}

/**
 * Where a quoted scalar or a flow collection written in block context finds the lines it runs
 * on over. A quoted key has to close on its own line.
 */
interface Continuation {
  state: State;
  /** The indentation a line of the node below its first has to clear. */
  minIndent: number;
  /** The line the node opens on, which an unclosed quote or bracket is reported against. */
  opened: Line;
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
  return readYaml(text).value;
}

/**
 * A comment of a YAML document, and the node it belongs to, so a rewrite can write it back
 * there. A comment on a line of its own belongs to the entry below it, and one after a value to
 * the entry that value belongs to.
 */
export interface YamlComment {
  line: number;
  /** The comment from its `#`. */
  text: string;
  /**
   * The JSON Pointer of the mapping entry or sequence item it belongs to, or null for one with
   * no entry below it, which goes at the end of the document.
   */
  pointer: string | null;
  /** Whether it goes after the entry's first line rather than on a line of its own above it. */
  trailing: boolean;
}

/**
 * An empty line between two entries of a YAML document, which belongs to the entry below it,
 * so a rewrite can keep apart what the file kept apart.
 */
export interface YamlBlank {
  line: number;
  /** The JSON Pointer of the entry below it, or null for one with no entry below it. */
  pointer: string | null;
}

/**
 * Reads a YAML document into the value it describes, together with its comments and its empty
 * lines, which the value has no room for: a rewrite written from the value alone would drop
 * them. `comments` names the lines of the comments, `attached` says where each one belongs, and
 * `blanks` where each empty line between two entries does. A `#` inside a block scalar or a
 * quoted scalar is a character of the string, not a comment, and an empty line inside a scalar
 * or a flow collection is part of it.
 */
export function readYaml(text: string): { value: unknown; comments: number[]; attached: YamlComment[]; blanks: YamlBlank[] } {
  const state: State = {
    lines: tokenize(text),
    index: 0,
    content: new Set(),
    comments: new Map(),
    entries: new Map(),
    at: "",
  };
  const value = parseDocument(state);
  const found = state.lines.flatMap(({ n, raw, text: content, comment, remark }) => {
    const after = state.comments.get(n);
    if (after !== undefined) return [{ n, remark: after, own: false }];
    if (state.content.has(n)) return [];
    if (content === "") return raw.trim() === "" ? [] : [{ n, remark, own: true }];
    return comment ? [{ n, remark, own: false }] : [];
  });
  const starts = [...state.entries.keys()].sort((a, b) => a - b);
  const blanks = state.lines.flatMap(({ n, raw }) => {
    // The line break that ends the last line splits off an empty string, which is no line.
    const last = n === state.lines.length && text.endsWith("\n");
    if (raw.trim() !== "" || state.content.has(n) || last) return [];
    const below = starts.find((line) => line > n);
    return [{ line: n, pointer: below === undefined ? null : (state.entries.get(below) ?? null) }];
  });
  return { value, comments: found.map(({ n }) => n), attached: attach(found, state.entries), blanks };
}

/**
 * Where each comment belongs: one on a line of its own to the first entry below it, and one
 * after a value to the entry whose line it is on, or whose value runs on to that line. An entry
 * holds one comment after it, so a second one after the same entry goes above it instead.
 */
function attach(found: ReadonlyArray<{ n: number; remark: string; own: boolean }>, entries: Map<number, string>): YamlComment[] {
  const starts = [...entries.keys()].sort((a, b) => a - b);
  const trailed = new Set<string>();
  return found.map(({ n, remark, own }) => {
    if (!own) {
      const start = starts.filter((line) => line <= n).pop();
      const pointer = start === undefined ? undefined : entries.get(start);
      if (pointer !== undefined && !trailed.has(pointer)) {
        trailed.add(pointer);
        return { line: n, text: remark, pointer, trailing: true };
      }
      if (pointer !== undefined) return { line: n, text: remark, pointer, trailing: false };
    }
    const below = starts.find((line) => line > n);
    return { line: n, text: remark, pointer: below === undefined ? null : (entries.get(below) ?? null), trailing: false };
  });
}

function parseDocument(state: State): unknown {
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
    const comment = text !== content.trimEnd();
    return { n, raw, indent, text, comment, remark: comment || text === "" ? content.slice(text.length).trim() : "" };
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
    const outer = enter(state, line, key);
    mapping[key] = rest === "" ? parseNodeBelow(state, indent) : parseValueOnLine(state, line, rest, indent);
    state.at = outer;
  }
}

/**
 * Records the entry that starts on `line` and makes it the node being read, returning the one
 * that was. A sequence item and the first key of the mapping in it share a line, which belongs
 * to the item, so a comment above it goes above the dash.
 */
function enter(state: State, line: Line, token: string | number): string {
  const outer = state.at;
  state.at = joinPointer(outer, token);
  if (!state.entries.has(line.n)) state.entries.set(line.n, state.at);
  return outer;
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
 * is YAML 1.2 section 7.3.3 (production 135, `ns-plain-multi-line(n,c)`) and how a description
 * long enough to wrap is written without a block scalar. A quoted scalar runs on to its closing
 * quote instead, over lines held to the same indentation, and a flow collection to its closing
 * bracket.
 */
function parseScalarOnLines(state: State, line: Line, text: string, minIndent: number): unknown {
  if (text.startsWith('"') || text.startsWith("'")) return parseQuotedOnLines(state, line, text, minIndent);
  if (text.startsWith("[") || text.startsWith("{")) return parseFlowOnLines(state, line, text, minIndent);
  const continuation = takeContinuation(state, minIndent);
  if (continuation[0] === undefined) return parseInline(text, line);
  return resolvePlain(foldPlain(line, text, continuation), line);
}

/**
 * A flow collection written as a block value, which YAML 1.2 lets run on over as many lines as
 * it needs before its closing bracket: between two of its entries, around a comma or a colon,
 * a line break is white space like any other (production 137, `c-flow-sequence(n,c)`, and its
 * `s-separate(n,c)`), and a comment may end any of its lines. Every line has to clear the
 * indentation of the block the collection sits in (production 197, `s-l+flow-in-block(n)`,
 * which reads it at `n+1`), which is the formatter's `type: [string,` with `"null"]` indented
 * under it. Like a quoted scalar, the collection is over at its closing bracket, so a line
 * indented under it continues nothing.
 */
function parseFlowOnLines(state: State, line: Line, text: string, minIndent: number): unknown {
  const scanner: Scanner = { text, pos: 0, line, more: { state, minIndent, opened: line } };
  const value = parseFlowNode(scanner, false);
  skipSpaces(scanner);
  const after = scanner.text.slice(scanner.pos);
  if (after.startsWith("#")) state.comments.set(scanner.line.n, after);
  if (after !== "" && !after.startsWith("#")) {
    throw new YamlError(scanner.line.n, `unexpected ${JSON.stringify(after)} after the value`);
  }
  const below = takeContinuation(state, minIndent)[0];
  if (below !== undefined) {
    throw new YamlError(
      below.n,
      `${JSON.stringify(below.text)} is indented under a flow collection that already ended at its closing bracket; move the text inside the brackets, or indent the line less`,
    );
  }
  return value;
}

/**
 * A quoted scalar written as a block value, which YAML 1.2 lets run on over as many lines as it
 * needs before its closing quote (productions 116 and 125, `nb-double-multi-line(n)` and
 * `nb-single-multi-line(n)`), folded the way a plain scalar is. What follows the closing quote
 * on its line can only be a comment, and the scalar is over there: a line indented under it
 * continues nothing.
 *
 * The scalar is read off `raw`, because the comment-stripped `text` of a line inside it was cut
 * at a `#` that is a character of the string. A trailing comment on the first line means the
 * quote closed before it, so that line is read as it always was.
 */
function parseQuotedOnLines(state: State, line: Line, text: string, minIndent: number): string {
  let value: string;
  if (line.comment) value = parseInline(text, line) as string;
  else {
    // The value with the trailing spaces `text` gave up, which an escape before them may need.
    const written = line.raw.slice(line.raw.trimEnd().length - text.length);
    const scanner: Scanner = { text: written, pos: 0, line };
    value = readQuoted(scanner, { state, minIndent, opened: line });
    const after = scanner.text.slice(scanner.pos);
    if (/^[ \t]+#/.test(after)) state.comments.set(scanner.line.n, after.trim());
    if (!/^([ \t]*|[ \t]+#.*)$/.test(after)) {
      if (scanner.line !== line && after.trimStart().startsWith(":")) {
        throw new YamlError(
          scanner.line.n,
          `a quoted key spread over lines, from line ${line.n}; YAML holds an implicit key to a single line, so write the key on one`,
        );
      }
      throw new YamlError(scanner.line.n, `unexpected ${JSON.stringify(after.trim())} after the value`);
    }
  }
  const below = takeContinuation(state, minIndent)[0];
  if (below !== undefined) {
    throw new YamlError(
      below.n,
      `${JSON.stringify(below.text)} is indented under a quoted scalar that already ended at its closing quote; move the text inside the quotes, or indent the line less`,
    );
  }
  return value;
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
    for (const line of empty) if (line.raw.trim() === "") state.content.add(line.n);
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
 * folding of YAML 1.2 production 74 (`s-flow-folded`) takes the empty lines between two lines
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
    const outer = enter(state, line, items.length);
    if (rest === "") {
      state.index += 1;
      items.push(parseBlockIndentedBelow(state, indent));
    } else {
      const contentIndent = indent + 1 + (after.length - after.trimStart().length);
      if (isSequenceEntry(rest) || findKeyEnd({ ...line, text: rest }) !== undefined) {
        // Blanking the dash leaves the mapping entry or nested item it starts on the column it
        // sits in, so the block that continues below it parses like any other.
        state.lines[state.index] = { ...line, indent: contentIndent, text: rest };
        items.push(parseNode(state, contentIndent));
      } else {
        state.index += 1;
        items.push(parseValueOnLine(state, line, rest, indent));
      }
    }
    state.at = outer;
  }
}

/**
 * A literal (`|`) or folded (`>`) block scalar: the lines below the key that are indented
 * further than it. The default chomping keeps one trailing newline and `-` strips it; `+`,
 * which keeps every trailing newline, is refused rather than approximated.
 *
 * The block's indentation is that of its first line of content, unless the header gives it
 * with an indentation indicator: a digit from 1 to 9, before or after the chomping indicator,
 * which YAML 1.2 section 8.1.1.1 adds to "the indentation level of the block scalar" — the
 * column of the key, or of the dash for a sequence item. It is the only way to write a block
 * whose first line of content is itself indented, so what that line holds past the indicated
 * indentation is content like any other line's.
 *
 * What a line is here is read off `raw`, not off the comment-stripped `text` the rest of the
 * parser works from: a block scalar is scalar content, and YAML has no comments inside it
 * (YAML 1.2 section 6.6, "Outside scalar content, comments may appear on a line of their
 * own"), so a `#` in these lines is a character of the string. A line is empty for the block
 * only when it holds nothing but spaces, and any other line sets the block's indentation or
 * ends it, whatever it looks like.
 */
function parseBlockScalar(state: State, line: Line, header: string, indent: number): string {
  const match = /^([|>])(?:([1-9])([-+]?)|([-+]?)([1-9]?))$/.exec(header);
  if (match === null) {
    throw new YamlError(
      line.n,
      `the block scalar header ${JSON.stringify(header)} is not supported; use "|" or ">", followed by "-" to strip the final line break or a digit from 1 to 9 to give the indentation, and quote a scalar that starts with "|" or ">"`,
    );
  }
  const style = match[1];
  const indicator = match[2] ?? match[5];
  const chomping = match[3] ?? match[4];
  if (chomping === "+") {
    throw new YamlError(line.n, 'the "keep" chomping indicator ("+") is not supported; use "|" or "|-"');
  }

  const content: string[] = [];
  let blockIndent = indicator ? indent + Number(indicator) : undefined;
  // The empty lines above the block's first line of content, held until that line fixes the
  // indentation they are measured against.
  const leadingEmpty: Line[] = [];
  // The line of `content[0]`: the block takes every line from here on until it ends.
  const first = state.index;
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
      state.content.add(next.n);
      state.index += 1;
      continue;
    }
    if (!blank && next.indent < blockIndent) {
      if (indicator) throw lessThanIndicated(next, blockIndent, header);
      break;
    }
    // Whatever a line holds past the block's indentation is content, spaces included, so a
    // line of nothing but spaces is a more indented line too where it has some to spare.
    content.push(next.raw.slice(blockIndent));
    state.content.add(next.n);
    state.index += 1;
  }

  // Chomping drops the trailing empty lines, and a line is empty only when nothing of it is
  // left past the block's indentation: one that holds spaces beyond it holds them as content,
  // which neither the clip nor the strip indicator takes away.
  // Those lines are space between the scalar and the entry below it, not lines of the scalar.
  while (content.length > 0 && content[content.length - 1] === "") {
    content.pop();
    const dropped = state.lines[first + content.length];
    if (dropped !== undefined) state.content.delete(dropped.n);
  }
  if (content.length === 0) return "";

  const text = style === "|" ? content.join("\n") : fold(content);
  return chomping === "-" ? text : `${text}\n`;
}

/**
 * A line inside a block scalar indented less than its indentation indicator says, which YAML
 * 1.2 section 8.1.1.1 calls an error ("The text is less indented than the indicated level")
 * rather than the end of the block: the line is still indented under the key.
 */
function lessThanIndicated(line: Line, blockIndent: number, header: string): YamlError {
  return new YamlError(
    line.n,
    `a line inside a block scalar indented less (${line.indent}) than its header ${JSON.stringify(header)} says its content is (${blockIndent}); indent the line further, or lower the indentation indicator`,
  );
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
 *
 * A line that still begins with a space once the block's indentation is off is a *more
 * indented* line, which YAML 1.2 section 8.1.3 leaves unfolded: "folding does not apply to
 * line breaks surrounding text lines that contain leading white space", so the break on either
 * side of one is kept as a newline and the blank lines beside it each add one more. That is
 * how a list or an indented example written inside a `>` description survives folding. A plain
 * scalar has no such line, because every line of one gives up its indentation, so the rule
 * costs it nothing.
 */
function fold(content: readonly string[]): string {
  let folded = "";
  let breaks = 0;
  let started = false;
  let previousIndented = false;
  for (const current of content) {
    if (current === "") {
      breaks += 1;
      continue;
    }
    const indented = current.startsWith(" ");
    if (!started) folded += "\n".repeat(breaks);
    else if (indented || previousIndented) folded += "\n".repeat(breaks + 1);
    else folded += breaks > 0 ? "\n".repeat(breaks) : " ";
    folded += current;
    breaks = 0;
    started = true;
    previousIndented = indented;
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
  if (inFlow) skipSeparation(scanner);
  else skipSpaces(scanner);
  switch (scanner.text[scanner.pos]) {
    case undefined:
      return null;
    case "[":
      return parseFlowSequence(scanner);
    case "{":
      return parseFlowMapping(scanner);
    case '"':
    case "'":
      return readQuoted(scanner, scanner.more);
    default:
      return resolvePlain(readPlain(scanner, inFlow), scanner.line);
  }
}

function parseFlowSequence(scanner: Scanner): unknown[] {
  scanner.pos += 1;
  const items: unknown[] = [];
  skipSeparation(scanner);
  if (scanner.text[scanner.pos] === "]") {
    scanner.pos += 1;
    return items;
  }
  for (;;) {
    items.push(parseFlowNode(scanner, true));
    const before = scanner.line;
    skipSeparation(scanner);
    const char = scanner.text[scanner.pos];
    scanner.pos += 1;
    if (char === "]") return items;
    if (char !== ",") throw flowError(scanner, '"," or "]"', "]", before);
    skipSeparation(scanner);
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
  skipSeparation(scanner);
  if (scanner.text[scanner.pos] === "}") {
    scanner.pos += 1;
    return mapping;
  }
  for (;;) {
    skipSeparation(scanner);
    const key = parseFlowKey(scanner);
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlError(scanner.line.n, `duplicate key ${JSON.stringify(key)}`);
    }
    mapping[key] = parseFlowNode(scanner, true);
    const before = scanner.line;
    skipSeparation(scanner);
    const char = scanner.text[scanner.pos];
    scanner.pos += 1;
    if (char === "}") return mapping;
    if (char !== ",") throw flowError(scanner, '"," or "}"', "}", before);
    skipSeparation(scanner);
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

/**
 * Why a flow collection stopped making sense: unterminated, or something else where a comma
 * was. Something on a line below the entry it follows is, to YAML, the same plain scalar
 * folded on over the line break, which this reader leaves alone the way it leaves a plain key
 * spread over lines, so the error says which of the two the file most likely meant.
 */
function flowError(scanner: Scanner, expected: string, close: string, entryLine: Line): YamlError {
  if (scanner.pos > scanner.text.length) {
    const opened = scanner.more?.opened ?? scanner.line;
    return new YamlError(opened.n, `a flow collection with no closing "${close}"`);
  }
  const found = JSON.stringify(scanner.text.slice(scanner.pos - 1));
  if (scanner.line !== entryLine) {
    return new YamlError(
      scanner.line.n,
      `expected ${expected} in a flow collection, found ${found} on the line below the entry before it; a plain scalar inside a flow collection is read on one line, so quote one that wraps, or put a comma after the entry above if they are two`,
    );
  }
  return new YamlError(scanner.line.n, `expected ${expected} in a flow collection, found ${found}`);
}

function skipSpaces(scanner: Scanner): void {
  while (scanner.pos < scanner.text.length && /\s/.test(scanner.text[scanner.pos] ?? "")) scanner.pos += 1;
}

/**
 * The white space between two tokens of a flow collection, which for one written in block
 * context takes in the line breaks, the empty lines, and the comments, up to the next line
 * that holds content (`s-separate(n,c)`, production 80). A line indented less than the block
 * the collection sits in is an error rather than the end of it, because only the closing
 * bracket ends one, and the likeliest reason for such a line is a bracket left open above it.
 */
function skipSeparation(scanner: Scanner): void {
  for (;;) {
    skipSpaces(scanner);
    const { text, pos } = scanner;
    // A line a quoted scalar ran on to is read as written, comment and all.
    if (text[pos] === "#" && (pos === 0 || /\s/.test(text[pos - 1] ?? ""))) {
      scanner.more?.state.comments.set(scanner.line.n, text.slice(pos).trimEnd());
      scanner.pos = text.length;
    }
    if (scanner.pos < scanner.text.length || scanner.more === undefined) return;
    const { state, minIndent, opened } = scanner.more;
    const skipped = state.index;
    const next = peek(state);
    // A comment on a line of its own between two entries of the collection is a comment on
    // the value the collection is, like one after an entry, not on the key below it.
    for (const line of state.lines.slice(skipped, state.index)) {
      if (line.remark !== "") state.comments.set(line.n, line.remark);
      else state.content.add(line.n);
    }
    if (next === undefined) return;
    if (next.indent === 0 && isDocumentMarker(next.text)) {
      throw new YamlError(next.n, `a document marker inside the flow collection opened on line ${opened.n}; close the collection above it`);
    }
    const close = next.text[0];
    if (next.indent < minIndent && (close === "]" || close === "}")) {
      throw new YamlError(
        next.n,
        `the closing "${close}" of the flow collection opened on line ${opened.n} is not indented further than the block the collection sits in, which YAML asks of every line of it; indent it further`,
      );
    }
    if (next.indent < minIndent) {
      throw new YamlError(
        next.n,
        `a line inside the flow collection opened on line ${opened.n} indented less than the collection's block; close the collection on the line it belongs to, or indent this line further`,
      );
    }
    state.index += 1;
    scanner.text = next.text;
    scanner.pos = 0;
    scanner.line = next;
  }
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
    if (char === "#" && /\s/.test(scanner.text[end - 1] ?? "")) break;
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

/**
 * A quoted scalar. Without `more` it has to close on the line it opens on; with it, it runs on
 * over the lines below, which fold into it the way YAML 1.2 section 7.3.1 and 7.3.2 say: the
 * white space at either end of a line is not content, a single line break becomes a space, and
 * the empty lines after a break become one newline each. The white space just inside the quotes
 * is content, so `" one` keeps its leading space.
 */
function readQuoted(scanner: Scanner, more?: Continuation): string {
  return scanner.text[scanner.pos] === '"' ? readDoubleQuoted(scanner, more) : readSingleQuoted(scanner, more);
}

function readDoubleQuoted(scanner: Scanner, more?: Continuation): string {
  let out = "";
  // How much of `out` is safe from the trailing white space a line break discards: an escaped
  // tab or space is content wherever it sits.
  let kept = 0;
  scanner.pos += 1;
  for (;;) {
    const { text, line } = scanner;
    if (scanner.pos >= text.length) {
      if (more === undefined) throw unterminatedQuote(line, '"');
      out = out.slice(0, kept) + nextQuotedLine(scanner, more, '"', " ");
      kept = out.length;
      continue;
    }
    const char = text[scanner.pos] ?? "";
    if (char === '"') {
      scanner.pos += 1;
      return out;
    }
    if (char !== "\\") {
      out += char;
      scanner.pos += 1;
      if (char !== " " && char !== "\t") kept = out.length;
      continue;
    }
    const escape = text[scanner.pos + 1] ?? "";
    if (escape === "" && more !== undefined) {
      // An escaped line break (production 112, `s-double-escaped(n)`) is no content at all, and
      // the white space before it stays, which is how a line is broken inside a word.
      out += nextQuotedLine(scanner, more, '"', "");
      kept = out.length;
      continue;
    }
    const width = HEX_ESCAPES[escape];
    if (width !== undefined) {
      const digits = text.slice(scanner.pos + 2, scanner.pos + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
        throw new YamlError(line.n, `the escape "\\${escape}" needs ${width} hexadecimal digits`);
      }
      out += String.fromCodePoint(Number.parseInt(digits, 16));
      scanner.pos += 2 + width;
      kept = out.length;
      continue;
    }
    const literal = ESCAPES[escape];
    if (literal === undefined) {
      throw new YamlError(line.n, `unsupported escape "\\${escape}" in a double-quoted string`);
    }
    out += literal;
    scanner.pos += 2;
    kept = out.length;
  }
}

function readSingleQuoted(scanner: Scanner, more?: Continuation): string {
  let out = "";
  let kept = 0;
  scanner.pos += 1;
  for (;;) {
    const { text, line } = scanner;
    if (scanner.pos >= text.length) {
      if (more === undefined) throw unterminatedQuote(line, "'");
      out = out.slice(0, kept) + nextQuotedLine(scanner, more, "'", " ");
      kept = out.length;
      continue;
    }
    const char = text[scanner.pos] ?? "";
    if (char === "'") {
      // `''` is how a single-quoted scalar spells one quote.
      if (text[scanner.pos + 1] !== "'") {
        scanner.pos += 1;
        return out;
      }
      scanner.pos += 1;
    }
    out += char;
    scanner.pos += 1;
    if (char !== " " && char !== "\t") kept = out.length;
  }
}

/**
 * Moves the scanner to the next line of a quoted scalar that holds anything, past its leading
 * white space, and returns what the line break folds into: `single` when no empty line came
 * between, and a newline for each one that did. A line indented less than the scalar's block
 * is an error rather than the end of the scalar, because only the closing quote ends one, and
 * the likeliest reason for such a line is a quote left open on a line above it.
 */
function nextQuotedLine(scanner: Scanner, more: Continuation, quote: string, single: string): string {
  const { state, minIndent, opened } = more;
  let empty = 0;
  while (state.index < state.lines.length) {
    const next = state.lines[state.index];
    if (next === undefined) break;
    state.index += 1;
    state.content.add(next.n);
    if (/^[ \t]*$/.test(next.raw)) {
      empty += 1;
      continue;
    }
    const spaces = /^ */.exec(next.raw)?.[0].length ?? 0;
    if (spaces < minIndent || (spaces === 0 && isDocumentMarker(next.text))) {
      throw new YamlError(
        next.n,
        `a line inside the quoted scalar opened on line ${opened.n} indented less than the scalar's block; close the ${quote} on the line it belongs to, or indent this line further`,
      );
    }
    scanner.text = next.raw.replace(/^[ \t]+/, "");
    scanner.pos = 0;
    scanner.line = next;
    return empty > 0 ? "\n".repeat(empty) : single;
  }
  throw unterminatedQuote(opened, quote);
}

function unterminatedQuote(line: Line, quote: string): YamlError {
  return new YamlError(line.n, `a string with no closing ${quote}`);
}
