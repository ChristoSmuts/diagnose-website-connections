# Connection Diagnostics

Paste a website address. Find out plainly whether a slowdown is **the site's server**, **your own
internet connection**, or **the network path between you** — and who can actually fix it.

100% open source, no paid services, no API keys. Runs entirely on your own machine.

---

## Why this exists

A browser alone cannot answer this question. CORS redacts cross-origin timing detail, and JavaScript
has no visibility into DNS, TCP or TLS. Any browser-only tool is guessing.

Real attribution needs a **differential across three vantage points**:

|       | Vantage                         | What it establishes                                         |
| ----- | ------------------------------- | ----------------------------------------------------------- |
| **S** | Our server → the target         | How the site behaves for a neutral, well-connected observer |
| **K** | Your browser → our own endpoint | How your connection behaves, independent of the target      |
| **T** | Your browser → the target       | What you actually experience                                |

Comparing the three is what turns "the site feels slow" into an answer somebody can act on. If the
site is slow from _our_ server too, it is slow for everyone. If our own endpoint is equally slow for
you, it is your link. If both are healthy and only your route to the site is not, it is the path.

## Quick start

```bash
docker compose up --build     # → http://localhost:8787
```

Or without Docker:

```bash
pnpm install
pnpm run build
pnpm run dev                  # api on :8787, app on :5173
```

Requires **Node 24 LTS** (see `.nvmrc`) and pnpm 10+.

### From the terminal

```bash
node apps/api/src/cli/probe.ts example.com
node apps/api/src/cli/probe.ts example.com --json
```

Useful for checking a site from a server with no browser, and for confirming the engine works on your
network before wiring anything else up.

## What it measures

**Server-side** (Node built-ins only, no third-party services):

- DNS across several public resolvers, plus direct timing of the domain's own authoritative
  nameservers — disagreement between resolvers is a real failure mode nothing else surfaces
- TCP connect time **per address, IPv4 and IPv6 separately** — broken IPv6 with working IPv4 is the
  classic "it works for me" cause
- TLS handshake, protocol, cipher, ALPN, full certificate chain, expiry, OCSP stapling, and a second
  handshake to measure the real saving from session resumption
- HTTP status, negotiated version, redirect chain with per-hop timing, compression, cache headers,
  HTTP/3 advertisement, payload size
- Repeated samples for median, p95 and jitter, plus cold-versus-warm to expose caching
- Network ownership and CDN detection via Team Cymru's free DNS-based ASN service

**In your browser:** round-trip time and jitter against our own control endpoint, a packet-loss
proxy, an optional capped throughput test (opt-in — it spends your data), and a coarse measurement of
the target itself.

## Reading the report

Three layers, so it works for whoever is looking at it:

1. **The verdict** — one sentence, plus who owns the problem. Most people can stop here.
2. **Findings** — ranked worst-first, in ordinary words, each naming who can fix it.
3. **Every check we ran** — all ~30 checks including the ones that passed, grouped by stage of the
   request, each expanding to a full technical explanation and its evidence.

Findings describe problems; checks describe everything examined. That distinction matters: a healthy
site produces no findings, and without checks there would be nothing to inspect — which is backwards
for a diagnostics tool.

### Honesty rules the engine enforces

These are structural, not conventions:

- **Never blames what it did not measure.** Without browser-side evidence it cannot conclude
  "your connection" or "the path" — and it won't.
- **Loopback is not a connection.** When self-hosted on your own machine, the control endpoint
  answers in ~3ms over loopback. That says nothing about your internet, so both client-side vantages
  report _not measured_ rather than a flattering "healthy".
- **Measured vs inferred** is carried on every value, so a derived number can never be rendered as an
  observed one.
- **"Inconclusive" is a valid answer.** Admitting ignorance beats inventing a culprit.
- **"Not run" and "could not tell" are different facts** and never share a state.
- **Prose never contradicts the tile beside it.** Enforced by tests, after it shipped twice.

## Configuration

Everything has a working default; nothing is required.

