# Changelog

Notable changes to the application. Package-level changes are tracked by Changesets in each
package's own changelog. See [VERSIONING.md](VERSIONING.md) for what each version number means.

## [0.2.0] — 2026-08-17

Engine `1.1.0`. Adds a full checks layer, rebuilds the visual design, and makes the quality gates real.

### Added

- **Every check is now inspectable, passing ones included** (`checks[]` on the verdict). Findings only
  ever described problems, so a healthy site had almost nothing to expand — backwards for a
  diagnostics tool. A healthy site now yields around thirty checks grouped by request phase, each with
  a genuinely technical explanation and its own evidence table. `skipped` ("we did not run this") and
  `unavailable` ("we ran it and could not tell") are separate states, because they are different facts.
- Filterable "Every check we ran" section with a pass / attention / inconclusive summary.
- Score dial shows movement against the previous report for the same site.
- Self-hosted Inter and JetBrains Mono (latin subset, ~88 KB, both OFL), preloaded at build time. No
  CDN, so the offline guarantee holds.
- Phosphor icons (MIT), extracted at build time from a committed manifest into a generated registry —
  a devDependency only, so no consumer of `@dwc/ui` inherits it.
- Shared visual primitives (`surfaceSheet`): layered surfaces with a hairline highlight, tone-keyed
  ambient washes, tabular numerals, staggered entrance, shimmer.
- ESLint 10 with type-aware rules, plus two project-specific guards: `packages/diagnostics` may not
  touch the clock or randomness, and `apps/web` may not use decorators.
- Prettier, `.editorconfig`, `LICENSE`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `VERSIONING.md`.
- Two copy skills under `.claude/skills/` — vendored `humanizer`, plus a project-specific
  `report-voice` holding the honesty invariants as copy rules.
- 98 new tests (107 → 205), including a token-parity guard, an icon-reference guard, and copy tests
  covering contradiction, register, and glossary coverage.

### Fixed

- **The verdict headline contradicted its own body.** A healthy site with suggestions read
  "nothing is holding it back" directly above a list of five things worth improving and a summary
  reading "5 worth attention". Healthy-with-suggestions is now a different sentence from
  healthy-with-none. Found by looking at the rendered page, not by a test — and now guarded by one.
- Durations render as `41 ms`, not `41ms`, everywhere including vantage summaries and the waterfall.
  The first fix reached only the narration helper; the test that caught the rest now covers every
  user-facing string.
- Parenthesised placeholder plurals (`4 address(es)`, `0 hop(s)`) replaced with real pluralisation.
- A failed migration now attaches the original error as `cause`, so the offending SQL statement
  survives to the logs.
- Explicitly typed the TLS socket error handler, so a rejection reason is guaranteed to be an `Error`.
- Removed a dead initializer in the TLS resumption path that obscured the deliberate "stays unknown
  unless proven" intent.

### Changed

- `lint` is a real gate. No package had ever defined a `lint` script, so `turbo run lint` matched zero
  tasks and `pnpm run verify` had been passing a gate that did not exist.
- The root pins `typescript@5.x` **for the linter only**; every package still builds with 7.x.
  TypeScript 7 is the native compiler and ships no JS API, so typescript-eslint cannot parse with it.
- Layer 1 copy recalibrated: readable for a competent adult rather than aimed at a complete layman.
- `EvidenceRow` extracted in the contracts and shared by findings and checks, so both are forced to
  carry provenance.
- Hard-coded z-indices replaced with a named `--dwc-z-*` scale.

### Not yet done

Called out rather than quietly omitted:

- **No fixture server**, so there is no deterministic offline origin for degraded modes (slow TTFB,
  expired certs, redirect chains). This also blocks the planned `ALLOW_PRIVATE_TARGETS` flag and the
  attribution matrix test.
- **`AUTH_MODE=multiuser`** still refuses to start rather than being implemented.
- No Lighthouse CI, bundle budget, or dependency-audit gate.

## [0.1.0] — 2026-08-17

First working version. Engine `1.0.0`.

- Three-vantage differential attribution: our server → target, browser → our control endpoint,
  browser → target. Comparing the three is what turns "the site feels slow" into an answer.
- Server-side probes on Node built-ins only: DNS across several resolvers plus authoritative
  nameservers, TCP per address per family, TLS with full certificate chain and a second handshake to
  measure real resumption benefit, HTTP with redirect chain timing, repeated sampling, and keyless
  ASN/CDN detection via Team Cymru.
- SSRF hardening: scheme allowlist, resolve-then-validate-every-address, **IP pinning** against DNS
  rebinding, per-hop redirect re-validation, caps and rate limiting.
- Pure attribution engine with no I/O, clock, or randomness.
- SQLite persistence behind repositories, `Principal`-scoped from the first query, with immutable
  append-only reports.
- Lit component library in shadow DOM with one shared adopted Tailwind sheet; OKLCH tokens with
  three-state theming.
- Single-container deployment serving app and API same-origin, which keeps the browser's latency
  baseline undistorted by CORS preflights.
