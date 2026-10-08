import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Finding, JsonSchema, ProviderId, UnwrappedSchema } from "../src/index.js";
import { PROVIDER_IDS, fix, rewrap, unwrapAll } from "../src/index.js";
import { isLocalRef, referenceSites, referenceTarget } from "../src/refs.js";

const EXAMPLES = new URL("../examples/", import.meta.url);

/** Every provider on its own, plus all of them at once: the most portable rewrite. */
const SELECTIONS = {
  openai: ["openai"],
  anthropic: ["anthropic"],
  gemini: ["gemini"],
  all: PROVIDER_IDS,
} satisfies Record<string, readonly ProviderId[]>;

type Selection = keyof typeof SELECTIONS;

/**
 * What `--fix` leaves behind for each example, as `<severity> <rule id> <pointer>`, sorted.
 * A document that holds several schemas contributes the residue of all of them.
 * Every entry is a finding whose rule attaches no fix, and the comments say why there is none:
 * this is the list of things the tool still asks a person to do by hand. An entry that goes
 * means a new fix covers it, and the roadmap item behind it can be ticked; an entry that
 * appears is a rewrite that stopped working.
 */
const REMAINING: Record<string, Record<Selection, readonly string[]>> = {
  "anthropic-tool.json": {
    openai: [],
    anthropic: [],
    gemini: [],
    all: [],
  },
  "invoice-tool.json": {
    // "minLength" / "maxLength" on the country code, left in the copy the merge made and in the
    // definition it was copied from: undocumented rather than rejected, so no fix drops them.
    openai: [
      "warn openai/undocumented-keyword /$defs/address/properties/country",
      "warn openai/undocumented-keyword /$defs/address/properties/country",
      "warn openai/undocumented-keyword /properties/billing_address/properties/country",
      "warn openai/undocumented-keyword /properties/billing_address/properties/country",
    ],
    anthropic: [],
    gemini: [
      "warn gemini/undocumented-keyword /$defs/address/properties/country",
      "warn gemini/undocumented-keyword /$defs/address/properties/country",
      "warn gemini/undocumented-keyword /properties/billing_address",
      "warn gemini/undocumented-keyword /properties/currency",
    ],
    // Every provider's fixes on one schema reach a tool all three accept.
    all: [],
  },
  "ticket.json": {
    // "minLength", "maxLength", "uniqueItems": undocumented rather than rejected, so dropping
    // the constraint would give one up for nothing.
    openai: [
      "warn openai/undocumented-keyword /properties/tags",
      "warn openai/undocumented-keyword /properties/title",
      "warn openai/undocumented-keyword /properties/title",
    ],
    // Recursion needs a different schema, not a rewrite; two enum values that differ only in
    // case need a name only their author can choose.
    anthropic: [
      "error anthropic/no-recursive-schemas /$defs/reply/properties/replies/items",
      "warn anthropic/enum-casing /properties/category",
    ],
    // The Gemini rules carry no fixes: their docs list the subset with "such as", so a keyword
    // or format that is merely undocumented may well work.
    gemini: [
      "warn gemini/undocumented-format /properties/reporter/properties/email",
      "warn gemini/undocumented-format /properties/reporter/properties/website",
      "warn gemini/undocumented-keyword /properties/tags",
      "warn gemini/undocumented-keyword /properties/title",
      "warn gemini/undocumented-keyword /properties/title",
    ],
    // Fewer Gemini warnings than Gemini alone leaves: the Anthropic fixes already removed the
    // keywords it would have warned about, and the OpenAI one removed "format": "uri".
    all: [
      "error anthropic/no-recursive-schemas /$defs/reply/properties/replies/items",
      "warn anthropic/enum-casing /properties/category",
      "warn gemini/undocumented-format /properties/reporter/properties/email",
    ],
  },
  // An OpenAI Chat Completions request body with one strict tool and one the author deliberately
  // left non-strict. The round trip fixes both, because it goes straight at the schemas; what
  // the CLI reports on by default is the strict one alone.
  "chat-request.json": {
    // "minLength", "maxLength", "uniqueItems" on the non-strict tool: undocumented rather than
    // rejected, so no fix drops them — which is the whole reason that tool is not sent strictly.
    openai: [
      "warn openai/undocumented-keyword /properties/message",
      "warn openai/undocumented-keyword /properties/message",
      "warn openai/undocumented-keyword /properties/tags",
    ],
    anthropic: [],
    gemini: [
      "warn gemini/undocumented-keyword /properties/message",
      "warn gemini/undocumented-keyword /properties/message",
      "warn gemini/undocumented-keyword /properties/tags",
    ],
    // The Anthropic fixes already removed the keywords the other two only warn about.
    all: [],
  },
  // An Anthropic request body: two tools whose schemas every fix resolves, and a server tool
  // that declares no schema at all, which is why nothing here is reported against it.
  "messages-request.json": {
    openai: [],
    anthropic: [],
    gemini: [],
    all: [],
  },
  // An MCP `tools/list` response as it arrives on the wire, inside its JSON-RPC envelope. The
  // rewrites reach the tools through it and put them back in it, so the envelope round-trips.
  "mcp-tools-list.json": {
    // "maxLength" on the note title: undocumented rather than rejected, so no fix drops it.
    openai: ["warn openai/undocumented-keyword /properties/title"],
    anthropic: [],
    // The Gemini rules carry no fixes, so both of its warnings stay.
    gemini: ["warn gemini/undocumented-format /properties/source", "warn gemini/undocumented-keyword /properties/title"],
    // The Anthropic fixes dropped "maxLength" and the OpenAI one dropped "format": "uri", so
    // the keywords the other two only warn about are gone by the time Gemini's rules see them.
    all: [],
  },
  // Written by hand to fit everywhere, so there is nothing to rewrite and nothing to report.
  "ticket.portable.json": {
    openai: [],
    anthropic: [],
    gemini: [],
    all: [],
  },
};

