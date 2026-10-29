/**
 * A writer for the YAML the reader in `yaml.ts` reads, so a rewrite of a `.yaml` file can go
 * back into it.
 *
 * It writes block mappings and block sequences indented by two spaces, a sequence under a key
 * at the key's own indentation instead when the file it came from wrote it there, a list of
 * scalars that fits on its line in flow style (`type: [string, "null"]`), `{}` and `[]` for the
 * empty collections, a literal block scalar (`|`) for a string over several lines, and every other
 * string plain where it reads back as itself — in this reader and in a YAML 1.1 one, which
 * takes `yes` and `off` for booleans — and double-quoted where it does not. What it writes is
 * read back before it is returned, and a value that would not come back as itself is an error
 * rather than a file that says something else.
 *
 * Comments read off a file go back to the entries they belong to: one that sat on a line of its
 * own goes on a line above its entry, at the entry's indentation, and one that sat after a value
 * goes after the entry's first line. An empty line between two entries goes back above the entry
 * below it, in its place among that entry's comments.
 */

import { joinPointer } from "./pointer.js";
import { type YamlBlank, type YamlComment, type YamlLayout, parseYaml, readYaml } from "./yaml.js";

const INDENT = 2;
/** How long a line may grow for a list of scalars to be written on it in flow style. */
const FLOW_WIDTH = 80;

/** What a plain scalar cannot start with: an indicator, a quote, or what a number starts with. */
const PLAIN_START = /^[-?:,[\]{}#&*!|>'"%@`~=<+.0-9]/;
/** The characters YAML asks to be escaped, or a reader may take for a line break. */
const UNPRINTABLE = /[\0-\x1f\x7f-\x9f\u2028\u2029\ufeff\ud800-\udfff]/u;
/** The same, less the tab and the line break a literal block scalar holds as they are. */
const UNPRINTABLE_IN_BLOCK = /[\0-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufeff\ud800-\udfff]/u;
/** The plain scalars YAML 1.1 resolves to a boolean, which 1.2 left as strings. */
const YAML11_BOOLEANS = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/**
 * What to write besides the value: the comments, by the JSON Pointer of the entry each one
 * belongs to, and how to indent a sequence under a key. The lines above an entry are its
 * comments and its empty lines, an empty one written as `""`.
 */
interface Layout {
  above: Map<string, string[]>;
  after: Map<string, string>;
  indentSequences: boolean;
}

/**
 * Writes a JSON value as YAML, with the `comments` and the empty lines (`blanks`) given, which
 * `readYaml` reads off a file as `attached` and `blanks`, and its sequences indented as the
 * `layout` `readYaml` reads off a file says. An empty line with no entry below it is left out,
 * since nothing follows it to keep apart. Throws a `TypeError` for a value JSON cannot hold
 * either, or for a comment or an empty line whose entry the value does not hold, and an `Error`
 * if what it wrote does not read back as the value and the comments, which would be a bug in
 * the writer.
 */
export function stringifyYaml(
  value: unknown,
  comments: readonly YamlComment[] = [],
  blanks: readonly YamlBlank[] = [],
  layout: Partial<YamlLayout> = {},
): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("stringifyYaml takes a JSON value");
  const placed: Layout = { above: new Map(), after: new Map(), indentSequences: layout.indentSequences ?? true };
  const end: string[] = [];
  for (const comment of comments) {
    if (!comment.text.startsWith("#") || /[\r\n]/.test(comment.text)) {
      throw new TypeError(`the comment of line ${comment.line} is not one line starting with "#"`);
    }
  }
  // An empty line goes where it was among the comments above the same entry, so both are
  // placed in the order of their lines.
  const lines = [...comments, ...blanks.map(({ line, pointer }) => ({ line, text: "", pointer, trailing: false }))];
  for (const { text, pointer, trailing } of lines.sort((a, b) => a.line - b.line)) {
    if (pointer === null) end.push(text);
    else if (trailing && !placed.after.has(pointer)) placed.after.set(pointer, text);
    else placed.above.set(pointer, [...(placed.above.get(pointer) ?? []), text]);
  }
  while (end[end.length - 1] === "") end.pop();
  const ending = end.filter((text) => text === "").length;
  // What JSON would make of it — no undefined members, no functions — is what is written.
  const written = [...block(JSON.parse(json) as unknown, 0, "", placed), ...end];
  const text = `${written.join("\n")}\n`;
  const read = readYaml(text);
  if (JSON.stringify(read.value) !== json) {
    throw new Error("the YAML written for this value does not read back as the value");
  }
  if (read.comments.length !== comments.length) {
    throw new TypeError(`${comments.length - read.comments.length} of the comments belong to an entry the value does not hold`);
  }
  const placedBlanks = blanks.filter(({ pointer }) => pointer !== null).length + ending;
  if (read.blanks.length !== placedBlanks) {
    throw new TypeError(`${placedBlanks - read.blanks.length} of the empty lines belong to an entry the value does not hold`);
  }
  return text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The lines of a node that starts on a line of its own, at `indent`. */
function block(value: unknown, indent: number, pointer: string, layout: Layout): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value) && value.length > 0) {
    return value.flatMap((item, index) => {
      const at = joinPointer(pointer, index);
      return commented(entry(`${pad}-`, item, indent, true, at, layout), pad, at, layout);
    });
  }
  if (isObject(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) => {
      const at = joinPointer(pointer, key);
      return commented(entry(`${pad}${scalar(key, true)}:`, item, indent, false, at, layout), pad, at, layout);
    });
  }
  return [`${pad}${inline(value)}`];
}

