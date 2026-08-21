# Contributing

## Setup

```bash
nvm use              # or fnm use — reads .nvmrc (Node 24)
pnpm install
pnpm run dev         # api on :8787, web on :5173
```

`pnpm run verify` is the gate. It runs `format:check → lint → typecheck → test → build`, which is
exactly what CI runs, so a green local verify means a green CI.

Read [CLAUDE.md](CLAUDE.md) first. It documents the constraints that are not visible from the code —
the Oxc decorator limitation, the two TypeScript versions, the three-place token duplication, and the
honesty invariants the engine exists to uphold.

## Before you open a PR

- [ ] `pnpm run verify` passes
- [ ] New behaviour has a test that would fail without it
- [ ] Copy follows the two skills (below)
- [ ] `ENGINE_VERSION` bumped if verdict semantics changed — see [VERSIONING.md](VERSIONING.md)
- [ ] A changeset added for any `packages/*` change (`pnpm changeset`)

## Writing copy

Every user-facing string is governed by two skills in `.claude/skills/`:

- **`humanizer`** — vendored from [blader/humanizer](https://github.com/blader/humanizer) (MIT,
  © 2025 Siqi Chen). A general pass for AI-writing tells. Do not edit it locally; it is kept
  byte-identical to upstream so a new release can be diffed. See
  `.claude/skills/humanizer/UPSTREAM.md`.
- **`report-voice`** — this project's own rules: register, the honesty invariants expressed as copy
  rules, layer discipline, and a banned-phrase list.

The short version: write for a competent adult who is not a network engineer. Short sentences,
concrete nouns, real numbers, spaced units (`41 ms`). Never state a number for something that was not
measured. Never let prose contradict the component beside it.

`packages/diagnostics/src/copy.test.ts` enforces the mechanical half of this. It cannot tell you
whether the writing is good — only reading it can.

## Adding a finding

A finding describes something **wrong**, and always names who can fix it.

1. Add the code to `FindingCodeSchema` in `packages/contracts/src/verdict.ts`.
2. Detect it in `packages/diagnostics/src/findings/{server,client}.ts` using the `finding()` helper.
3. Give it `plain` and `impact` in ordinary words, a genuinely technical `technical`, and real
   `remediation` with a copyable snippet where one exists.
4. Set `owner` honestly. `nobody` is a valid and useful answer.
5. Add any new term to `glossary.ts` — a test fails if jargon reaches Layer 1 or 2 undefined.
6. Add a fixture scenario and assert the verdict, not just that the finding fired.
7. Bump `ENGINE_VERSION` (minor).

## Adding a check

A check describes something **examined**, whether or not anything was wrong with it. Passing checks
matter: a healthy site should reward inspection.

1. Add it to the relevant phase function in `packages/diagnostics/src/checks.ts` via `check()`.
2. Use a stable dotted `id` (`tls.resumption`) — tests assert on these.
3. `technical` is Layer 3: **do not simplify it.** Name the RFC, quote the header, give the value.
4. Distinguish `skipped` ("we did not run this") from `unavailable` ("we ran it and could not tell").
5. Link `relatedFindings` only for codes that can actually fire; a test checks for dangling links.
6. Bump `ENGINE_VERSION` (minor).

## Adding an icon

1. Add a semantic name → Phosphor name to `packages/ui/icons.manifest.json`.
2. If it needs `fill` or `duotone`, add it to `extraWeights` — and **look at it**. A glyph with no
   enclosed area has no meaningful fill weight and Phosphor substitutes a different shape.
3. Rebuild (`pnpm --filter @dwc/ui run build:icons`).

## Adding a design token

Add it to **all three** theme blocks in `packages/tokens/src/tokens.css` if it is colour-dependent:
bare `:root`, the `prefers-color-scheme` block, and the `[data-theme='dark']` block.
`theme-parity.test.ts` fails if you miss one.

## Touching the probe engine

`apps/api` is the only place network I/O belongs. Before changing anything in `probes/` or `safety/`,
read the security section of [CLAUDE.md](CLAUDE.md) — particularly why `probes/http.ts` uses
`node:https` with a pinned lookup rather than `fetch`. Replacing it with `fetch` silently reopens a
DNS-rebinding hole.

`packages/diagnostics` must stay pure. ESLint bans `Date.now()`, `new Date()` and `Math.random()`
there; take a timestamp as an argument instead.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for anything touching SSRF.

## Visual baselines

Three snapshots, and only three: the empty state and the full report in both themes. They exist to catch
the catastrophe nothing else looks for — a stylesheet that failed to load, a theme that stopped applying,
a page that renders blank. Everything else about layout is asserted by measurement, which fails with the
offending element named rather than with a diff to squint at.

All three are clipped to the content column, the report shots open a **seeded** report rather than
running a live diagnostic, and nothing is masked. Each of those is load-bearing. The sidebar accumulates
whatever earlier specs left in the shared database, and a live verdict flips between wordings — and
colours — when the target drifts by a few tens of milliseconds; masking hides content but not size, so
neither could be masked away. A stored verdict renders identically every run, which is what lets the
whole column be compared instead of a handful of survivors. See `e2e/global-setup.ts`.

The specs emulate `prefers-reduced-motion`, because the score dial counts up in JavaScript and
Playwright's `animations: 'disabled'` settles CSS animations only.

Baselines are **Linux-only**, because font rasterisation differs by platform and a baseline taken on a
Windows or macOS machine can never match CI. That does not mean they can only be made on GitHub —
"the same Linux" is available locally too, in the container the `e2e` job already uses:

```bash
./scripts/update-visual-baselines.sh
```

It pulls `mcr.microsoft.com/playwright:v1.62.1-noble`, builds and runs the suite inside it, and copies
the PNGs back into `e2e/specs/visual.spec.ts-snapshots/` for you to review and commit. On Windows, run
it from WSL, where Docker lives. The source tree is copied into the container rather than mounted, so a
Linux `pnpm install` never lands on top of your Windows `node_modules`.

The CI route still exists and is the right one when you have no Docker: run the **CI** workflow with
`update_snapshots` set to true, download the `visual-baselines` artifact, and commit the PNGs it
contains. Both routes run the same image, so they produce the same images.
