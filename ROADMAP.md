# Roadmap

Each checkbox is one self-contained change: code, tests, docs, and a changelog entry. Items within a milestone are ordered; milestones can overlap. Anything marked **(needs evidence)** must not ship as an `error` rule until official documentation or a reproducible API response backs it up.

Want one of these sooner, or something that is not listed? [Open an issue](https://github.com/YasinzHyper/schemafit/issues/new/choose). Issues from users outrank this list.

## 0.2: Fixes, not just findings

- [x] Fix infrastructure: rules may attach a `fix` (a pure function from schema to schema); `lint` exposes which findings are fixable; `schemafit --fix --provider <id>` writes the rewritten schema to stdout or `--out`
- [x] Fix for `*/additional-properties-false`: add `additionalProperties: false`
- [x] Fix for `openai/all-required`: add missing keys to `required` and make them nullable (`type` array or `anyOf` with `null`)
- [ ] Make a property nullable that has no `type` to extend: the fix for `openai/all-required` requires a bare `enum` or `const` property without making it nullable, because there is no documented spelling for that. Depends on `openai/nullable-enum` **(needs evidence)**
- [x] Fix for `openai/no-one-of`: rewrite `oneOf` to `anyOf`
- [x] Fix for `anthropic/no-numeric-constraints`, `no-string-length`, `array-constraints`: drop the keyword and append the constraint to `description`, mirroring what Anthropic's SDKs do
- [x] Fix for `*/unsupported-format`: drop `format`, describe it in `description`
- [x] Fix for `openai/unsupported-composition`: merge simple `allOf` branches (objects without conflicting keys) into one schema
- [x] Merge an `allOf` branch that is a `$ref`, by inlining the definition it points at, when that definition is used nowhere else and does not refer back to itself
- [x] Inline a `$ref` branch whose definition is used more than once, as a copy that leaves the original under `$defs`, because the alternative is an `allOf` no fix can resolve
- [x] Prune a `$defs` entry left with no references at all once its uses have been inlined. Needs a fix that may rewrite more than the subschema its finding points at
- [x] Prune definitions the input already left unreferenced, behind a flag (`--fix --prune-unused-defs`), because removing one the author wrote and never referenced is a different decision from removing one a rewrite orphaned
- [x] Merge an `allOf` branch that describes something other than an object — a string with an `enum`, a number with a `minimum` — which is what Pydantic emits for an annotated enum field, by intersecting the types and enum values and keeping the tighter of two bounds
- [x] Fix for `openai/root-object`: wrap a non-object root in `{ "result": ... }` and report the wrapper key
- [x] `--fix --provider all`: produce the most portable schema (the intersection of all providers)
- [x] Round-trip test: every example under `examples/` is rewritten for every provider and for all of them at once, and what `--fix` leaves behind is recorded per example, so a rewrite that stops working or a fix that starts covering one shows up as a diff
- [x] Fix for `anthropic/allof-ref`: the merge attached to `openai/unsupported-composition` resolves exactly this `allOf` of a `$ref`, but the Anthropic rule carries no fix of its own, so `--fix --provider anthropic` leaves an error the tool can in fact rewrite. `examples/invoice-tool.json` is the case
- [x] `--fix --write`: rewrite several files in place, so `--fix` can run as a pre-commit hook

## 0.3: More ways in

- [x] Multiple schemas per file: accept an array of tools and a full request body (`tools: [...]`), report per tool
- [x] Request-level Anthropic limits across all tools in a file: 20 strict tools, 24 optional parameters, 16 union parameters
- [x] Only lint the schemas a document sends strictly; `--all-tools` overrides. A declaration that sets `"strict": false` is left out, because the subset these rules describe is the one a provider accepts under strict decoding. One that says nothing about `strict` is still linted: OpenAI's Responses API normalizes such a tool into strict mode when the schema allows it, so the subset is what decides between strict and best-effort there, and only an explicit `"strict": false` is an opt-out
- [x] MCP `tools/list` response as input (`{ "tools": [{ "inputSchema": ... }] }`), which is the `tools: [...]` request body with the MCP spelling of the schema key
- [x] The JSON-RPC envelope an MCP `tools/list` response arrives in (`{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [...] } }`), so a response captured straight off the wire can be linted without unwrapping it by hand first
- [x] Say what a JSON-RPC message that declares no schema is, instead of reporting it as a document that holds none: an error response names its `code` and `message`, a request or a notification names its `method`, so a captured call that failed reads as a failure rather than as an empty file
- [ ] A JSON-RPC batch, which the specification defines as "an Array filled with Request objects" and which a response arrives in the same way, so a captured batch holding a `tools/list` response is read as an array of bare schemas today and each envelope in it is linted as if it were one
- [ ] YAML input
- [ ] OpenAPI documents: lint `components.schemas.*` with `--openapi`
- [ ] Glob expansion on Windows shells, where the shell does not expand `*.json`
- [ ] Mark a schema the request sends non-strictly in the report header under `--all-tools`, so a finding against a tool that opted out of strict decoding reads as advisory rather than as something the provider would reject
- [ ] Report how many tools in a request body declared no schema and were skipped, so a file whose tools are all server tools says so rather than failing with "holds no schema to check"
- [ ] `$ref` resolution for `$id`/`$anchor`-based local references
- [ ] Draft-04/06 spellings: `id`, `definitions`, boolean `exclusiveMinimum`

## 0.4: Fits into your workflow

- [ ] Config file (`schemafit.config.json` or a `"schemafit"` key in `package.json`): providers, files, per-rule severity overrides, `off`
- [ ] Inline suppression with an `x-schemafit-ignore` keyword on a subschema
- [ ] `--format github`: GitHub Actions annotations (`::error file=...`)
- [ ] `--format sarif` for code scanning
- [ ] JSON source positions: report `file:line:column` for each finding, not only the JSON Pointer
- [ ] `--fix` a single schema of a document that holds several (`--only <pointer>`), which today is all or nothing
- [ ] Report the request-wide limits under `--fix` too, measured over the document as it comes out of the rewrite. Today only the lint path reports them, so a rewrite that pushes a request over the 24-parameter limit — making properties nullable adds union parameters — is not mentioned until the file is linted again
- [ ] Composite GitHub Action (`uses: YasinzHyper/schemafit@v0`) with a documented example workflow
- [ ] pre-commit hook definition (`.pre-commit-hooks.yaml`), on top of `--fix --write`
- [ ] `--fix --write` keeps the indentation of the file it rewrites instead of reformatting it with two spaces, so a repository that indents its schemas differently gets a diff of the fixes alone
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
- [ ] Fix for `gemini/undocumented-format`: the same rewrite as the other providers. Held back because the Gemini docs list their formats with "such as", so a format that is merely undocumented may work, and dropping it would give up a constraint for nothing **(needs evidence)**
- [ ] `anthropic/property-order`: informational note that required properties are emitted before optional ones
- [ ] `openai/ref-siblings`: keywords next to `$ref` **(needs evidence)**. Also blocks merging an `allOf` branch that carries a `$ref` beside other keywords, which the fix leaves alone today: the merged schema would put the reference next to those keywords, and the docs do not say whether that is read at all. The same unknown holds the `anthropic/allof-ref` inlining back from such a branch, where resolving the `$ref` and intersecting it with its siblings would be the fix
- [ ] Merge two `allOf` branches that both describe an array, by merging their `items` the way the object branches merge their `properties`. Today two different `items` are a conflict and the `allOf` is left alone
- [ ] `openai/root-ref`: root schema that is only a `$ref` **(needs evidence)**
- [ ] `openai/nullable-enum`: an enum on a nullable type must include `null` **(needs evidence)**. The docs' own optional-parameter example is `{ "type": ["string", "null"], "enum": ["F", "C"] }`, which argues the enum does *not* have to list `null`; checked 2026-09-19
- [ ] `gemini/nesting`: heuristic warning for "very large or deeply nested" schemas, with the threshold documented as a heuristic
- [ ] `*/unresolved-ref`: a local `$ref` that points nowhere, for every provider
- [ ] `openai/dependencies`: draft-07 `dependencies`, which `dependentSchemas` and `dependentRequired` replaced, is reported by no rule today, so a schema written against draft-07 gets no finding for it where a 2020-12 one does
- [ ] `*/unused-definition`: informational note naming a definition nothing references, so the rewrite `--fix --prune-unused-defs` performs has a finding behind it like every other fix
- [ ] `*/empty-object`: an object with `additionalProperties: false` and no properties can only ever be `{}`
- [ ] `*/missing-description`: opt-in style rule; descriptions measurably improve structured output quality
- [ ] Deduplicate findings that repeat per keyword on the same node into one finding listing all keywords
- [ ] Opt-in live verification script (`scripts/verify-live.mjs`) that sends tiny schemas to the real APIs using the contributor's own keys, to turn **(needs evidence)** items into facts. Never runs in CI

## Always

- Re-verify the rule with the oldest `verified` date against its `source`. Update the rule if the docs changed, otherwise bump the date.
- Keep `examples/` realistic: schemas generated by current Zod, Pydantic, and TypeBox versions.