/** The lines of an entry with its comments: those above it, and the one after its first line. */
function commented(lines: readonly string[], pad: string, pointer: string, layout: Layout): string[] {
  const above = (layout.above.get(pointer) ?? []).map((text) => (text === "" ? "" : `${pad}${text}`));
  const after = layout.after.get(pointer);
  if (after === undefined) return [...above, ...lines];
  // The entry's own first line, below any comment its first key brought up above the dash.
  const first = lines.findIndex((line) => !isLayout(line));
  return [...above, ...lines.map((line, index) => (index === first ? `${line} ${after}` : line))];
}

/**
 * Whether a line the writer produced is a comment or an empty line between two entries, which
 * no key or dash it writes looks like.
 */
function isLayout(line: string): boolean {
  return line === "" || line.trimStart().startsWith("#");
}

/** One mapping entry or sequence item: `prefix` is its key and colon, or its dash. */
function entry(prefix: string, value: unknown, indent: number, dash: boolean, pointer: string, layout: Layout): string[] {
  const child = indent + INDENT;
  // A flow list has no line of its own for a comment on one of its items, or an empty line between two.
  const flow = commentsWithin(pointer, layout) ? undefined : flowList(value);
  if (flow !== undefined && prefix.length + 1 + flow.length <= FLOW_WIDTH) return [`${prefix} ${flow}`];
  if ((Array.isArray(value) && value.length > 0) || (isObject(value) && Object.keys(value).length > 0)) {
    // A sequence under a key may sit at the key's own indentation, where its dashes count as
    // the indentation the items need.
    const compact = !dash && Array.isArray(value) && !layout.indentSequences;
    const lines = block(value, compact ? indent : child, pointer, layout);
    // A collection in a sequence item starts on the dash's line, which YAML reads at the
    // column of its first character; under a key it starts on the line below.
    if (!dash) return [prefix, ...lines];
    // A comment above the first entry of that collection would split the dash from it, so it
    // goes above the dash.
    const above = lines.findIndex((line) => !isLayout(line));
    const hoisted = lines.slice(0, above).map((line) => line.slice(child - indent));
    const [first = "", ...rest] = lines.slice(above);
    return [...hoisted, `${prefix} ${first.slice(child)}`, ...rest];
  }
  if (typeof value === "string") {
    const literal = literalBlock(value);
    if (literal !== undefined) {
      const pad = " ".repeat(child);
      return [`${prefix} ${literal.header}`, ...literal.lines.map((line) => (line === "" ? "" : `${pad}${line}`))];
    }
  }
  return [`${prefix} ${inline(value)}`];
}

/** Whether a comment belongs to an entry inside the node at `pointer`. */
function commentsWithin(pointer: string, layout: Layout): boolean {
  return [...layout.above.keys(), ...layout.after.keys()].some((at) => at.startsWith(`${pointer}/`));
}

/** A list of nothing but scalars as a flow sequence, or undefined for any other value. */
function flowList(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (value.some((item) => typeof item === "object" && item !== null)) return undefined;
  // Inside a flow collection a comma or a bracket ends a plain scalar, so one holding either is quoted.
  const items = value.map((item) =>
    typeof item === "string" ? (isPlain(item, false) && !/[,[\]{}]/.test(item) ? item : quote(item)) : JSON.stringify(item),
  );
  return `[${items.join(", ")}]`;
}

/** A scalar, or an empty collection, written on the line it belongs to. */
function inline(value: unknown): string {
  if (typeof value === "string") return scalar(value, false);
  if (Array.isArray(value)) return "[]";
  if (isObject(value)) return "{}";
  return JSON.stringify(value);
}

/** A string as a plain scalar where that reads back as the same string, and quoted otherwise. */
function scalar(text: string, key: boolean): string {
  return isPlain(text, key) ? text : quote(text);
}

function isPlain(text: string, key: boolean): boolean {
  if (text === "" || text !== text.trim() || UNPRINTABLE.test(text) || PLAIN_START.test(text)) return false;
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":") || YAML11_BOOLEANS.test(text)) return false;
  return readsBack(key ? `${text}: 0\n` : `k: ${text}\n`, key ? { [text]: 0 } : { k: text });
}

/**
 * A double-quoted scalar. JSON's escapes are all escapes YAML's double-quoted style has too, and
 * what JSON leaves as it is but YAML would not print is escaped the same way.
 */
function quote(text: string): string {
  return JSON.stringify(text).replace(
    /[\x7f-\x9f\u2028\u2029\ufeff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * A string over several lines as a literal block scalar, which keeps every line as the file
 * shows it. Left to a quoted scalar is what a block would need an indentation indicator or the
 * keep indicator (`+`) for: a first line that starts with a space, and more than one final
 * line break.
 */
function literalBlock(text: string): { header: string; lines: string[] } | undefined {
  if (!text.includes("\n") || UNPRINTABLE_IN_BLOCK.test(text)) return undefined;
  const clipped = text.endsWith("\n");
  const body = clipped ? text.slice(0, -1) : text;
  if (body.endsWith("\n") || body === "") return undefined;
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim() !== "") ?? "";
  if (/^\s/.test(first)) return undefined;
  const header = clipped ? "|" : "|-";
  const written = `k: ${header}\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}\n`;
  return readsBack(written, { k: text }) ? { header, lines } : undefined;
}

function readsBack(text: string, expected: unknown): boolean {
  try {
    return JSON.stringify(parseYaml(text)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
