# schemafit

A linter that checks JSON Schemas against the structured-output rules of LLM providers. TypeScript, ESM, Node 20+, zero runtime dependencies.

## Commands

```bash
npm ci               # install (also builds, via prepare)
npm run check        # typecheck + tests + docs/rules.md freshness. Must pass before every commit
npm run docs         # regenerate docs/rules.md after touching any rule metadata
npm test -- -t name  # run a single test
node dist/bin.js examples/ticket.json   # try the CLI after `npm run build`
```

## Layout

- `src/types.ts`: `Rule`, `Finding`, `Provider`. Start here.
- `src/walk.ts`: schema traversal. `walk()` yields every subschema with its JSON Pointer; rules iterate `ctx.nodes` and never recurse themselves.
- `src/refs.ts`: local `$ref` resolution and cycle detection.
- `src/providers/<id>.ts`: one file per provider, holding its rules. `shared.ts` has rule factories used by more than one provider.
- `src/lint.ts`, `src/unwrap.ts`, `src/cli.ts`, `src/format/`: the engine, tool-definition unwrapping, CLI, and output.
- `tests/<provider>.test.ts`: one positive and one negative case per rule, built with `strictObject()` from `tests/helpers.ts` so each test isolates one rule.
- `docs/rules.md`: generated. Never edit by hand.

## The accuracy contract

This tool is only worth using if its claims are true. Non-negotiable:

1. Every rule cites official provider documentation in `source` and the date it was checked in `verified`.
2. Before adding or changing a rule, fetch the documentation page and read the relevant section. Do not rely on memory; provider rules change often. Most doc sites serve raw markdown when `.md` is appended to the URL.
3. `error` only when the docs state the construct is unsupported or rejected. Undocumented, ambiguous, or inferred behavior is `warn`, and `notes` says why.
4. Numeric limits are named constants quoted from the docs, never guessed.
5. If the docs contradict an existing rule, fixing the rule outranks all other work.

## Conventions

- No runtime dependencies. Dev dependencies need a strong reason.
- Rule ids are `<provider>/<kebab-case>`. Messages state the problem; `hint` states the fix, in the imperative.
- Findings point at the subschema that must change, as a JSON Pointer.
- Public API lives in `src/index.ts`; anything exported there is semver-relevant.
- Every user-visible change gets a line under `## Unreleased` in `CHANGELOG.md`.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- When a roadmap item is done, tick its checkbox in `ROADMAP.md` in the same change.
