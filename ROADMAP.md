# Roadmap

Each checkbox is one self-contained change: code, tests, docs, and a changelog entry. Items within a milestone are ordered; milestones can overlap. Anything marked **(needs evidence)** must not ship as an `error` rule until official documentation or a reproducible API response backs it up.

Want one of these sooner, or something that is not listed? [Open an issue](https://github.com/YasinzHyper/schemafit/issues/new/choose). Issues from users outrank this list.

## 0.2: Fixes, not just findings

- [x] Fix infrastructure: rules may attach a `fix` (a pure function from schema to schema); `lint` exposes which findings are fixable; `schemafit --fix --provider <id>` writes the rewritten schema to stdout or `--out`
- [x] Fix for `*/additional-properties-false`: add `additionalProperties: false`
- [x] Fix for `openai/all-required`: add missing keys to `required` and make them nullable (`type` array or `anyOf` with `null`)
- [ ] Make a property nullable that has no `type` to extend: the fix for `openai/all-required` requires a bare `enum` or `const` property without making it nullable, because there is no documented spelling for that. Depends on `openai/nullable-enum` **(needs evidence)**
- [x] Fix for `openai/no-one-of`: rewrite `oneOf` to `anyOf`
- [ ] Fix for `anthropic/no-numeric-constraints`, `no-string-length`, `array-constraints`: drop the keyword and append the constraint to `description`, mirroring what Anthropic's SDKs do
- [ ] Fix for `*/unsupported-format`: drop `format`, describe it in `description`
- [ ] Fix for `openai/unsupported-composition`: merge simple `allOf` branches (objects without conflicting keys) into one schema
- [ ] Fix for `openai/root-object`: wrap a non-object root in `{ "result": ... }` and report the wrapper key
- [ ] `--fix --provider all`: produce the most portable schema (the intersection of all providers)
- [ ] Round-trip test: every example under `examples/` lints clean after `--fix`
- [ ] `--fix --write`: rewrite several files in place, so `--fix` can run as a pre-commit hook. Today `--fix` takes one file and writes to stdout or `--out`

## 0.3: More ways in

- [ ] Multiple schemas per file: accept an array of tools and a full request body (`tools: [...]`), report per tool
- [ ] Request-level Anthropic limits across all tools in a file: 20 strict tools, 24 optional parameters, 16 union parameters
- [ ] Only lint tools that opt into strictness (`strict: true`) when the file is a request body; `--all-tools` overrides
- [ ] MCP `tools/list` response as input (`{ "tools": [{ "inputSchema": ... }] }`)
- [ ] YAML input
- [ ] OpenAPI documents: lint `components.schemas.*` with `--openapi`
- [ ] Glob expansion on Windows shells, where the shell does not expand `*.json`
- [ ] `$ref` resolution for `$id`/`$anchor`-based local references
- [ ] Draft-04/06 spellings: `id`, `definitions`, boolean `exclusiveMinimum`

## 0.4: Fits into your workflow

- [ ] Config file (`schemafit.config.json` or a `"schemafit"` key in `package.json`): providers, files, per-rule severity overrides, `off`
- [ ] Inline suppression with an `x-schemafit-ignore` keyword on a subschema
- [ ] `--format github`: GitHub Actions annotations (`::error file=...`)
- [ ] `--format sarif` for code scanning
- [ ] JSON source positions: report `file:line:column` for each finding, not only the JSON Pointer
- [ ] Composite GitHub Action (`uses: YasinzHyper/schemafit@v0`) with a documented example workflow
- [ ] pre-commit hook definition (`.pre-commit-hooks.yaml`)
- [ ] `schemafit explain <rule-id>`: print the rule's summary, notes, source, and a before/after example
- [ ] Vitest/Jest matcher: `expect(schema).toFitProvider("openai")`
- [ ] Publish to npm with provenance from a release workflow

## 0.5: More providers

Each provider lands with its documentation source, a verification date, and tests. Providers whose docs do not describe their schema subset get `warn` rules only.

- [ ] `openai-ft`: the stricter keyword set OpenAI documents for fine-tuned models
- [ ] Gemini function calling (`parameters`), which documents a different subset than structured output
- [ ] Azure OpenAI (differences from OpenAI, if any are documented)
- [ ] Amazon Bedrock Converse tool use
- [ ] Mistral
- [ ] xAI
- [ ] Cohere
- [ ] Groq
- [ ] Fireworks / Together (JSON mode with schema)
- [ ] Ollama (`format` with a JSON Schema) **(needs evidence)**
- [ ] llama.cpp JSON-Schema-to-GBNF converter limits
- [ ] vLLM / xgrammar / Outlines guided decoding limits
- [ ] `--provider` aliases and groups: `all`, `hosted`, `local`

## 0.6: The compatibility matrix

- [ ] Machine-readable feature table (`data/features.json`): keyword x provider -> supported / unsupported / undocumented, generated from the rules
- [ ] Generated `docs/matrix.md`, a "caniuse" for structured-output JSON Schema, linked from the README
- [ ] Static playground on GitHub Pages: paste a schema, see findings for every provider, runs fully in the browser
- [ ] Shareable playground links (schema encoded in the URL fragment)
- [ ] Per-rule documentation pages with a failing and a passing example each

## Rule backlog

Refinements to the existing providers. Small, and good first contributions.

- [ ] `anthropic/regex-quantifier-range`: warn on large `{n,m}` ranges, which the docs call out as unsupported without giving a threshold
- [ ] Anthropic: `oneOf`, `not`, `if`/`then`/`else`, `patternProperties`, `prefixItems` are neither listed as supported nor as unsupported **(needs evidence)**
- [ ] Fix for the `oneOf` finding inside `gemini/undocumented-keyword`: the same rename to `anyOf`, which the Gemini docs demonstrate. Needs a way to mark a rule as fixable for only some of its keywords
- [ ] `anthropic/property-order`: informational note that required properties are emitted before optional ones
- [ ] `openai/ref-siblings`: keywords next to `$ref` **(needs evidence)**
- [ ] `openai/root-ref`: root schema that is only a `$ref` **(needs evidence)**
- [ ] `openai/nullable-enum`: an enum on a nullable type must include `null` **(needs evidence)**
- [ ] `gemini/nesting`: heuristic warning for "very large or deeply nested" schemas, with the threshold documented as a heuristic
- [ ] `*/unresolved-ref`: a local `$ref` that points nowhere, for every provider
- [ ] `*/empty-object`: an object with `additionalProperties: false` and no properties can only ever be `{}`
- [ ] `*/missing-description`: opt-in style rule; descriptions measurably improve structured output quality
- [ ] Deduplicate findings that repeat per keyword on the same node into one finding listing all keywords
- [ ] Opt-in live verification script (`scripts/verify-live.mjs`) that sends tiny schemas to the real APIs using the contributor's own keys, to turn **(needs evidence)** items into facts. Never runs in CI

## Always

- Re-verify the rule with the oldest `verified` date against its `source`. Update the rule if the docs changed, otherwise bump the date.
- Keep `examples/` realistic: schemas generated by current Zod, Pydantic, and TypeBox versions.
