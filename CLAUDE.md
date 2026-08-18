# Working in this repository

A self-hosted web app that diagnoses a website's connection and says **whose fault a slowdown is**:
the target's server, the visitor's own internet connection, or the network path between them.

Read this before changing anything. Most of it is non-obvious and was learned the hard way.

## Commands

```bash
pnpm install
pnpm run dev          # api on :8787, web on :5173 (proxied, same-origin)
pnpm run verify       # format:check + lint + typecheck + test + build — what CI runs
pnpm run lint         # eslint . (one pass from the root, NOT a Turbo task)
pnpm run format       # prettier --write .

node apps/api/src/cli/probe.ts example.com --json   # drive the engine with no browser
```

Requires **Node 24** (`.nvmrc`). Docker/compose for the self-hosted deployment.

## Architecture

```
apps/api/         Fastify probe engine — ALL network I/O lives here, plus the CLI
apps/web/         Lit + Vite app
packages/contracts/    zod schemas shared by both sides — the single API contract
packages/diagnostics/  the attribution engine: PURE, no I/O, no clock, no network
packages/persistence/  repository interfaces + SQLite/Drizzle adapter
packages/tokens/       OKLCH design tokens as CSS custom properties + vendored fonts
packages/ui/           Lit component library (shadow DOM, themeable, drop-in)
```

**Why `diagnostics` is separate from `api`:** `api` does I/O and produces evidence; `diagnostics`
consumes evidence and produces verdicts. That split is what makes the verdict logic testable against
fixtures instead of against the live internet. Its purity is enforced by ESLint — `Date.now()`,
`new Date()` and `Math.random()` are banned in that package.

## The honesty invariants

These are the product. Breaking one makes the report lie, and its only real asset is being
trustworthy about attribution.

1. **Never blame what was not measured.** Without browser-side evidence the engine cannot conclude
   "your connection" or "the path", and it must not.
2. **Loopback is not a connection.** Self-hosted on your own machine, the control endpoint answers in
   ~3 ms over loopback. That says nothing about anyone's internet, so both client vantages report
   _not measured_ rather than a flattering "healthy". `LOCAL_CONTROL_RTT_MS` is the threshold.
   Getting this wrong made the engine blame the reader's ISP for latency it had never measured.
3. **Provenance travels with every number** (`measured` | `inferred` | `unavailable`), structurally,
   so an inferred value cannot render as an observed one.
4. **"Inconclusive" is a valid verdict.** Admitting ignorance beats inventing a culprit.
5. **Prose must never contradict the component beside it.** This shipped twice. See
   `packages/diagnostics/src/copy.test.ts`, which guards it now.
6. **Variance needs ≥ `MIN_SAMPLES_FOR_VARIANCE` samples.** An IQR from three requests is noise, and
   treating it as signal produced "slow to respond (63 ms)" beside a health score of 96.

## Constraints that will bite you

### Vite 8 / Oxc cannot lower decorators

`apps/web` **must not use decorators.** Vite 8 transforms with Oxc, which cannot lower them in either
flavour, so a decorated class reaches the browser verbatim and dies with `Unexpected token 'export'` —
a blank page with nothing in the build output explaining why. Use Lit's static `properties` API there.
ESLint enforces this with a `no-restricted-syntax` rule.

`packages/ui` **does** use decorators, and that is fine: `tsc` compiles it ahead of time, so consumers
only ever receive plain JavaScript. Its Vitest, however, also transforms via Oxc — so **`@dwc/ui`
tests must not import a component module.** Pure logic lives in `src/utils/` and `src/icons/` where it
is testable.

### The root pins TypeScript 5.x, every package builds with 7.x

TypeScript 7 is the native compiler and ships no legacy JS API — `require('typescript')` resolves to
`lib/version.cjs`, with no `createSourceFile`. typescript-eslint therefore cannot even _parse_ with
it. The root declares `typescript: ^5.9` for the linter alone; every package keeps `typescript:
catalog:` (7.x) for its build. **Do not "tidy" the root back to `catalog:`** — linting stops working.

### Tokens are duplicated three times, by necessity

The dark palette exists twice: once under `@media (prefers-color-scheme: dark)` guarded by
`:not([data-theme='light'])`, and once under `:root[data-theme='dark']`. CSS offers no way to share
them. **A new colour token must be added in all three places.** `theme-parity.test.ts` parses the
sheet and fails if the copies drift — otherwise the bug is invisible on one code path.

