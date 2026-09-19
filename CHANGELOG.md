# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Fix infrastructure: a rule may attach a `fix` to a finding, a pure rewrite of the subschema the finding points at. `Finding.fix` carries its `title` and `rewrite`, and `RuleMeta.fixable` marks the rules that always attach one.
- `fix(schema, { providers })`: applies every available fix, re-linting until the schema settles, and returns the rewritten schema, the fixes applied, and the findings that remain. The input schema is never mutated.
- `schemafit --fix --provider <id> <file>`: writes the rewritten schema to stdout or `--out <file>`, and reports what changed on stderr. The schema is put back into the tool or `response_format` wrapper it came from, so a fixed tool definition keeps its other fields.
- `unwrap` now also returns `keys`, the path from the document to the schema, and `rewrap` puts a rewritten schema back there.
- A fix for `openai/additional-properties-false` and `anthropic/additional-properties-false`: set `additionalProperties: false` on every object that does not.
- A fix for `openai/all-required`: adds every property missing from `required` and makes it accept `null`, which is how the OpenAI docs keep a field optional under strict mode. A `type` gains `"null"`, an `anyOf` gains a `{ "type": "null" }` branch, and a `$ref` is wrapped in one. A property with no `type` to extend (a bare `enum` or `const`) is required as it is, and the reported fix title says which properties were made nullable.
- A fix for `openai/no-one-of`: renames `oneOf` to `anyOf`, keeping the branches and the position of the keyword. The rename widens the union from exactly one matching branch to at least one, which the rule's notes spell out. A schema that already has an `anyOf` of its own is reported without a fix, because the two cannot be merged without changing what the schema accepts.
- `schemafit rules` marks fixable rules with `[--fix]`, and `docs/rules.md` records them as fixable.

## 0.1.0 - 2026-09-17

### Added

- `lint(schema, { providers })` library API and the `schemafit` CLI (`pretty` and `json` output, stdin, `--quiet`, `--max-warnings`, `rules` subcommand).
- OpenAI Structured Outputs rules: root object, all fields required, `additionalProperties: false`, unsupported composition keywords, `oneOf`, string formats, undocumented keywords, nesting depth, and the property, enum, and string-size limits.
- Anthropic structured outputs rules: `additionalProperties: false`, recursion, external `$ref`, enum value types, numeric, string, and array constraints, string formats, `allOf` with `$ref`, regex features, optional- and union-parameter limits, and enum casing.
- Gemini structured output rules: keywords and string formats outside the documented subset.
- Automatic unwrapping of OpenAI tool and `response_format` definitions, Anthropic tools, and MCP tools.
- `docs/rules.md`, generated from rule metadata, with the documentation source and verification date of every rule.
