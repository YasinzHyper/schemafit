import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";

/**
 * Expansion of the file patterns a shell leaves alone. cmd.exe and PowerShell pass `*.json` to
 * the program as written, and so does a POSIX shell when the pattern is quoted, so the CLI
 * expands what reaches it itself. The syntax is the shell's: `*` and `?` within one path
 * segment, `[abc]` / `[a-z]` / `[!a]` for one character, and `**` as a segment of its own for
 * any number of directories. A name that starts with `.` is matched only by a segment that
 * starts with `.` too, as in a shell. Braces come first, as in bash and zsh: `{a,b}` stands
 * for each of its comma-separated alternatives in turn, and each one is then matched on its own.
 */
export interface GlobOptions {
  /**
   * Read the pattern the way Windows does: `\` separates segments rather than escaping the
   * character after it, and names match without regard to case. Defaults to the platform's.
   */
  windows?: boolean;
}

/**
 * Whether `pattern` holds a wildcard or a brace expression, which is what makes it a pattern
 * rather than a path.
 */
export function isGlob(pattern: string, options: GlobOptions = {}): boolean {
  const windows = isWindows(options);
  return expandBraces(pattern, options).length > 1 || hasWildcards(pattern, windows);
}

/**
 * The patterns `pattern` stands for once its brace expressions are expanded, in the order bash
 * writes them: `{a,b}{1,2}` is `a1`, `a2`, `b1`, `b2`, and a group may hold another, so
 * `{a,b{c,d}}` is `a`, `bc`, `bd`. A brace with no comma inside its group, or one that never
 * closes, is a literal character, and outside Windows `\` keeps the brace or comma after it
 * from being read as part of a group. Escapes are left in place for the matching that follows.
 * Sequence expressions (`{1..3}`) are not expanded.
 */
export function expandBraces(pattern: string, options: GlobOptions = {}): string[] {
  const windows = isWindows(options);
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\" && !windows) {
      i++;
      continue;
    }
    if (pattern[i] !== "{") continue;
    const group = braceGroup(pattern, i, windows);
    if (group === undefined) continue;
    const prefix = pattern.slice(0, i);
    const suffixes = expandBraces(pattern.slice(group.end + 1), options);
    return group.parts
      .flatMap((part) => expandBraces(part, options))
      .flatMap((alternative) => suffixes.map((suffix) => prefix + alternative + suffix));
  }
  return [pattern];
}

/**
 * The alternatives of the group opened at `start` and where it closes, or nothing when the
 * brace there is a literal one: it never closes, or no comma separates alternatives in it.
 */
function braceGroup(pattern: string, start: number, windows: boolean): { parts: string[]; end: number } | undefined {
  const commas: number[] = [];
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && !windows) i++;
    else if (char === "{") depth++;
    else if (char === "," && depth === 1) commas.push(i);
    else if (char === "}" && --depth === 0) {
      if (commas.length === 0) return undefined;
      const bounds = [start, ...commas, i];
      return { parts: bounds.slice(1).map((bound, k) => pattern.slice(bounds[k]! + 1, bound)), end: i };
    }
  }
  return undefined;
}

/** One alternative of a pattern and the files it names. */
export interface GlobExpansion {
  /** The alternative, after brace expansion, as `expandBraces` returns it. */
  pattern: string;
  /**
   * The files it matches, sorted, and empty when it matches none. An alternative without a
   * wildcard names the one path it spells, whether or not that exists, as in a shell.
   */
  matches: string[];
}

/** Every alternative of `pattern`, in order, each with the files it matches. */
export async function expandPattern(pattern: string, options: GlobOptions = {}): Promise<GlobExpansion[]> {
  const windows = isWindows(options);
  const alternatives = expandBraces(pattern, options);
  const expansions: GlobExpansion[] = [];
  for (const alternative of alternatives) {
    // A pattern that had no braces is returned exactly as written, which is what it always was;
    // an alternative brace expansion produced loses the escapes the expansion left in it.
    const literal = alternatives.length === 1 ? alternative : unescape(alternative, windows);
    const matches = hasWildcards(alternative, windows) ? await matchGlob(alternative, windows) : [literal];
    expansions.push({ pattern: alternative, matches });
  }
  return expansions;
}

/**
 * Every file `pattern` matches: the matches of each alternative of its brace expressions in
 * turn, each sorted, and a file two alternatives match once. A pattern without a wildcard is
 * returned as it is, whether or not it exists, so reading it reports the error a path deserves.
 * Directories are never matched, because a schema is a file.
 */
export async function expandGlob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
  const found = new Set<string>();
  for (const { matches } of await expandPattern(pattern, options)) for (const match of matches) found.add(match);
  return [...found];
}

function hasWildcards(pattern: string, windows: boolean): boolean {
  return splitPattern(pattern, windows).segments.some((segment) => hasWildcard(segment, windows));
}