| Variable                | Default                   | Notes                                 |
| ----------------------- | ------------------------- | ------------------------------------- |
| `PORT`                  | `8787`                    |                                       |
| `AUTH_MODE`             | `none`                    | `none` \| `password` \| `multiuser`   |
| `AUTH_PASSWORD`         | —                         | Required when `AUTH_MODE=password`    |
| `DATABASE_PATH`         | `./data/dwc.db`           | One file. Backup = copy it.           |
| `DNS_RESOLVERS`         | `1.1.1.1,8.8.8.8,9.9.9.9` | Explicit, never the host's resolver   |
| `STABILITY_SAMPLES`     | `5`                       | Below 5, variance is treated as noise |
| `RATE_LIMIT_PER_MINUTE` | `20`                      | Per client IP                         |

## Security

The service accepts a URL from an untrusted user and connects to it — textbook SSRF. It:

- rejects non-http(s) schemes
- resolves first, then validates **every** returned address against a denylist covering loopback,
  RFC1918, link-local, ULA and cloud metadata (`169.254.169.254`)
- **pins the validated IP** for the actual connection, closing the DNS-rebinding window between
  check and connect, and re-validates on every redirect hop
- caps redirects, response size and duration, and rate-limits per IP

## Repository layout

```
apps/
  api/          Fastify probe engine — all network I/O, plus the CLI
  web/          Lit + Vite app
packages/
  contracts/    zod schemas and types shared by both sides
  diagnostics/  the attribution engine — pure, no I/O, no clock, no network
  persistence/  repository interfaces + SQLite adapter
  tokens/       design tokens (OKLCH) as CSS custom properties, plus vendored fonts
  ui/           Lit component library (shadow DOM, themeable, drop-in)
e2e/            Playwright: journeys, accessibility, visual regression
```

`diagnostics` is deliberately separate from `api`: the reasoning is pure and deterministic, so the
verdict logic is tested against fixtures rather than against the live internet.

### Two toolchain constraints worth knowing

- **`apps/web` uses Lit's static `properties` API, not decorators.** Vite 8 transforms with Oxc,
  which cannot lower decorators of either flavour, so decorated classes reach the browser as invalid
  syntax. `@dwc/ui` is unaffected — `tsc` compiles it ahead of time.
- **`@dwc/ui` compiles Tailwind into a single shared stylesheet** (`scripts/build-styles.mjs`) that
  every shadow root adopts by reference. Components keep real encapsulation; tokens cross the
  boundary as CSS custom properties. Icons are generated the same way, from a committed manifest.
- **The repo root pins TypeScript 5.x for the linter only**, while every package builds with 7.x.
  TypeScript 7 is the native compiler and ships no JavaScript API, so typescript-eslint cannot parse
  with it.

## Development

```bash
pnpm run dev         # api + web with reload
pnpm run test        # every package
pnpm run typecheck
pnpm run lint        # one ESLint pass across the workspace
pnpm run format      # prettier --write .
pnpm run verify      # format + lint + typecheck + test + build, as CI runs it

pnpm --filter @dwc/e2e run e2e    # Playwright: journeys, a11y, visual regression
```

The E2E suite needs a build first (`pnpm run build`), because the API serves the built app.

**Visual baselines are Linux-only.** Font rasterisation differs by platform, so snapshots are
generated and compared inside the official Playwright container; elsewhere those specs skip
themselves.

See [CLAUDE.md](CLAUDE.md) for the constraints that are not obvious from the code, and
[CONTRIBUTING.md](CONTRIBUTING.md) to make a change.

## Documentation

|                                    |                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)             | Architecture, the honesty invariants, and the constraints that will bite you |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, the verify gate, how to add a finding, a check, or an icon            |
| [VERSIONING.md](VERSIONING.md)     | The three separate version numbers and what each one means                   |
| [SECURITY.md](SECURITY.md)         | Threat model, the SSRF defences, and how to report an issue                  |
| [CHANGELOG.md](CHANGELOG.md)       | What changed, including what is deliberately not done yet                    |

## Licence

MIT — see [LICENSE](LICENSE), which also lists the bundled fonts and icons and their licences.
