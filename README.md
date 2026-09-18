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

# From stdin
cat schema.json | schemafit -

# List the rules (rules --fix can rewrite are marked [--fix])
schemafit rules --provider anthropic

# Rewrite a schema for one provider
schemafit --fix --provider openai tool.json --out tool.openai.json
```

Files can hold a bare JSON Schema or a whole tool / response-format definition. `schemafit` finds the schema inside OpenAI tools (`function.parameters`), OpenAI `response_format`, Anthropic tools (`input_schema`), and MCP tools (`inputSchema`).

| Option | |
| --- | --- |
| `-p, --provider <ids>` | `openai`, `anthropic`, `gemini`. Comma-separated or repeated. Default: all |
| `-f, --format <name>` | `pretty` (default) or `json` |
| `-q, --quiet` | Report errors only |
| `--max-warnings <n>` | Exit 1 when more than `n` warnings are found |
| `--fix` | Rewrite the schema and write it out. One file, one provider |
| `-o, --out <file>` | With `--fix`, write there instead of stdout |

Exit codes: `0` compatible, `1` errors found, `2` bad usage or unreadable input. That makes it a one-line CI step:

```yaml
- run: npx schemafit --provider openai,anthropic schemas/*.json
```

### Fixing a schema

Some findings have one obvious answer, and `--fix` applies it for you:

```console
$ schemafit --fix --provider openai examples/ticket.json --out ticket.openai.json

ticket.openai.json

  fixed  #/properties/reporter  openai/all-required
         Add website to "required", and "null" to the type of website.
  fixed  #/properties/reporter  openai/additional-properties-false
         Set "additionalProperties": false.
  fixed  #  openai/all-required
         Add category, reporter, tags, replies to "required", and "null" to the type of reporter, tags, replies.
  fixed  #  openai/additional-properties-false
         Set "additionalProperties": false.

  OpenAI  ✖ 1 error, 3 warnings
  No automatic rewrite for these; the hint says what to change.
    error  #/properties/reporter/properties/website  openai/unsupported-format
           String format "uri" is not one of the documented formats.
    ...
```

- One file and one provider at a time: providers disagree about what a schema should look like, so there is no single "fixed" schema.
- The rewritten document goes to stdout (or `--out`), and the report goes to stderr, so `schemafit --fix -p openai tool.json | jq .` works.
- The wrapper is preserved. Fix an Anthropic tool definition and you get the tool definition back, with its `name` and `description` intact.
- Findings with no automatic rewrite are left alone and listed. The exit code still reflects them.

`schemafit rules` marks the rules that `--fix` can resolve; [docs/rules.md](docs/rules.md) lists them as **Fixable**.

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
| Optional properties | ✖ all must be `required` | ✔ max 24 per request | ✔ |
| `additionalProperties: false` | required | required | optional |
| Recursive schemas | ✔ | ✖ | ✔ |
| `minimum` / `maximum` | ✔ | ✖ | ✔ |
| `minLength` / `maxLength` | undocumented | ✖ | undocumented |
| `maxItems` | ✔ | ✖ (`minItems` 0 or 1 only) | ✔ |
| `pattern` | ✔ | ✔ no lookarounds, backreferences, `\b` | undocumented |
| `allOf` | ✖ | ✔ but not with `$ref` | undocumented |
| `oneOf` | ✖ use `anyOf` | | undocumented |
| `format: "uri"` | ✖ | ✔ | undocumented |
| Size limits | 5000 properties, 10 levels, 1000 enum values | 24 optional and 16 union parameters | "very large" schemas rejected |

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

A finding that can be fixed carries a `fix` with a `title` and a pure `rewrite(subschema)`, so you can apply fixes selectively instead of all at once.

## Roadmap

More fixes (`--fix` currently rewrites `additionalProperties` and `required`), more providers (Mistral, Bedrock, Ollama, vLLM), request-level checks across several tools, SARIF output, and a GitHub Action. See [ROADMAP.md](ROADMAP.md).

## Contributing

New rules and corrections to existing ones are very welcome; a rule is about 20 lines plus a test. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