### Tailwind compiles to one shared adopted stylesheet

`packages/ui/scripts/build-styles.mjs` compiles Tailwind into `src/styles/generated.ts`, and
`shared.ts` wraps it in a single `unsafeCSS` instance adopted **by reference** into every shadow root.
Adding a class to `surfaceSheet` therefore upgrades all components at zero per-component cost. Both
`generated.ts` files are git-ignored build output.

### Icons are generated, not hand-written

`scripts/build-icons.mjs` extracts only the icons named in `icons.manifest.json` from
`@phosphor-icons/core` (a devDependency, so nothing reaches a consumer's runtime). Phosphor's glyphs
are on a **256×256 grid** and are **filled, not stroked** — there is no stroke width to vary, and
`weight` selects different path data.

Two traps: a glyph with no enclosed area has no meaningful `fill` weight (Phosphor's `check-fill` is a
filled _square containing_ a check), and **TypeScript does not typecheck Lit template attributes**, so
`name="typo"` compiles fine and silently falls back. `src/icons/icons.test.ts` scans component sources
and is the only thing that catches it.

## Copy

Two skills govern all user-facing text, and both should be applied before committing copy:

- `.claude/skills/humanizer/` — vendored from blader/humanizer (MIT). General anti-AI-slop pass.
- `.claude/skills/report-voice/` — this project's rules: register, the honesty invariants as copy
  rules, layer discipline, banned phrasings.

Register: **readable, not dumbed down.** Write for a competent adult who is not a network engineer.
Units are spaced (`41 ms`, never `41ms`) — `ms()` in `findings/helpers.ts` and `formatMs()` in
`@dwc/ui` both enforce it, and `copy.test.ts` checks every user-facing string.

### The three report layers

| Layer        | Where           | Rule                                                                         |
| ------------ | --------------- | ---------------------------------------------------------------------------- |
| 1 — verdict  | `narrate.ts`    | One sentence, no unexplained jargon. Numbers in `plain`, never the headline. |
| 2 — findings | `findings/*.ts` | Ordinary words. Every finding names an owner. Problems only.                 |
| 3 — checks   | `checks.ts`     | **Do not simplify.** Real headers, ciphers, exact values. Includes passes.   |

**Findings are problems; checks are everything examined.** A healthy site produces ~30 passing checks,
which is the whole point — it should reward inspection rather than showing an empty page. `skipped`
("we did not run this") and `unavailable` ("we ran it and could not tell") are different facts and must
read differently.

## Security

The service takes a URL from an untrusted user and connects to it — textbook SSRF. It resolves first,
validates **every** returned address against a denylist (loopback, RFC1918, link-local, ULA,
`169.254.169.254`), then **pins the validated IP** for the actual connection and re-validates on every
redirect hop.

Two mistakes already made here, both worth not repeating:

- `URL.hostname` wraps IPv6 literals in brackets (`[::1]`), which `isIP()` does not recognise. Strip
  them before validating or the denylist is skipped entirely.
- Global `fetch` re-resolves DNS and so bypasses IP pinning, reopening DNS rebinding. `probes/http.ts`
  is built on `node:https` with a pinned `lookup` for exactly this reason. **Do not replace it with
  `fetch`.**

> **Not yet implemented, and deliberately noted:** the plan calls for an `ALLOW_PRIVATE_TARGETS` flag
> so a local fixture server can be probed in tests. It does not exist yet. If you add it: default
> `false`, settable only via environment, log loudly when enabled, never reference it from the web app
> or any shipped Docker/compose config, and write the test asserting private targets stay refused
> _without_ it before writing the flag itself.

## Versioning

See [VERSIONING.md](VERSIONING.md). Three independent numbers, and the distinction matters:
app SemVer, `ENGINE_VERSION` in `packages/diagnostics` (bump whenever the same evidence could now
produce a different verdict), and the SQLite `user_version` for migrations.

## Testing

Reports are **immutable and append-only**. A re-run is a new row, never an edit, and each stores its
rendered `summary_json` so an old report keeps saying what it said at the time.

The most useful lesson from building this: **unit tests could not catch the class of bug that mattered
most.** Every false accusation against a site owner or an ISP was found by running the real thing —
first via the CLI, then in a browser. Fixes are then locked in with a regression test that explains
_why_ it exists. Keep doing both.