/** The files a pattern without brace expressions matches, sorted. */
async function matchGlob(pattern: string, windows: boolean): Promise<string[]> {
  const { segments, offsets } = splitPattern(pattern, windows);
  const first = segments.findIndex((segment) => hasWildcard(segment, windows));

  // The text in front of the first wildcard is the directory the search starts in, kept exactly
  // as the user wrote it, and every match continues it with the separator they used there, so a
  // match reads as a path under the one they typed.
  const start = offsets[first]!;
  const before = pattern.slice(0, start);
  const separator = start > 0 && isSeparator(pattern[start - 1]!, windows) ? pattern[start - 1]! : windows ? "\\" : "/";
  const base = unescape(isRoot(before, windows) ? before : before.replace(windows ? /[\\/]+$/ : /\/+$/, ""), windows);
  const found = new Set<string>();
  await search(base, segments.slice(first), { windows, separator }, found);
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isWindows(options: GlobOptions): boolean {
  return options.windows ?? process.platform === "win32";
}

const isSeparator = (char: string, windows: boolean): boolean => char === "/" || (windows && char === "\\");

/** Whether `prefix` is where a path starts (`/`, `C:\`), which keeps its separator, rather than a directory. */
const isRoot = (prefix: string, windows: boolean): boolean =>
  /^\/+$/.test(prefix) || (windows && /^([\\/]+|[A-Za-z]:[\\/]*)$/.test(prefix));

/** The pattern's segments, each with the offset it starts at. Empty segments are dropped. */
function splitPattern(pattern: string, windows: boolean): { segments: string[]; offsets: number[] } {
  const segments: string[] = [];
  const offsets: number[] = [];
  let start = 0;
  for (let i = 0; i <= pattern.length; i++) {
    if (i < pattern.length && !isSeparator(pattern[i]!, windows)) continue;
    if (i > start) {
      segments.push(pattern.slice(start, i));
      offsets.push(start);
    }
    start = i + 1;
  }
  return { segments, offsets };
}

function hasWildcard(segment: string, windows: boolean): boolean {
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === "\\" && !windows) i++;
    else if (char === "*" || char === "?") return true;
    else if (char === "[" && classEnd(segment, i, windows) !== -1) return true;
  }
  return false;
}

/** Where the bracket expression opened at `start` closes, or -1 when it does not, and `[` is literal. */
function classEnd(segment: string, start: number, windows: boolean): number {
  let i = start + 1;
  if (segment[i] === "!" || segment[i] === "^") i++;
  // A `]` right after the opening bracket is a member of the class rather than its end.
  if (segment[i] === "]") i++;
  for (; i < segment.length; i++) {
    if (segment[i] === "\\" && !windows) i++;
    else if (segment[i] === "]") return i;
  }
  return -1;
}

function unescape(segment: string, windows: boolean): string {
  return windows ? segment : segment.replace(/\\(.)/g, "$1");
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/-]/g;
const escapeRegex = (text: string): string => text.replace(REGEX_SPECIAL, "\\$&");

/** A wildcard segment as a regular expression over one directory entry's name. */
export function segmentRegex(segment: string, windows = process.platform === "win32"): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "\\" && !windows && i + 1 < segment.length) {
      source += escapeRegex(segment[++i]!);
    } else if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "[" && classEnd(segment, i, windows) !== -1) {
      const end = classEnd(segment, i, windows);
      let body = segment.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      const members = (windows ? body : body.replace(/\\(.)/g, "$1")).replace(/[\\\]^[]/g, "\\$&");
      source += `[${negated ? "^" : ""}${members}]`;
      i = end;
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`, windows ? "is" : "s");
}

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir === "" ? "." : dir, { withFileTypes: true });
  } catch {
    // A directory that is not there, or cannot be listed, matches nothing, as in a shell.
    return [];
  }
}

async function isDirectory(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(dir, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(dir, entry.name))).isFile();
  } catch {
    return false;
  }
}

interface SearchOptions {
  windows: boolean;
  /** What a match puts between a directory and the name under it. */
  separator: string;
}

function join(dir: string, name: string, separator = "/"): string {
  if (dir === "") return name;
  return /[\\/]$/.test(dir) ? `${dir}${name}` : `${dir}${separator}${name}`;
}

const hidden = (name: string, segment: string): boolean => name.startsWith(".") && !segment.startsWith(".");

async function search(dir: string, segments: readonly string[], options: SearchOptions, found: Set<string>): Promise<void> {
  const { windows, separator } = options;
  const [segment, ...rest] = segments;
  if (segment === undefined) return;

  if (segment === "**") {
    // Zero directories: the rest of the pattern applies right here.
    if (rest.length === 0) {
      await search(dir, ["*"], options, found);
    } else {
      await search(dir, rest, options, found);
    }
    for (const entry of await entries(dir)) {
      // Not through a symbolic link, which could lead back up the tree it came from.
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      await search(join(dir, entry.name, separator), segments, options, found);
    }
    return;
  }

  if (!hasWildcard(segment, windows)) {
    const next = join(dir, unescape(segment, windows), separator);
    if (rest.length > 0) {
      await search(next, rest, options, found);
      return;
    }
    try {
      if ((await stat(next)).isFile()) found.add(next);
    } catch {
      // Not there: nothing to add.
    }
    return;
  }

  const regex = segmentRegex(segment, windows);
  for (const entry of await entries(dir)) {
    if (hidden(entry.name, segment) || !regex.test(entry.name)) continue;
    if (rest.length > 0) {
      if (await isDirectory(dir, entry)) await search(join(dir, entry.name, separator), rest, options, found);
    } else if (await isFile(dir, entry)) {
      found.add(join(dir, entry.name, separator));
    }
  }
}