function exampleFiles(): string[] {
  return readdirSync(EXAMPLES)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function readExample(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, EXAMPLES), "utf8"));
}

/** Every schema the example declares: one for a bare schema or a tool, several for a request body. */
function exampleSchemas(name: string): UnwrappedSchema[] {
  return unwrapAll(readExample(name));
}

/** `<severity> <rule id> <pointer>`, sorted, so the assertion is on the multiset. */
function residue(findings: readonly Finding[]): string[] {
  return findings.map((finding) => `${finding.severity} ${finding.ruleId} ${finding.path || "#"}`).sort();
}

/**
 * The local references of `root` that resolve to nothing. Inlining a definition and pruning
 * what it leaves behind is the part of `--fix` that can produce one.
 */
function danglingRefs(root: JsonSchema): string[] {
  return referenceSites(root)
    .filter((site) => typeof site.value === "string" && isLocalRef(site.value))
    .filter((site) => referenceTarget(root, site) === undefined)
    .map((site) => `${site.path || "#"} ${site.keyword}: ${String(site.value)}`);
}

describe("examples round-trip through --fix", () => {
  it("covers every example, so a new one cannot ship unchecked", () => {
    expect(exampleFiles()).toEqual(Object.keys(REMAINING).sort());
  });

  it("covers every provider, so a new one cannot ship unchecked", () => {
    expect(Object.keys(SELECTIONS).sort()).toEqual([...PROVIDER_IDS, "all"].sort());
  });

  for (const name of exampleFiles()) {
    describe(name, () => {
      it("goes back into the wrappers it came from", () => {
        const schemas = exampleSchemas(name);
        const fixed = schemas.map(({ schema }) => fix(schema, { providers: PROVIDER_IDS }).schema);

        let document = readExample(name);
        schemas.forEach(({ keys }, index) => void (document = rewrap(document, keys, fixed[index] as JsonSchema)));

        const again = unwrapAll(document);
        expect(again.map(({ wrapper, pointer }) => `${pointer || "#"} ${wrapper}`)).toEqual(
          schemas.map(({ wrapper, pointer }) => `${pointer || "#"} ${wrapper}`),
        );
        expect(again.map(({ schema }) => schema)).toEqual(fixed);
      });

      for (const selection of Object.keys(SELECTIONS) as Selection[]) {
        const providers: readonly ProviderId[] = SELECTIONS[selection];
        const expected = [...(REMAINING[name]?.[selection] ?? [])].sort();

        describe(`--provider ${selection}`, () => {
          const results = exampleSchemas(name).map(({ schema }) => fix(schema, { providers }));

          it("applies every fix the findings carry", () => {
            const fixable = results.flatMap((result) => result.findings).filter((finding) => finding.fix);
            expect(fixable.map((finding) => `${finding.ruleId} ${finding.path || "#"}`)).toEqual([]);
          });

          it("leaves only what no rule can rewrite", () => {
            expect(residue(results.flatMap((result) => result.findings))).toEqual(expected);
          });

          it("reports a provider as incompatible only where an error has no fix", () => {
            const incompatible = providers.filter((id) =>
              results.some((result) => result.summary.some((entry) => entry.provider === id && !entry.compatible)),
            );
            const blocked = providers.filter((id) => expected.some((entry) => entry.startsWith(`error ${id}/`)));
            expect(incompatible).toEqual([...blocked]);
          });

          it("settles: fixing the output again changes nothing", () => {
            for (const result of results) {
              const second = fix(result.schema, { providers });
              expect(second.applied).toEqual([]);
              expect(second.schema).toEqual(result.schema);
            }
          });

          it("leaves every local reference resolvable", () => {
            expect(results.flatMap((result) => danglingRefs(result.schema))).toEqual([]);
          });
        });
      }
    });
  }
});
