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
- A fix for `anthropic/no-numeric-constraints`, `anthropic/no-string-length`, and `anthropic/array-constraints`: the unsupported keyword is removed and what it required is stated in `description` ("Must be at least 100."), which is the transformation the Anthropic SDKs apply. `minItems` is lowered to 1 rather than removed, because 0 and 1 are supported. A keyword whose value cannot be put into words, such as a draft-04 boolean `exclusiveMinimum`, is still reported but carries no fix, and a `uniqueItems: false` is dropped without a note.
- A fix for `openai/unsupported-format` and `anthropic/unsupported-format`: the unsupported `format` is removed and what it required is stated in `description`, so `"format": "uri"` becomes "Must be an absolute URI, such as https://example.com/a." Every format the JSON Schema format vocabulary defines has its own wording; anything else, such as a generator's `int64`, is named as it stands ("Must be a string in the \"int64\" format."). `gemini/undocumented-format` deliberately carries no fix, because the Gemini docs list their formats with "such as" and a format that is only undocumented may well work. With this, `examples/ticket.json` comes out of `--fix --provider openai` compatible rather than with one error left.
- A fix for `openai/unsupported-composition`: an `allOf` whose branches are plain objects is merged into the object that holds it, with the properties of every branch on one object, the union of their `required` keys, and their descriptions joined. Merging widens an `additionalProperties: false` declared in a branch, which then no longer rejects the properties of its siblings, and a single strict object has to accept those anyway. Branches that constrain the same key differently carry no fix, and neither do `not`, `if`/`then`/`else`, `dependentRequired`, and `dependentSchemas`, because dropping them would change what the schema accepts.
- A fix for `openai/root-object`: a root OpenAI will not take — a union, an array, a primitive — is wrapped in an object with one required property, `result`, and the fix title names that key, because the model then answers `{ "result": ... }` instead of the bare value. `$defs` and `definitions` stay at the root, so `#/$defs/...` references keep resolving, and everything the root said about the value it accepts moves inside the wrapper. A root that carries nothing but definitions has nothing to wrap and is reported without a fix.
- `schemafit rules` marks fixable rules with `[--fix]`, and `docs/rules.md` records them as fixable.

### Changed

- Every Anthropic rule was re-checked against the structured outputs documentation and now records `2026-09-20` as its verification date. The documented limits, formats, and unsupported keywords are unchanged.
- Every OpenAI rule was re-checked against the Structured Outputs documentation and now records `2026-09-22` as its verification date. The supported types, string formats, per-type keywords, unsupported composition keywords, and the nesting, property, enum, and string-size limits are unchanged.

## 0.1.0 - 2026-09-17

### Added

- `lint(schema, { providers })` library API and the `schemafit` CLI (`pretty` and `json` output, stdin, `--quiet`, `--max-warnings`, `rules` subcommand).
- OpenAI Structured Outputs rules: root object, all fields required, `additionalProperties: false`, unsupported composition keywords, `oneOf`, string formats, undocumented keywords, nesting depth, and the property, enum, and string-size limits.
- Anthropic structured outputs rules: `additionalProperties: false`, recursion, external `$ref`, enum value types, numeric, string, and array constraints, string formats, `allOf` with `$ref`, regex features, optional- and union-parameter limits, and enum casing.
- Gemini structured output rules: keywords and string formats outside the documented subset.
- Automatic unwrapping of OpenAI tool and `response_format` definitions, Anthropic tools, and MCP tools.
- `docs/rules.md`, generated from rule metadata, with the documentation source and verification date of every rule.
