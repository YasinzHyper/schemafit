/**
 * A writer for the YAML the reader in `yaml.ts` reads, so a rewrite of a `.yaml` file can go
 * back into it.
 *
 * It writes block mappings and block sequences indented by two spaces, a sequence under a key
 * at the key's own indentation instead when the file it came from wrote that sequence there,
 * or wrote its first one there for a sequence the file did not hold, a list of scalars that
 * fits on its line in flow style (`type: [string, "null"]`) unless the file wrote it one item
 * to a line, or writes every collection in block style, a flow mapping or a flow sequence that
 * holds one (`items: {type: string}`) on its line where the file wrote it on one and it still
 * fits there, spaced inside its brackets as the file spaced it, a flow collection the file
 * spread one entry to a line, as Prettier breaks one that outgrew its line, spread the same way,
 * and one that outgrows its line below its key and then spread, where the file does that to its
 * own, a flow collection the file wrapped over lines, as PyYAML wraps one past 80 columns,
 * wrapped where the file wrapped it, the collections and the plain or quoted scalars it wrapped
 * inside it included, as `yaml.safe_dump(schema, default_flow_style=True)` wraps a whole schema,
 * `{}` and `[]` for the empty collections, a folded block
 * scalar (`>`) for a string
 * the file wrapped in one, a plain scalar continued on the lines below its key for one the file
 * wrapped that way, and a quoted
 * scalar continued before its closing quote for one the file wrapped in quotes, each on the
 * lines the file wrapped it on, a literal block scalar (`|`) for any other string over several
 * lines, and every other string plain where it reads back as itself — in this reader and in a YAML 1.1 one, which
 * takes `yes` and `off` for booleans, and in PyYAML, which ends a plain scalar inside a flow
 * collection at a `?` — and double-quoted where it does not. What it writes is
 * read back before it is returned, and a value that would not come back as itself is an error
 * rather than a file that says something else.
 *
 * Comments read off a file go back to the entries they belong to: one that sat on a line of its
 * own goes on a line above its entry, at the entry's indentation, and one that sat after a value
 * goes after the line that value ends on: the entry's first line, or the last line of a plain or
 * quoted scalar that starts there and is spread over lines. An empty line between two entries goes
 * back above the entry below it, in its place among that entry's comments.
 */

import { joinPointer } from "./pointer.js";
import {
  type YamlBlank,
  type YamlComment,
  type YamlFlow,
  type YamlFold,
  type YamlLayout,
  type YamlSequence,
  type YamlSpread,
  type YamlWrap,
  parseYaml,
  readYaml,
} from "./yaml.js";

const INDENT = 2;
/** How long a line may grow for a list of scalars to be written on it in flow style. */
const FLOW_WIDTH = 80;

/** What a plain scalar cannot start with: an indicator, a quote, or what a number starts with. */
const PLAIN_START = /^[-?:,[\]{}#&*!|>'"%@`~=<+.0-9]/;
/** The characters YAML asks to be escaped, or a reader may take for a line break. */
const UNPRINTABLE = /[\0-\x1f\x7f-\x9f\u2028\u2029\ufeff\ud800-\udfff]/u;
/** The same, less the tab and the line break a literal block scalar holds as they are. */
const UNPRINTABLE_IN_BLOCK = /[\0-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ufeff\ud800-\udfff]/u;
/**
 * What ends a plain scalar inside a flow collection. YAML 1.2 names only the comma and the
 * brackets, but PyYAML also ends one at a `?`, and quotes any string that holds one, so a plain
 * `Is it open?` there reads back in this reader and fails `yaml.safe_load`.
 */
const FLOW_BREAKS = /[,?[\]{}]/;
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
  /** How to indent a sequence under a key that `sequences` does not name. */
  indentSequences: boolean;
  /** The sequences the file wrote in block style, by their pointers. */
  sequences: Map<string, YamlSequence>;
  /** Whether a list of scalars `sequences` does not name is written one item to a line too. */
  blockLists: boolean;
  /** How each string the file wrapped over lines was written, by the pointer of the string. */
  folds: Map<string, YamlFold>;
  /** The collections the file wrote in flow style, on one line or spread over lines, by their pointers. */
  flows: Map<string, YamlFlow>;
  /**
   * Whether a flow collection `flows` does not name, such as a list a fix adds, has a space
   * inside its brackets, as the file's first flow collection of the same kind on one line has.
   */
  padded: Record<YamlFlow["kind"], boolean>;
  /**
   * How far below its key a flow collection goes once it no longer fits after the key: as far as
   * the file's first collection below its key went. Undefined for a file that puts none there.
   */
  below: number | undefined;
  /**
   * How a collection in block context that fits on no line is spread: as the file's first
   * collection spread over lines is. Undefined for a file that spreads none, where such a
   * collection goes into block style.
   */
  spread: YamlSpread | undefined;
}

