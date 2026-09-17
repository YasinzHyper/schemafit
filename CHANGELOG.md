# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0 - 2026-09-17

### Added

- `lint(schema, { providers })` library API and the `schemafit` CLI (`pretty` and `json` output, stdin, `--quiet`, `--max-warnings`, `rules` subcommand).
- OpenAI Structured Outputs rules: root object, all fields required, `additionalProperties: false`, unsupported composition keywords, `oneOf`, string formats, undocumented keywords, nesting depth, and the property, enum, and string-size limits.
- Anthropic structured outputs rules: `additionalProperties: false`, recursion, external `$ref`, enum value types, numeric, string, and array constraints, string formats, `allOf` with `$ref`, regex features, optional- and union-parameter limits, and enum casing.
- Gemini structured output rules: keywords and string formats outside the documented subset.
- Automatic unwrapping of OpenAI tool and `response_format` definitions, Anthropic tools, and MCP tools.
- `docs/rules.md`, generated from rule metadata, with the documentation source and verification date of every rule.
