# Contributing

Thanks for helping keep schemas portable. The most valuable contributions, in order:

1. **Corrections.** A rule that no longer matches a provider's behavior is this project's worst kind of bug. Open an issue with the schema, the provider's response, and the date.
2. **New rules** for existing providers.
3. **New providers.**
4. Anything on the [roadmap](ROADMAP.md).

## Setup

```bash
git clone https://github.com/YasinzHyper/schemafit.git
cd schemafit
npm ci
npm run check
```

`npm run check` runs the typechecker, the tests, and verifies that `docs/rules.md` is up to date. CI runs the same command.

## Adding a rule

A rule is a small object in `src/providers/<provider>.ts`:

```ts
const noExternalRef: Rule = {
  ...meta("no-external-ref", {
    severity: "error",
    summary: 'External "$ref"s are not supported.',
  }),
  check(ctx) {
    for (const node of ctx.nodes) {
      const ref = node.schema.$ref;
      if (typeof ref !== "string" || ref.startsWith("#")) continue;
      ctx.report({
        path: node.path,
        message: `"$ref": "${ref}" points outside this document.`,
        hint: 'Inline the referenced schema under "$defs".',
      });
    }
  },
};
```

Then:

1. Add it to the provider's `rules` array.
2. Add tests in `tests/<provider>.test.ts`: at least one schema that triggers the rule and one that does not.
3. Run `npm run docs` to regenerate `docs/rules.md`.
4. Add a line under `## Unreleased` in `CHANGELOG.md`.

### The accuracy contract

- `source` must link to **official provider documentation** for the behavior. Blog posts, forum answers, and SDK source code are useful leads, not sources.
- `verified` is the date you read that page.
- Use `severity: "error"` only when the documentation says the construct is unsupported or rejected. If the behavior is undocumented or you inferred it, use `"warn"` and explain in `notes`.
- If you observed the behavior from the live API but cannot find it documented, open an issue with the request and response instead; we track those as *needs evidence* on the roadmap.

## Pull requests

- One logical change per PR.
- Name the branch after the change: `<type>/<short-description>`, for example `feat/sarif-output` or `fix/anthropic-format-list`.
- Conventional Commit titles (`feat: ...`, `fix: ...`, `docs: ...`).
- `npm run check` passes.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