/**
 * The lines written for a node, and the index of the one a comment after it goes on: the line
 * the value its first line starts ends on, which is the last line of a plain or quoted scalar
 * spread over lines — after the first, the comment would end a plain one there and be read as
 * part of a quoted one — and the first line for any other value.
 */
interface Written {
  lines: string[];
  trail: number;
}

/**
 * Writes a JSON value as YAML, with the `comments` and the empty lines (`blanks`) given, which
 * `readYaml` reads off a file as `attached` and `blanks`, and its sequences indented as the
 * `layout` `readYaml` reads off a file says, its lists of scalars one item to a line where that
 * layout says the file writes them all that way, and the strings it names as folded, or as plain or
 * quoted scalars spread over lines, wrapped on the lines the file wrapped them on, where the string still
 * reads that way. An empty line with no
 * entry below it is left out, since nothing follows it to keep apart. Throws a `TypeError` for a value JSON cannot hold
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
  const placed: Layout = {
    above: new Map(),
    after: new Map(),
    indentSequences: layout.indentSequences ?? true,
    sequences: new Map((layout.sequences ?? []).map((sequence) => [sequence.pointer, sequence])),
    blockLists: layout.blockLists ?? false,
    folds: new Map((layout.folds ?? []).map((folded) => [folded.pointer, folded])),
    flows: new Map((layout.flows ?? []).map((flow) => [flow.pointer, flow])),
    padded: {
      mapping: layout.flows?.find((flow) => flow.kind === "mapping" && onOneLine(flow))?.padded ?? false,
      sequence: layout.flows?.find((flow) => flow.kind === "sequence" && onOneLine(flow))?.padded ?? false,
    },
    below: layout.flows?.find(({ below }) => below !== undefined)?.below,
    spread: layout.flows?.find(({ spread }) => spread !== undefined)?.spread,
  };
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
  const parsed = JSON.parse(json) as unknown;
  // A document the file wrote as one flow collection stays on the lines the file wrote it on.
  const flow = commentsWithin("", placed) || foldsWithin("", placed) ? undefined : rootFlow(parsed, placed);
  const written = [...(flow ?? block(parsed, 0, "", placed).lines), ...end];
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

/** Whether the file wrote a flow collection on the one line it opens on. */
function onOneLine({ spread, wrap }: YamlFlow): boolean {
  return spread === undefined && wrap === undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The lines of a node that starts on a line of its own, at `indent`. */
function block(value: unknown, indent: number, pointer: string, layout: Layout): Written {
  const pad = " ".repeat(indent);
  if (Array.isArray(value) && value.length > 0) {
    return concat(
      value.map((item, index) => {
        const at = joinPointer(pointer, index);
        return commented(entry(`${pad}-`, item, indent, true, at, layout), pad, at, layout);
      }),
    );
  }
  if (isObject(value) && Object.keys(value).length > 0) {
    return concat(
      Object.entries(value).map(([key, item]) => {
        const at = joinPointer(pointer, key);
        return commented(entry(`${pad}${scalar(key, true)}:`, item, indent, false, at, layout), pad, at, layout);
      }),
    );
  }
  return { lines: [`${pad}${inline(value)}`], trail: 0 };
}

/** The entries of a collection one after the other, whose first line is the first entry's. */
function concat(entries: readonly Written[]): Written {
  return { lines: entries.flatMap(({ lines }) => lines), trail: entries[0]?.trail ?? 0 };
}

/**
 * The lines of an entry, at the indentation `pad`, with its comments: those above it, and the one
 * after the line its value ends on.
 */
function commented({ lines, trail }: Written, pad: string, pointer: string, layout: Layout): Written {
  const above = (layout.above.get(pointer) ?? []).map((text) => (text === "" ? "" : `${pad}${text}`));
  const after = layout.after.get(pointer);
  if (after === undefined) return { lines: [...above, ...lines], trail: above.length + trail };
  const trailed = lines.map((line, index) => (index === trail ? `${line} ${after}` : line));
  // Where the reader would take the comment into the value before it, the comment goes on a line
  // of its own above the entry instead, rather than be lost or change the value.
  if (!readsAlike(lines, trailed, pad.length)) {
    return { lines: [...above, `${pad}${after}`, ...lines], trail: above.length + 1 + trail };
  }
  return { lines: [...above, ...trailed], trail: above.length + trail };
}

/** Whether two versions of an entry's lines at `indent` read as the same value. */
function readsAlike(lines: readonly string[], other: readonly string[], indent: number): boolean {
  const text = (written: readonly string[]): string => `${written.map((line) => line.slice(indent)).join("\n")}\n`;
  try {
    return readsBack(text(other), parseYaml(text(lines)));
  } catch {
    return false;
  }
}

/**
 * Whether a line the writer produced is a comment or an empty line between two entries, which
 * no key or dash it writes looks like.
 */
function isLayout(line: string): boolean {
  return line === "" || line.trimStart().startsWith("#");
}

/** One mapping entry or sequence item: `prefix` is its key and colon, or its dash. */
function entry(prefix: string, value: unknown, indent: number, dash: boolean, pointer: string, layout: Layout): Written {
  const child = indent + INDENT;
  // A flow collection has no line of its own for a comment on one of its entries, or an empty
  // line between two, and puts a string the file wrapped over lines on one. A list the file wrote
  // one item to a line stays that way, and in a file that writes every collection in block style,
  // so does one it did not hold.
  const lined = layout.blockLists || layout.sequences.has(pointer) || commentsWithin(pointer, layout) || foldsWithin(pointer, layout);
  const flow = lined ? undefined : flowLines(prefix, value, indent, dash, pointer, layout);
  if (flow !== undefined) return { lines: flow, trail: 0 };
  if (isCollection(value)) {
    // A sequence under a key may sit at the key's own indentation, where its dashes count as
    // the indentation the items need.
    const indented = layout.sequences.get(pointer)?.indented ?? layout.indentSequences;
    const compact = !dash && Array.isArray(value) && !indented;
    const { lines, trail } = block(value, compact ? indent : child, pointer, layout);
    // A collection in a sequence item starts on the dash's line, which YAML reads at the
    // column of its first character; under a key it starts on the line below.
    if (!dash) return { lines: [prefix, ...lines], trail: 0 };
    // A comment above the first entry of that collection would split the dash from it, so it
    // goes above the dash.
    const above = lines.findIndex((line) => !isLayout(line));
    const hoisted = lines.slice(0, above).map((line) => line.slice(child - indent));
    const [first = "", ...rest] = lines.slice(above);
    // Every line keeps its place, so a comment after the dash goes where one after the first
    // entry of the collection would: after the last line of a scalar that entry spreads over lines.
    return { lines: [...hoisted, `${prefix} ${first.slice(child)}`, ...rest], trail };
  }
  if (typeof value === "string") {
    const wrapped = layout.folds.get(pointer);
    if (wrapped !== undefined && wrapped.style !== ">") {
      const lines =
        wrapped.style === "plain"
          ? plainLines(value, wrapped.lines, prefix.length + 1, child)
          : quotedLines(value, wrapped.lines, wrapped.style, prefix.length + 1, child);
      if (lines !== undefined) {
        const [first, ...rest] = lines;
        return {
          lines: [`${prefix} ${first}`, ...rest.map((line) => (line === "" ? "" : `${" ".repeat(child)}${line}`))],
          trail: lines.length - 1,
        };
      }
    }
    const scalarBlock = (wrapped?.style === ">" ? foldedBlock(value, wrapped.lines) : undefined) ?? literalBlock(value);
    if (scalarBlock !== undefined) {
      const pad = " ".repeat(child);
      return {
        lines: [`${prefix} ${scalarBlock.header}`, ...scalarBlock.lines.map((line) => (line === "" ? "" : `${pad}${line}`))],
        trail: 0,
      };
    }
  }
  return { lines: [`${prefix} ${inline(value)}`], trail: 0 };
}

/** Whether a comment belongs to an entry inside the node at `pointer`. */
function commentsWithin(pointer: string, layout: Layout): boolean {
  return [...layout.above.keys(), ...layout.after.keys()].some((at) => at.startsWith(`${pointer}/`));
}

/** Whether a collection the file spread over lines sits inside the node at `pointer`. */
function spreadsWithin(pointer: string, layout: Layout): boolean {
  return [...layout.flows.values()].some((flow) => flow.spread !== undefined && flow.pointer.startsWith(`${pointer}/`));
}

/**
 * Whether a string the file wrapped over lines in block context sits inside the node at `pointer`.
 * One the file wrapped inside a flow collection is the collection's to keep wrapped.
 */
function foldsWithin(pointer: string, layout: Layout): boolean {
  return [...layout.folds.values()].some(({ pointer: at, indent }) => indent === undefined && at.startsWith(`${pointer}/`));
}

/** Whether a value is a collection with something in it, which an empty `[]` or `{}` is not. */
function isCollection(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0;
}

/**
 * The document as the flow collection the file wrote it as, on its one line while it fits there,
 * spread one entry to a line as the file spread it, and wrapped over lines as the file wrapped
 * it, or undefined for a document the file wrote in block style, and for one that does not fit
 * on its line or would not read back.
 */
function rootFlow(value: unknown, layout: Layout): string[] | undefined {
  const { spread, wrap, padded = false } = layout.flows.get("") ?? {};
  if (spread !== undefined && isCollection(value)) {
    const lines = spreadLines(value, "", 0, spread, layout);
    return readsBack(`${lines.join("\n")}\n`, value) ? lines : undefined;
  }
  if (wrap !== undefined && isCollection(value)) {
    const lines = wrapLines(value, "", "", 0, wrap, padded, layout);
    if (readsBack(`${lines.join("\n")}\n`, value)) return lines;
  }
  const flow = layout.flows.has("") ? flowCollection(value, "", layout) : undefined;
  return flow !== undefined && flow.length <= flowWidth("", layout) ? [flow] : undefined;
}

/**
 * A mapping entry or sequence item whose value is a collection in flow style, where the file
 * wrote it that way or it is a list of scalars: spread as the file spread it, whatever its
 * length, and on the one line the file wrote it on — after its key or dash, or below the key —
 * while that line holds it. One that outgrows its line goes below its key the way the file's
 * first collection below its key went, and is spread the way the file's first collection spread
 * over lines is where it does not fit there either, which is what Prettier does to a collection
 * that outgrew its line. Undefined for a value to write in block style: a mapping the file did
 * not write in flow style, and a collection that fits on no line in a file that spreads none.
 */
function flowLines(prefix: string, value: unknown, indent: number, dash: boolean, pointer: string, layout: Layout): string[] | undefined {
  const record = layout.flows.get(pointer);
  // Only a key has a line to go below, and a sequence item's value starts past its dash.
  const below = dash ? undefined : record?.below;
  if (record?.spread !== undefined && isCollection(value)) return spreadEntry(prefix, value, indent, dash, below, record.spread, pointer, layout);
  if (record?.wrap !== undefined && isCollection(value)) {
    const base = below === undefined ? indent + (dash ? INDENT : 0) : indent + below;
    const lines = wrapLines(value, pointer, below === undefined ? `${prefix} ` : " ".repeat(base), base, record.wrap, record.padded, layout);
    const entry = below === undefined ? lines : [prefix, ...lines];
    // Where the wrapped lines would not read back, it is written as any other flow collection the file held.
    if (entryReadsBack(prefix, entry, indent, dash, value)) return entry;
  }
  const flow = flowCollection(value, pointer, layout);
  if (flow === undefined) return undefined;
  const width = flowWidth(pointer, layout);
  if (below === undefined && prefix.length + 1 + flow.length <= width) return [`${prefix} ${flow}`];
  const under = dash ? undefined : (below ?? layout.below);
  if (under !== undefined && indent + under + flow.length <= width) return [prefix, `${" ".repeat(indent + under)}${flow}`];
  if (layout.spread === undefined || !isCollection(value)) return undefined;
  return spreadEntry(prefix, value, indent, dash, under, layout.spread, pointer, layout);
}

/**
 * A mapping entry or sequence item whose value is a collection spread one entry to a line,
 * opened after its key or dash, or `below` the key on a line of its own. Undefined where those
 * lines would not read back as the value: a file may close a collection under its key, which the
 * reader takes inside a JSON document and refuses from a block mapping, so a collection a fix
 * moves out of one goes into block style.
 */
function spreadEntry(
  prefix: string,
  value: unknown[] | Record<string, unknown>,
  indent: number,
  dash: boolean,
  below: number | undefined,
  spread: YamlSpread,
  pointer: string,
  layout: Layout,
): string[] | undefined {
  const base = below === undefined ? indent + (dash ? INDENT : 0) : indent + below;
  const [open = "", ...rest] = spreadLines(value, pointer, base, spread, layout);
  const lines = below === undefined ? [`${prefix} ${open}`, ...rest] : [prefix, `${" ".repeat(base)}${open}`, ...rest];
  return entryReadsBack(prefix, lines, indent, dash, value) ? lines : undefined;
}

/** Whether the lines of a mapping entry or sequence item at `indent`, `prefix` first, read back as `value`. */
function entryReadsBack(prefix: string, lines: readonly string[], indent: number, dash: boolean, value: unknown): boolean {
  const [first = "", ...after] = lines;
  const text = [`${dash ? "-" : "k:"}${first.slice(prefix.length)}`, ...after.map((line) => line.slice(indent))];
  return readsBack(`${text.join("\n")}\n`, dash ? [value] : { k: value });
}

/**
 * A collection wrapped over lines as `wrap` says, from `base`, the column the line it opens on
 * starts at, after `opening`, what that line holds before the opening bracket.
 */
function wrapLines(
  value: unknown[] | Record<string, unknown>,
  pointer: string,
  opening: string,
  base: number,
  wrap: YamlWrap,
  padded: boolean,
  layout: Layout,
): string[] {
  const pen: Pen = { done: [], line: opening };
  wrapOnto(pen, value, pointer, wrap, padded, base, base, layout);
  return [...pen.done, pen.line];
}

/** The lines a collection wrapped over lines is written on: those already finished, and the one being written. */
interface Pen {
  done: string[];
  line: string;
}

/**
 * Writes a collection wrapped over lines as `wrap` says onto the end of the pen's line. Each
 * entry starts a new line where the file started one, and where it would carry its line past the
 * file's longest, so the entries a fix adds, such as the keys `openai/all-required` adds to a
 * `required`, fill the last line and wrap where the file wrapped. An entry the file wrapped over
 * lines itself — a collection wrapped this way, or a plain or quoted scalar spread over lines — is
 * written onto the line it starts on and the lines below as the file wrote it, and the entries
 * after it follow it on its last line, which is how
 * `yaml.safe_dump(schema, default_flow_style=True)` writes a whole schema. Its columns are measured from `frame`, the column the line the outermost
 * collection opens on starts at, wherever the line it opens on starts, so its lines start at the
 * column the file started them at, or for one whose entries the file started no line with, at
 * `held`, the column of the lines of the collection it is in, plus two, as PyYAML indents each
 * collection it nests. Spaced inside its brackets as the file spaced it, with `padded`, where an
 * entry follows the opening one or precedes the closing one on its line.
 */
function wrapOnto(
  pen: Pen,
  value: unknown[] | Record<string, unknown>,
  pointer: string,
  wrap: YamlWrap,
  padded: boolean,
  frame: number,
  held: number,
  layout: Layout,
): void {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(value) ? value.map((item) => [undefined, item]) : Object.entries(value);
  // The entries the file started a line with, by their indexes: the first of each line after the one it opens on.
  const starts = new Set<number>();
  let index = wrap.lines[0] ?? 0;
  for (const count of wrap.lines.slice(1)) {
    starts.add(index);
    index += count;
  }
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const pad = padded ? " " : "";
  const closing = wrap.close === undefined ? `${pad}${close}` : "";
  const column = wrap.entries === undefined ? held + INDENT : frame + wrap.entries;
  const width = frame + wrap.width;
  pen.line += open;
  entries.forEach(([key, item], at) => {
    const last = at === entries.length - 1;
    const comma = last && !wrap.trailing ? "" : ",";
    const where = joinPointer(pointer, key ?? at);
    // A flow mapping's key runs to its first colon, so a key holding one is quoted.
    const head = key === undefined ? "" : `${flowScalar(key, key.includes(":"))}: `;
    // Where it goes after the line so far, which is where its lines are worked out from.
    const inner = wrappedWithin(item, where, `${pen.line}${at === 0 ? pad : " "}${head}`.length, frame, layout);
    // What the entry puts on the line it starts on: all of it, or up to where the file wrapped it.
    const first = inner === undefined ? `${head}${flowNode(item, where, layout)}${last ? closing : ""}` : `${head}${inner.first}`;
    // The comma is left out of the measure, so an entry that gains one as a fix adds another after it stays where it was.
    if (at === 0 ? starts.has(0) : starts.has(at) || `${pen.line} ${first}`.length > width) {
      pen.done.push(pen.line);
      pen.line = " ".repeat(column);
    } else {
      pen.line += at === 0 ? pad : " ";
    }
    pen.line += head;
    if (inner === undefined) pen.line += flowNode(item, where, layout);
    else inner.write(pen, column);
    pen.line += comma;
  });
  if (wrap.close === undefined) {
    pen.line += closing;
    return;
  }
  pen.done.push(pen.line);
  pen.line = `${" ".repeat(frame + wrap.close)}${close}`;
}

/**
 * How to write an entry of a collection wrapped over lines that the file wrapped over lines
 * itself onto the pen, given the column of the lines of the collection it is in: a collection
 * wrapped the same way, or a plain or quoted scalar spread over lines that would start at column
 * `start`, with what it puts on the line it starts on. Their columns are measured from `frame`.
 * Undefined for any other entry, and for a scalar the file's lines no longer hold, which go on one
 * line.
 */
function wrappedWithin(
  value: unknown,
  pointer: string,
  start: number,
  frame: number,
  layout: Layout,
): { first: string; write: (pen: Pen, held: number) => void } | undefined {
  const record = layout.flows.get(pointer);
  if (record?.wrap !== undefined && isCollection(value)) {
    const { wrap, padded } = record;
    return {
      first: Array.isArray(value) ? "[" : "{",
      write: (pen, held) => wrapOnto(pen, value, pointer, wrap, padded, frame, held, layout),
    };
  }
  const fold = layout.folds.get(pointer);
  if (typeof value !== "string" || fold === undefined || fold.style === ">" || fold.indent === undefined) return undefined;
  const { style } = fold;
  const column = frame + fold.indent;
  const linesAt = (at: number): string[] | undefined => {
    const lines = style === "plain" ? plainLines(value, fold.lines, at, column) : quotedLines(value, fold.lines, style, at, column);
    // A plain scalar a fix added a comma or a bracket to would end there inside the collection.
    return style === "plain" && !lines?.every(inFlowPlain) ? undefined : lines;
  };
  const first = linesAt(start)?.[0];
  if (first === undefined) return undefined;
  return {
    first,
    write: (pen) => {
      const [opening = "", ...rest] = linesAt(pen.line.length) ?? [flowScalar(value, false)];
      pen.line += opening;
      for (const line of rest) {
        pen.done.push(pen.line);
        pen.line = line === "" ? "" : `${" ".repeat(column)}${line}`;
      }
    },
  };
}

/**
 * A collection spread one entry to a line as `spread` says, from `base`, the column the line it
 * opens on starts at: its opening bracket, which the caller puts at the end of that line, then
 * a line or more for each entry, and its closing bracket on a line of its own.
 */
function spreadLines(value: unknown[] | Record<string, unknown>, pointer: string, base: number, spread: YamlSpread, layout: Layout): string[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(value)
    ? value.map((item) => [undefined, item])
    : Object.entries(value);
  const column = base + spread.entries;
  const lines = entries.flatMap(([key, item], index) => {
    const comma = index < entries.length - 1 || spread.trailing ? "," : "";
    return flowEntry(key, item, joinPointer(pointer, key ?? index), column, comma, spread, layout);
  });
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return [open, ...lines, `${" ".repeat(base + spread.close)}${close}`];
}

/**
 * One entry of a collection spread over lines, starting at `column` and followed by `comma`: a
 * scalar after its key, and a collection where the file wrote it — on its line or below its key,
 * on one line or spread over lines. A collection that outgrows its line, or one the file did not
 * write, such as the branch a fix adds to an `anyOf`, goes on one line after its key, or below
 * it as far as the file's first one went, while it fits there, and is spread as `around`, the
 * collection it is in, is spread when it does not, or when it holds one the file spread. Inside
 * a flow collection, block style is no option.
 */
function flowEntry(
  key: string | undefined,
  value: unknown,
  pointer: string,
  column: number,
  comma: string,
  around: YamlSpread,
  layout: Layout,
): string[] {
  // A flow mapping's key runs to its first colon, so a key holding one is quoted.
  const head = `${" ".repeat(column)}${key === undefined ? "" : `${flowScalar(key, key.includes(":"))}:`}`;
  const gap = key === undefined ? "" : " ";
  if (!isCollection(value)) return [`${head}${gap}${flowNode(value, pointer, layout)}${comma}`];
  const record = layout.flows.get(pointer);
  // One the file spread stays where it opened, and any other goes below its key once it has to.
  const below = key === undefined ? undefined : record?.spread !== undefined ? record.below : (record?.below ?? layout.below);
  if (record?.spread === undefined && !spreadsWithin(pointer, layout)) {
    const flow = flowNode(value, pointer, layout);
    const width = flowWidth(pointer, layout);
    const after = `${head}${gap}${flow}${comma}`;
    const under = below === undefined ? undefined : `${" ".repeat(column + below)}${flow}${comma}`;
    // One the file wrote below its key stays there, and any other tries after its key first.
    if (record?.below === undefined && after.length <= width) return [after];
    if (under !== undefined && under.length <= width) return [head, under];
  }
  const base = below === undefined ? column : column + below;
  const [open = "", ...rest] = spreadLines(value, pointer, base, record?.spread ?? around, layout);
  const closed = [...rest.slice(0, -1), `${rest[rest.length - 1] ?? ""}${comma}`];
  return below === undefined ? [`${head}${gap}${open}`, ...closed] : [head, `${" ".repeat(base)}${open}`, ...closed];
}

/**
 * A collection in flow style, for one the file wrote that way on one line and for any list of
 * nothing but scalars, or undefined for any other value, an empty collection, and one the flow
 * style would not read back as.
 */
function flowCollection(value: unknown, pointer: string, layout: Layout): string | undefined {
  if (!isCollection(value)) return undefined;
  const scalars = Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null);
  if (!scalars && !layout.flows.has(pointer)) return undefined;
  const flow = flowNode(value, pointer, layout);
  return readsBack(`k: ${flow}\n`, { k: value }) ? flow : undefined;
}

