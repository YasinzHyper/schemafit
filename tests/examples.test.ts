import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Finding, JsonSchema, ProviderId } from "../src/index.js";
import { PROVIDER_IDS, fix, rewrap, unwrap } from "../src/index.js";
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
    // The merge that resolves these two is attached to "openai/unsupported-composition", so
    // Anthropic alone is left with an error the tool can in fact rewrite. See the roadmap.
    anthropic: [
      "error anthropic/allof-ref /properties/billing_address/allOf/0",
      "error anthropic/allof-ref /properties/currency/allOf/0",
    ],
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
      it("goes back into the wrapper it came from", () => {
        const document = readExample(name);
        const { schema, wrapper, keys } = unwrap(document);
        const fixed = fix(schema, { providers: PROVIDER_IDS }).schema;

        const again = unwrap(rewrap(document, keys, fixed));
        expect(again.wrapper).toBe(wrapper);
        expect(again.schema).toEqual(fixed);
      });

      for (const selection of Object.keys(SELECTIONS) as Selection[]) {
        const providers: readonly ProviderId[] = SELECTIONS[selection];
        const expected = [...(REMAINING[name]?.[selection] ?? [])].sort();

        describe(`--provider ${selection}`, () => {
          const result = fix(unwrap(readExample(name)).schema, { providers });

          it("applies every fix the findings carry", () => {
            const fixable = result.findings.filter((finding) => finding.fix);
            expect(fixable.map((finding) => `${finding.ruleId} ${finding.path || "#"}`)).toEqual([]);
          });

          it("leaves only what no rule can rewrite", () => {
            expect(residue(result.findings)).toEqual(expected);
          });

          it("reports a provider as incompatible only where an error has no fix", () => {
            const incompatible = result.summary.filter((entry) => !entry.compatible).map((entry) => entry.provider);
            const blocked = providers.filter((id) => expected.some((entry) => entry.startsWith(`error ${id}/`)));
            expect(incompatible).toEqual([...blocked]);
          });

          it("settles: fixing the output again changes nothing", () => {
            const second = fix(result.schema, { providers });
            expect(second.applied).toEqual([]);
            expect(second.schema).toEqual(result.schema);
          });

          it("leaves every local reference resolvable", () => {
            expect(danglingRefs(result.schema)).toEqual([]);
          });
        });
      }
    });
  }
});
