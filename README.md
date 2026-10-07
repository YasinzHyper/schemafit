# schemafit

**Will your JSON Schema survive OpenAI, Anthropic, and Gemini? Find out before the API tells you with a 400.**

[![CI](https://github.com/YasinzHyper/schemafit/actions/workflows/ci.yml/badge.svg)](https://github.com/YasinzHyper/schemafit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-blue.svg)

Structured outputs and strict tool calling promise JSON that always matches your schema. The catch: every provider accepts a *different subset* of JSON Schema, and the schema that Zod or Pydantic generates for you is usually in none of them.

- OpenAI rejects optional properties. Anthropic allows them, but only 24 per request.
- Anthropic rejects `minimum` and `maxLength`. OpenAI and Gemini accept `minimum`.
- OpenAI and Gemini handle recursive schemas. Anthropic rejects them.
- `"format": "uri"` works on Anthropic, fails on OpenAI.
- Gemini documents a small subset and makes no promise about the rest, so a constraint outside it can silently do nothing.

`schemafit` is a linter for exactly this. It checks a schema against each provider's documented rules, tells you where it breaks and how to fix it, and links every finding to the official docs.

```console
$ npx schemafit examples/ticket.json

examples/ticket.json

  OpenAI     ✖ 5 errors, 3 warnings
    error  #/properties/reporter  openai/all-required
           Properties missing from "required": website.
           fix: Add them to "required". To keep a field optional, make it nullable: "type": ["string", "null"].
    error  #/properties/reporter/properties/website  openai/unsupported-format
           String format "uri" is not one of the documented formats.
    ...
  Anthropic  ✖ 9 errors, 1 warning
    error  #/$defs/reply/properties/replies/items  anthropic/no-recursive-schemas
           "$ref": "#/$defs/reply" makes the schema recursive.
           fix: Unroll the recursion to a fixed depth, or flatten the tree into a list of nodes with parent ids.
    error  #/properties/priority  anthropic/no-numeric-constraints
           Numerical constraint "minimum" is not supported.
    ...
  Gemini     ⚠ compatible, 5 warnings
    warn   #/properties/title  gemini/undocumented-keyword
           "minLength" is outside the documented subset; it may be ignored or rejected.
    ...
```

## Install

```bash
npm install --save-dev schemafit
```

> **Not on npm yet.** Until the first release, run it straight from GitHub:
>
> ```bash
> npx github:YasinzHyper/schemafit schema.json
> ```

Requires Node.js 20 or newer. No runtime dependencies.

## Usage

```bash
# Check against every provider
schemafit schema.json

# Only the providers you ship to
schemafit --provider openai,anthropic schema.json

# Several files, machine-readable output
schemafit --format json tools/*.json

# A whole request body: every tool in it is reported on its own
schemafit examples/messages-request.json

# From stdin
cat schema.json | schemafit -

# List the rules (rules --fix can rewrite are marked [--fix])
schemafit rules --provider anthropic

# Rewrite a schema so every provider accepts it
schemafit --fix tool.json --out tool.portable.json

# ... or for one provider, keeping what the others do not support
schemafit --fix --provider openai tool.json --out tool.openai.json

# ... and drop the definitions nothing references while you are at it
schemafit --fix --provider openai --prune-unused-defs tool.json

# Rewrite a whole directory of schemas in place
schemafit --fix --write tools/*.json
```

Files can hold a bare JSON Schema or a whole tool / response-format definition. `schemafit` finds the schema inside OpenAI tools (`function.parameters`), OpenAI `response_format`, Anthropic tools (`input_schema`), and MCP tools (`inputSchema`).

They can also hold **several** schemas, and then every one of them is reported, fixed, and named on its own: a whole request body (`tools: [...]`, including the nested `tools` of an [OpenAI namespace](https://developers.openai.com/api/docs/guides/function-calling#defining-namespaces), plus the slot that asks for structured output — `response_format` in OpenAI's and Gemini's spellings, the Responses API's `text.format`, and Anthropic's `output_config.format`), an MCP `tools/list` response, or a bare array of tool definitions. A tool that declares no schema — a server tool such as Anthropic's `web_search`, or an OpenAI built-in — is skipped rather than mistaken for a schema.

```console
$ schemafit examples/messages-request.json

examples/messages-request.json#/tools/1/input_schema  create_ticket  (Anthropic tool (input_schema))

  OpenAI     ✖ 2 errors
    error  #  openai/all-required
           Properties missing from "required": assignee.
           fix: Add them to "required". To keep a field optional, make it nullable: "type": ["string", "null"].
    ...

examples/messages-request.json#/tools/2/input_schema  search_tickets  (Anthropic tool (input_schema))

  OpenAI     ✔ compatible
  ...
```

Some limits are stated per request rather than per schema, and those are measured over the request as a whole: Anthropic allows **20 tools with `strict: true`, 24 optional parameters, and 16 parameters with union types** in one request, counting every schema it sends strictly together. Four strict tools with six optional parameters each reach the limit of 24 though no single tool looks complex, which is exactly the case [the docs warn about](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits), so the finding is reported after the reports on the schemas and names what each one contributed:

```console
$ schemafit --provider anthropic request.json
...
request.json  (the request as a whole)

  Anthropic  ✖ 1 error
    error  #  anthropic/optional-parameters-limit
           The request's 4 strict schemas have 28 optional parameters; the request-wide limit is 24 (tool_0 7, tool_1 7, tool_2 7, tool_3 7).
           fix: List more properties in "required". Each optional parameter roughly doubles part of the compiled grammar.
```

A tool that sets `"strict": false` is left out of those totals, and only the tools that carry `"strict": true` count toward the limit of 20, because the documentation says non-strict tools do not count. A file that holds one schema is measured as a request that holds one.

`--fix` rewrites every schema the document holds and puts each one back where it came from, so a fixed request body keeps its model, its messages, and the tools it had nothing to change in.

| Option | |
| --- | --- |
| `-p, --provider <ids>` | `openai`, `anthropic`, `gemini`. Comma-separated or repeated. Default: all |
| `-f, --format <name>` | `pretty` (default) or `json` |
| `-q, --quiet` | Report errors only |
| `--max-warnings <n>` | Exit 1 when more than `n` warnings are found |
| `--fix` | Rewrite the schema and write it out, for every selected provider at once |
| `--prune-unused-defs` | With `--fix`, also remove the definitions the input left unreferenced |
| `-o, --out <file>` | With `--fix`, write there instead of stdout |
| `-w, --write` | With `--fix`, rewrite each file in place. Takes several files |
| `--all-tools` | Check every schema a document declares, including the ones it sends non-strictly |

Exit codes: `0` compatible, `1` errors found, `2` bad usage or unreadable input. That makes it a one-line CI step:

```yaml
- run: npx schemafit --provider openai,anthropic schemas/*.json
```

### Only the schemas you send strictly

These rules describe the subset a provider accepts **under strict decoding**, and a declaration that sets `"strict": false` opts out of it. OpenAI documents such a tool as ["non-strict, best-effort function calling"](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) and rejects a schema only "if you send `strict: true` and your schema does not meet the requirements"; Anthropic's limitations are the ones ["JSON outputs and strict tool use share"](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations), and a non-strict tool's `input_schema` is never compiled into a grammar. So reporting the subset against a schema the request does not send strictly is a false positive, and `schemafit` leaves it out:

```console
$ schemafit examples/chat-request.json
schemafit: examples/chat-request.json: skipped log_event — "strict": false, so the strict subset does not apply. Use --all-tools to check them too.

examples/chat-request.json#/tools/0/function/parameters  create_ticket  (OpenAI Chat Completions tool (function.parameters))

  OpenAI     ✖ 2 errors
  ...
```

Pass `--all-tools` to check them anyway — useful when you are about to turn strictness on. `--fix` honours the same split: the `minLength` on the audit log's `message` survives a rewrite that would otherwise move it into `description`, because nothing asked for it to go.

A declaration that says nothing about `strict` *is* checked. Omitting it is not opting out: a Responses request "will attempt to normalize your schema into strict mode when possible, and will fall back to non-strict, best-effort function calling if the schema cannot be made compatible", so whether the subset is met is what decides which of the two you get. Chat Completions stays non-strict by default, and the findings are what you need before you set `"strict": true` there.

### Fixing a schema

Some findings have one obvious answer, and `--fix` applies it for you:

```console
$ schemafit --fix --provider openai examples/ticket.json --out ticket.openai.json

ticket.openai.json

  fixed  #/properties/reporter/properties/website  openai/unsupported-format
         Remove "format": "uri" and state it in "description".
  fixed  #/properties/reporter  openai/all-required
         Add website to "required", and "null" to the type of website.
  fixed  #/properties/reporter  openai/additional-properties-false
         Set "additionalProperties": false.
  fixed  #  openai/all-required
         Add category, reporter, tags, replies to "required", and "null" to the type of reporter, tags, replies.
  fixed  #  openai/additional-properties-false
         Set "additionalProperties": false.

  OpenAI  ⚠ compatible, 3 warnings
  No automatic rewrite for these; the hint says what to change.
    warn   #/properties/title  openai/undocumented-keyword
           "minLength" is not documented as supported and may be rejected.
           fix: Remove "minLength" and state the constraint in "description".
    ...
```

- One file at a time unless you pass `--write`, and as many providers as you select. With no `--provider`, `--fix` rewrites for all of them at once and you get the most portable schema the rules can reach — the one every provider accepts. That costs the constraints only some of them support: a `minimum` OpenAI would have kept goes, because Anthropic does not take it. Name the providers you actually ship to and `--fix` keeps everything the rest of them would have rejected.
- OpenAI supports no `allOf` at all, so for OpenAI an `allOf` is merged into the schema that holds it, the way you would merge it by hand. Object branches contribute their properties, required keys, and descriptions; a branch that describes something else — a string with an `enum`, a number with a `minimum` — contributes its own constraint, narrowed to what every branch agrees on: the types and enum values they have in common, the larger of two lower bounds, the smaller of two upper bounds. A branch that is nothing but a local `$ref` — the `{ "allOf": [{ "$ref": "#/$defs/User" }], "description": "..." }` Pydantic emits for an annotated model field — is inlined first, as long as the definition it names does not refer back to itself. A definition the rest of the schema also references is copied rather than moved — the original stays under `$defs`, where the references the fix does not touch still find it, and the report says which definition was copied — because the alternative is an `allOf` the API rejects, and the extra copy only costs size, which the property and string-size limits still measure. Once nothing references a definition any more, the fix removes it, along with the `$defs` map it empties: an orphan still costs against those limits, which count definition names and every property below them. Branches that constrain the same thing differently are left alone, as are branches with no type or enum value in common, a branch carrying a `$ref` beside other keywords, and the composition keywords whose meaning cannot survive a rewrite (`not`, `if`/`then`/`else`).
- Anthropic does take an `allOf`; what it does not take is a `$ref` inside one. So `--fix --provider anthropic` keeps the keyword and only puts the definition in the branch's place — copied when the rest of the schema still references it, and removed once nothing does, the same way the merge handles a definition. Select both providers and both rewrites run on the same schema: the `$ref` is inlined, then the `allOf` itself goes, because OpenAI accepts neither half.
- A root that OpenAI will not take — a union, an array, a primitive, which is what a Zod discriminated union or `z.array()` compiles to — is wrapped in an object with one required property, `result`, and the report names that key. The model then answers `{ "result": ... }`, so unwrap it on the way out. Definitions stay at the root, where `#/$defs/...` references still find them.
- A fix never quietly drops a constraint. Anthropic does not support `minimum`, `maxLength`, `uniqueItems` and their kind, and neither provider accepts every string `format`, so `--fix` removes the keyword and writes what it required into `description` — `"format": "uri"` becomes "Must be an absolute URI, such as https://example.com/a." That is the same transformation the Anthropic SDKs apply. The constraint then holds only as far as the model honours it, so keep validating the response against your original schema.
- `--prune-unused-defs` widens that last step to the whole document: every `$defs` / `definitions` entry no `$ref` reaches goes, not only the ones `--fix` orphaned itself, and so does anything only those entries referenced. It is off by default because it is a different decision — a definition the author wrote and never used changes nothing about what the schema accepts, and another document may `$ref` into it — but a generator that emits one `$defs` map for a whole module leaves plenty of them, and each one spends property and string-size budget for nothing. Nothing is pruned from a schema whose references cannot all be followed: an anchor (`"$ref": "#user"`), a `$dynamicRef`, a URL, or a nested `$id` would make a definition that *is* referenced look unused. Every `$ref`, `$dynamicRef`, and `$recursiveRef` in the document counts, wherever it sits — a draft-07 `dependencies`, a `contentSchema` — so a reference outside the keywords the linter otherwise walks stops pruning rather than going unnoticed.
- `--write` rewrites the files you give it in place, which is what makes `--fix` usable over a directory of schemas or from a pre-commit hook: `schemafit --fix --write tools/*.json`. Every file is read and rewritten before any of them is written out, so a file that is unreadable or not JSON fails the run instead of leaving half of it rewritten. A file no fix changed is not written at all — its formatting and its mtime stay as they were — and the ones that were come back with two-space indentation. The report still goes to stderr, and ends with a line counting the files that changed.
- The rewritten document goes to stdout (or `--out`), and the report goes to stderr, so `schemafit --fix -p openai tool.json | jq .` works. The report ends with one line per selected provider, saying whether the rewritten schema fits it and what is left to change by hand.
- The wrapper is preserved. Fix an Anthropic tool definition and you get the tool definition back, with its `name` and `description` intact.
- Findings with no automatic rewrite are left alone and listed. The exit code still reflects them.

`schemafit rules` marks the rules that `--fix` can resolve; [docs/rules.md](docs/rules.md) lists them as **Fixable**.

The schemas under [`examples/`](examples/) are there to be run: `ticket.json` is the one above, `invoice-tool.json` an OpenAI tool whose schema reuses definitions, `anthropic-tool.json` an Anthropic tool, and `ticket.portable.json` the hand-written version that already fits everywhere. A test rewrites each of them for every provider and records exactly what is left over, so the list of things `--fix` cannot do stays honest.

### Generating the JSON from Zod or Pydantic

```ts
// Zod 4
import { z } from "zod";
console.log(JSON.stringify(z.toJSONSchema(MySchema)));
```

```python
# Pydantic 2
import json
print(json.dumps(MyModel.model_json_schema()))
```

Pipe either into `schemafit -`.

## What differs between providers

The short version of [the full rule list](docs/rules.md):

| | OpenAI (strict) | Anthropic | Gemini |
| --- | --- | --- | --- |
| Root must be an object, no root `anyOf` | required | | |
| Optional properties | ✖ all must be `required` | ✔ max 24 across the request | ✔ |
| `additionalProperties: false` | required | required | optional |
| Recursive schemas | ✔ | ✖ | ✔ |
| `minimum` / `maximum` | ✔ | ✖ | ✔ |
| `minLength` / `maxLength` | undocumented | ✖ | undocumented |
| `maxItems` | ✔ | ✖ (`minItems` 0 or 1 only) | ✔ |
| `pattern` | ✔ | ✔ no lookarounds, backreferences, `\b` | undocumented |
| `allOf` | ✖ | ✔ but not with `$ref` | undocumented |
| `oneOf` | ✖ use `anyOf` | | undocumented |
| `format: "uri"` | ✖ | ✔ | undocumented |
| Size limits | 5000 properties, 10 levels, 1000 enum values | per request: 20 strict tools, 24 optional and 16 union parameters | "very large" schemas rejected |

### Errors and warnings

- **error**: the provider's documentation says the construct is unsupported. The API will reject the schema.
- **warn**: undocumented, ambiguous, or accepted-but-risky. The schema may work, may silently lose the constraint, or may be rejected.

Warnings never affect the exit code unless you pass `--max-warnings`.

### How the rules stay honest

Provider rules change, and a linter that is wrong is worse than no linter. So every rule in `schemafit`:

1. cites the official documentation it was derived from (`source`),
2. records the date it was last checked against that page (`verified`),
3. is an **error** only when the docs say so explicitly; everything else is a warning that says why.

[docs/rules.md](docs/rules.md) is generated from that metadata. If you find a rule that no longer matches reality, [open an issue](https://github.com/YasinzHyper/schemafit/issues/new/choose); that is the most valuable bug report this project can get.

## Library

```ts
import { lint } from "schemafit";

const { findings, summary } = lint(schema, { providers: ["openai", "anthropic"] });

for (const { provider, compatible, errors } of summary) {
  console.log(provider, compatible ? "ok" : `${errors} errors`);
}
```

Each finding has `ruleId`, `provider`, `severity`, `path` (a JSON Pointer), `message`, `hint`, and `source`. Use it in a unit test to keep your schemas portable:

```ts
expect(lint(schema, { providers: ["openai"] }).findings).toEqual([]);
```

`fix` is the same thing the CLI's `--fix` runs. It never mutates its input:

```ts
import { fix } from "schemafit";

const { schema: fixed, applied, findings } = fix(schema, { providers: ["openai"] });

console.log(applied.map((item) => `${item.path}: ${item.title}`));
console.log(`${findings.length} findings left to fix by hand`);
```

List several providers to get the schema all of them accept, the same thing `--fix` does with no `--provider`. Pass `pruneUnusedDefs: true` for what `--prune-unused-defs` does. The `applied` entry for a definition removed that way carries no `ruleId`, because no finding asked for it.

A finding that can be fixed carries a `fix` with a `title` and a pure `rewrite(subschema)`, so you can apply fixes selectively instead of all at once.

`unwrapAll` is how the CLI finds the schemas in a document, and `rewrap` puts a rewritten one back:

```ts
import { fix, rewrap, unwrapAll } from "schemafit";

let body = JSON.parse(await readFile("request.json", "utf8"));
for (const { schema, keys, name } of unwrapAll(body)) {
  const { schema: fixed } = fix(schema, { providers: ["openai"] });
  console.log(name ?? "(bare schema)");
  body = rewrap(body, keys, fixed);
}
```

Each entry also carries `pointer`, the JSON Pointer from the document to the schema, `wrapper`, the wrapper it was found in, `kind` (`"tool"` or `"format"`), and `strict`, what the declaration says about strict decoding. `unwrap` is still there for a document that holds exactly one schema.

`lintRequest` checks what a provider limits per request rather than per schema, over every schema the document sends strictly:

```ts
import { lintRequest, lintSchema, unwrapAll } from "schemafit";

const body = JSON.parse(await readFile("request.json", "utf8"));
for (const { schema } of unwrapAll(body)) lintSchema(schema, { providers: ["anthropic"] });
const { findings } = lintRequest(body, { providers: ["anthropic"] });
```

Each of those findings has a `path` that points from the document, and `""` means the request as a whole. `lintSchema` is `lint` without them, which is what keeps a request body from being reported twice; `lint` on its own is both, measuring a request that holds one schema.

## Roadmap

More fixes (`--fix` currently rewrites `additionalProperties`, `required`, `oneOf`, `allOf`, a root OpenAI will not take, unsupported string formats, and Anthropic's unsupported numeric, string, and array constraints), more providers (Mistral, Bedrock, Ollama, vLLM), YAML and OpenAPI input, SARIF output, and a GitHub Action. See [ROADMAP.md](ROADMAP.md).

## Contributing

New rules and corrections to existing ones are very welcome; a rule is about 20 lines plus a test. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