/**
 * How long the line a flow collection is written on may grow: as long as the line the file
 * wrote it on, and to `FLOW_WIDTH` whatever that was, so a collection a fix leaves as it was
 * stays on its line and one it lengthens moves into block style where a short one would not.
 */
function flowWidth(pointer: string, layout: Layout): number {
  return Math.max(FLOW_WIDTH, layout.flows.get(pointer)?.width ?? 0);
}

/** A node inside a flow collection, its collections spaced inside their brackets as the file spaced them. */
function flowNode(value: unknown, pointer: string, layout: Layout): string {
  const spaced = (open: string, entries: string[], close: string, kind: YamlFlow["kind"]): string => {
    if (entries.length === 0) return `${open}${close}`;
    const pad = (layout.flows.get(pointer)?.padded ?? layout.padded[kind]) ? " " : "";
    return `${open}${pad}${entries.join(", ")}${pad}${close}`;
  };
  if (Array.isArray(value)) {
    return spaced("[", value.map((item, index) => flowNode(item, joinPointer(pointer, index), layout)), "]", "sequence");
  }
  if (isObject(value)) {
    // A flow mapping's key runs to its first colon, so a key holding one is quoted.
    const entries = Object.entries(value).map(
      ([key, item]) => `${flowScalar(key, key.includes(":"))}: ${flowNode(item, joinPointer(pointer, key), layout)}`,
    );
    return spaced("{", entries, "}", "mapping");
  }
  return typeof value === "string" ? flowScalar(value, false) : JSON.stringify(value);
}

