# Versioning

Three version numbers exist in this repository and they mean different things. Conflating them is the
mistake this document exists to prevent.

## 1. The application — SemVer

`package.json` at the root. What a bump means for someone running this:

| Bump      | When                                                                                                                                                                | Example                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **major** | The report's meaning changes, or a stored report can no longer be read as it was written. Also any removal of an API route, config variable, or exported component. | Dropping a vantage; renaming a `Culprit`; removing `AUTH_MODE=password` |
| **minor** | New capability, backwards compatible.                                                                                                                               | Adding `checks[]`; a new probe; a new UI component                      |
| **patch** | Fixes, copy, visual refinement, dependency updates.                                                                                                                 | Correcting a misattribution; rewording a finding                        |

**A misattribution fix is a patch, not a minor.** It changes what the tool says about a given site,
but it does so by making an existing claim correct rather than by adding anything.

### Publishable packages

`packages/*` version independently via [Changesets](https://github.com/changesets/changesets) (MIT).
`@dwc/ui` and `@dwc/tokens` are the ones intended for reuse elsewhere in the ecosystem, so their
SemVer is a real contract:

- **major** — a component's tag name, property name, event name, or slot changes; a token is removed
  or renamed.
- **minor** — a new component, property, or token.
- **patch** — visual refinement that changes no API.

Restyling a component is a **patch** even when it looks completely different, because consumers depend
on its API and its tokens, not its appearance. Removing a token is a **major** even if nothing in this
repo still uses it — a downstream consumer might.

```bash
pnpm changeset          # describe the change; commit the generated file with your PR
pnpm changeset version  # apply pending changesets, update changelogs
```

## 2. `ENGINE_VERSION` — the interpretation contract

In `packages/diagnostics/src/engine.ts`, stamped onto every verdict and stored with it.

**Bump it whenever the same evidence could now produce a different verdict.** That includes:

- changing any threshold in `thresholds.ts`
- changing the attribution decision table or the scoring
- adding, removing, or re-scoping a finding code or a check
- changing what a `status` means for a vantage

It does **not** need bumping for wording that carries the same meaning, or for anything in the UI.

Why it is separate from the app version: reports are immutable and store their rendered
`summary_json`, precisely so history reads in its original terms rather than being silently
reinterpreted under thresholds that did not exist when it was taken. `ENGINE_VERSION` is what tells
you _which_ terms those were. Without it, a stored report is undated evidence.

It follows SemVer loosely — major for a changed decision table, minor for new findings or checks,
patch for a retuned threshold.

### Reading older reports

The UI must keep rendering reports produced by earlier engines. New fields on `VerdictSchema` are
therefore added with a **default**, and the UI hides the section when empty. `checks[]` (engine 1.1.0)
is the worked example: reports from 1.0.0 have none, so the checks section simply does not appear.

Never backfill a stored report. It is a record of an observation, not a cache.

## 3. Database `user_version` — schema migrations

SQLite's own `user_version` pragma, managed by `packages/persistence/src/migrations.ts`. Migrations
run automatically at boot, each in its own transaction, because a partially applied schema is worse
than none.

Adding a migration is additive-only: existing rows must survive. Anything that would drop or rewrite
stored reports is a major application bump and needs a note in the changelog telling people to back up
first — which for this app means copying one file.

## Release checklist

1. `pnpm run verify` green.
2. `ENGINE_VERSION` bumped if verdict semantics moved.
3. Changeset written for any `packages/*` change.
4. `CHANGELOG.md` updated.
5. Open a pre-existing report and confirm it still renders.
6. `docker compose up --build`, run one real diagnostic, restart, confirm history survived.