/** A string inside a flow collection, plain where that reads back as the same string. */
function flowScalar(text: string, quoted: boolean): string {
  return !quoted && isPlain(text, false) && !FLOW_BREAKS.test(text) ? text : quote(text);
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

/**
 * A string as the folded block scalar a file wrote it in, on the lines the file wrapped it on:
 * the same lines for the same string, and for one a fix added a sentence to — what `withNote`
 * does to a `description` — those lines with the sentence after the last of them, wrapped at
 * the width of the file's longest line. A file that kept the block on one line gave no width to
 * wrap at, so the sentence goes on that line. Undefined for any other string, and for one the
 * block would not read back as, which is then written as any other string is.
 */
function foldedBlock(text: string, wrapped: readonly string[]): { header: string; lines: string[] } | undefined {
  if (UNPRINTABLE_IN_BLOCK.test(text)) return undefined;
  const clipped = text.endsWith("\n");
  const body = clipped ? text.slice(0, -1) : text;
  if (body.endsWith("\n") || body === "" || wrapped.length === 0) return undefined;
  const header = clipped ? ">" : ">-";
  const same = [...wrapped];
  if (foldsTo(header, same, text)) return { header, lines: same };
  const before = foldValue(wrapped);
  if (before === undefined || !body.startsWith(`${before} `)) return undefined;
  const sentence = body.slice(before.length + 1);
  const width = wrapped.length > 1 ? Math.max(...wrapped.map((line) => line.length)) : Infinity;
  const extended = [...wrapped.slice(0, -1), ...wrapWords(wrapped[wrapped.length - 1] ?? "", sentence, width)];
  if (foldsTo(header, extended, text)) return { header, lines: extended };
  // Words a single space does not separate cannot be wrapped apart, so they stay on the last line.
  const appended = [...wrapped.slice(0, -1), `${wrapped[wrapped.length - 1] ?? ""} ${sentence}`];
  return foldsTo(header, appended, text) ? { header, lines: appended } : undefined;
}

/**
 * A string as the plain scalar a file spread over lines, on the lines the file wrapped it on,
 * the first of them after the key at column `start` and the rest at column `indent`: the same
 * lines for the same string, and for one a fix added a sentence to, those lines with the
 * sentence after the last of them, wrapped where the file's longest line ends. Undefined for any
 * other string, and for one those lines would not read back as.
 */
function plainLines(text: string, wrapped: readonly string[], start: number, indent: number): string[] | undefined {
  const [first = ""] = wrapped;
  // What the first line starts with is read as an indicator, which `- ` would make a sequence of under a dash.
  if (wrapped.length < 2 || !isPlain(first, false) || UNPRINTABLE_IN_BLOCK.test(text)) return undefined;
  if (plainReadsAs(wrapped, text)) return [...wrapped];
  const before = plainValue(wrapped);
  if (before === undefined || !text.startsWith(`${before} `)) return undefined;
  const sentence = text.slice(before.length + 1);
  const width = Math.max(...wrapped.map((line, index) => (index === 0 ? start : indent) + line.length)) - indent;
  const extended = [...wrapped.slice(0, -1), ...wrapWords(wrapped[wrapped.length - 1] ?? "", sentence, width)];
  if (plainReadsAs(extended, text)) return extended;
  const appended = [...wrapped.slice(0, -1), `${wrapped[wrapped.length - 1] ?? ""} ${sentence}`];
  return plainReadsAs(appended, text) ? appended : undefined;
}

/**
 * A string as the quoted scalar a file spread over lines, on the lines the file wrapped it on,
 * spelled as the file spelled them: the same lines for the same string, and for one a fix added
 * a sentence to, those lines with the sentence before the closing quote, escaped for the quotes
 * the file used and wrapped where the file's longest line ends. A string that ends in white space,
 * as one does when its closing quote sits on a line of its own, may have had that white space
 * trimmed before the sentence was added, as a fix does, and then the lines that held only it go.
 * Undefined for any other string, and for one those lines would not read back as.
 */
function quotedLines(text: string, wrapped: readonly string[], mark: '"' | "'", start: number, indent: number): string[] | undefined {
  const last = wrapped[wrapped.length - 1] ?? "";
  if (wrapped.length < 2 || !wrapped[0]?.startsWith(mark) || !last.endsWith(mark)) return undefined;
  if (plainReadsAs(wrapped, text)) return [...wrapped];
  const before = plainValue(wrapped);
  if (before === undefined) return undefined;
  // A fix trims a description before it adds its sentence, which takes off the space the line
  // break before a closing quote on a line of its own folds into, and any spaces before the quote.
  const kept = text.startsWith(`${before} `) ? before : before.trimEnd();
  if (kept === "" || !text.startsWith(`${kept} `)) return undefined;
  const added = text.slice(kept.length + 1);
  const sentence = mark === '"' ? quote(added).slice(1, -1) : added.replaceAll("'", "''");
  const width = Math.max(...wrapped.map((line, index) => (index === 0 ? start : indent) + line.length)) - indent;
  // The lines up to the closing quote, without what the trimmed string no longer holds: a line
  // that held nothing but the quote, the empty lines above it, and the spaces that end the last.
  const body = [...wrapped.slice(0, -1), last.slice(0, -1)];
  if (kept !== before) {
    while (body.length > 1 && body[body.length - 1]!.trim() === "") body.pop();
    body[body.length - 1] = body[body.length - 1]!.trimEnd();
  }
  const open = body[body.length - 1]!;
  const lines = wrapWords(open, sentence, width);
  const extended = [...body.slice(0, -1), ...lines.slice(0, -1), `${lines[lines.length - 1] ?? ""}${mark}`];
  if (plainReadsAs(extended, text)) return extended;
  const appended = [...body.slice(0, -1), `${open === "" ? "" : `${open} `}${sentence}${mark}`];
  return plainReadsAs(appended, text) ? appended : undefined;
}

/**
 * Whether a line of a plain scalar inside a flow collection is text there: it holds nothing in
 * `FLOW_BREAKS`, which would end the scalar, and nothing that starts a comment or reads as a key's colon.
 */
function inFlowPlain(line: string): boolean {
  return !FLOW_BREAKS.test(line) && !line.startsWith("#") && !line.includes(" #") && !/:( |$)/.test(line);
}

function plainText(lines: readonly string[]): string {
  const [first = "", ...rest] = lines;
  return `k: ${first}\n${rest.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}\n`;
}

function plainReadsAs(lines: readonly string[], text: string): boolean {
  return readsBack(plainText(lines), { k: text });
}

/** The string the lines of a plain scalar spread over lines stand for. */
function plainValue(lines: readonly string[]): string | undefined {
  try {
    const value = parseYaml(plainText(lines));
    return isObject(value) && typeof value.k === "string" ? value.k : undefined;
  } catch {
    return undefined;
  }
}

/** `line` with the words of `sentence` after it, onto new lines where they would pass `width`. */
function wrapWords(line: string, sentence: string, width: number): string[] {
  const lines: string[] = [];
  let current = line;
  for (const word of sentence.split(" ")) {
    if (current !== "" && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  return [...lines, current];
}

/** The string the lines of a folded block scalar stand for, with no final line break. */
function foldValue(lines: readonly string[]): string | undefined {
  try {
    const value = parseYaml(blockText(">-", lines));
    return isObject(value) && typeof value.k === "string" ? value.k : undefined;
  } catch {
    return undefined;
  }
}

function foldsTo(header: string, lines: readonly string[], text: string): boolean {
  return readsBack(blockText(header, lines), { k: text });
}

function blockText(header: string, lines: readonly string[]): string {
  return `k: ${header}\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}\n`;
}

function readsBack(text: string, expected: unknown): boolean {
  try {
    return JSON.stringify(parseYaml(text)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}
