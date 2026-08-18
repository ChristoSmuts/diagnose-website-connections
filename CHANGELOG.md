# Changelog

Notable changes to the application. Package-level changes are tracked by Changesets in each
package's own changelog. See [VERSIONING.md](VERSIONING.md) for what each version number means.

## [0.4.0] — 2026-08-18

Engine `1.3.0`. Adds a hosting-location section to the report, gives configuration a file to live in,
and fixes a status indicator that was never round.

### Added

- **Where a site is served from**, in the checks under "Where the site is hosted". Four new checks: the
  consolidated location, reverse DNS per address, the certificate's identity fields, and a distance
  ceiling derived from the round trip.

  Every source is free and keyless, and most of the signal was already being collected and thrown away.
  Edge locations come out of response headers this app has stored for every report ever taken —
  `cf-ray`, `x-amz-cf-pop`, `x-served-by` — and nothing had ever read them. The routing registry already
  gave a country; the operator's own registered country was fetched in the same lookup and discarded.
  The certificate's `C` and `O` fields were in memory during every probe and dropped on the way to the
  contract. New I/O amounts to one reverse-DNS query per address.

  **It does not establish data residency, and says so.** A probe sees the machine that answered; where a
  business stores, processes or backs up data is a contractual arrangement that nothing on the wire
  reveals. An edge in Johannesburg fronting an origin in Virginia with a database in Ireland is
  unremarkable, and a country printed beside a hostname will be read as answering the residency question
  unless the report explicitly refuses it.

  Claims are collected rather than reconciled. `cloudflare.com` is registered in the United States and
  answered from Cape Town — neither record is wrong, and picking a winner would have hidden what anycast
  actually looks like from outside. Where a CDN is detected, the check says the origin is not visible
  from here rather than describing the edge as though it were the origin.

- **A distance ceiling**, which is the only measured location signal in the section and the only one that
  can contradict a record instead of repeating it. Light covers about 200 km of fibre per millisecond and
  a round trip pays it twice, so a reply bounds how far away the far end can be. Reported from the
  browser and from the server separately, because they are bounds from two different places. Above about
  20,000 km the bound excludes nowhere on Earth, and is reported as no constraint rather than as a
  number that looks like information.
- **`origin-geographically-distant`** now fires. It has been declared in the contract, and linked from a
  check, since the day it was written, with no detector behind it. It reports distance only once the two
  competing explanations are ruled out — no CDN in front, and no unexplained routing excess — because a
  slow round trip on its own is equally consistent with a busy server or a bad route. Owner is `nobody`;
  the fix belongs to `no-cdn`, which already offers it.
- **Per-address network identity.** ASN and reverse DNS are now resolved for every address that answered
  rather than for whichever replied first, so a site whose addresses sit on different networks is no
  longer collapsed into a single answer.
- **`CONTROL_URL` accepts any URL**, not only another instance of this app. The round trip is timed
  without reading the response, so the far end grants nothing — `https://www.google.com/generate_204`
  works. That makes "your connection" measurable on a local install with no second deployment and no
  tunnel. Unset by default, and nothing contacts a third party unless an operator sets it.

  **It unlocks "your connection" and deliberately not "the path between".** Judging the route means
  subtracting the reader's link cost from their time to the site, which assumes the two are comparable
  measurements. A large provider answers from whichever edge is nearest the reader, by design, so the
  baseline is short by however far the site actually is and the leftover — which the report attributes
  to the reader's provider — is really distance. Blaming an ISP for geography is the same class of error
  as blaming one for loopback. The route now says why it cannot be judged and what would fix it.

- **`.env`** — configuration finally has somewhere to live. Read from the repo root by both the server
  and the CLI, using Node's own env-file support rather than a dependency. Real environment variables
  still win, so a value passed to `docker compose` or set for one run beats a file edited weeks ago. The
  boot log names the file it loaded, or says it found none. `.env.example` documents all nineteen
  variables; `.gitignore` had been reserving the filenames since the first commit with nothing to put
  in them.

### Fixed

- **The report said `ASAS13335`.** The probe stores the canonical `AS13335` and three places in the
  checks prefixed it a second time. Visible in the network ownership headline of every report ever
  produced.
- **`unknown` rendered as a measured value.** Four evidence rows on the network ownership check omitted
  their provenance, which defaults to `measured` — so a lookup that failed showed the literal word
  "unknown" wearing the badge that means "we observed this". That is invariant 3 broken in the one place
  nobody had looked.
- **The sidebar status dot was an oval leaning right.** The favicon clipped its own contents so remote
  artwork could not spill, and the dot was positioned to overhang that same box — the clip took its right
  and bottom edges and the whole of its ring. Two rules on one element, each correct alone. The clip now
  belongs to an inner element so the dot has somewhere to hang. It is also 8 px rather than 7, because a
  7 px circle inside a 1.5px ring lands every edge on a half pixel and renders lopsided regardless.
- **The CLI printed `73ms`.** It defined its own duration formatter instead of using the engine's, and so
  broke the spaced-unit rule the rest of the report follows — the same fault as the progress messages, for
  the same reason: copy tests only ever see strings the engine produced. It now has a source-scanning test of its own, so the fault has nowhere left to reappear.
- A finding began "Simply opening a connection…", which the banned-register test would have caught years
  ago had any fixture produced a slow enough connection to trigger it. One does now.

### Changed

- The README's configuration section lists all nineteen variables rather than nine, and says **where** to
  put them. `CONTROL_URL` was documented as a bare `CONTROL_URL=…` line with no indication of which file
  it belonged in, which was the gap that prompted this release.

## [0.3.0] — 2026-08-18

Engine `1.2.0`. Makes a local install able to measure all three vantages, gives reports real URLs, and
fixes two pieces of silent data loss.

### Added

- **Each site shows its own favicon in the sidebar**, and that icon is what identifies it when the
  sidebar is collapsed to a rail. Fetched **by the server**, once per site, through the same SSRF guard
  and IP pinning as everything else, then stored as a data URL — a page requesting each icon directly
  would announce the reader's whole list of saved sites to those origins on every load, and a favicon
  service would put a third party inside a tool that deliberately has none. Sites with no favicon get a
  monogram tile whose hue is derived from the hostname, so it is stable and tells sites apart.
  Database `user_version` 2.
- **`CONTROL_URL`** — where the browser measures its latency baseline. Self-hosted on your own machine
  that baseline is loopback, so "your connection" and "the path between" both correctly read _not
  measured_ and there was no supported way to change that. Point this at another instance reachable
  across the internet and both vantages work. Unset by default, so nothing changes for anyone who does
  not opt in, and the endpoint that answered is recorded on the evidence rather than left to the prose.
- **A `path` phase in the checks.** The route had a verdict but no checks, so a report could say "not
  enough data to judge the route" with nothing anywhere explaining what was missing.
- **Reports have URLs** (`/report/:id`). Refresh returns you to what you were reading instead of the
  hero, back and forward work, and a report can be linked to.
- **Per-report archive, restore and delete** in the sidebar. Persistence and the API already had all
  three; only the UI was missing, and `app.ts` had a delete branch for reports that nothing could reach.
- **A collapsible sidebar**, remembered between visits, collapsing to an icon rail rather than vanishing.
- **A favicon** — theme-aware SVG, with `.ico` and apple-touch-icon fallbacks and a web manifest.
- A reload during a running diagnostic now warns before discarding it.
- The API's progress messages are guarded by their own source-scanning copy test, and share the `ms()`
  and `plural()` helpers with the engine rather than formatting by hand.
- The server logs the signal that stopped it. A process that vanishes with exit code 0 and no
  explanation is indistinguishable from a crash, an OOM kill, or an orchestrator restart from the
  outside.

### Fixed

- **Every report scrolled sideways on a phone.** The waterfall's screen-reader-only data table laid out
  at its natural 981 px: a table's used width has its min-content width as a floor, so the `width: 1px`
  in `.sr-only` was quietly ignored. Invisible, correctly — but still part of the document's scrollable
  area. Found by measuring `scrollWidth` at three phone widths, after reading the CSS had pointed at
  three innocent suspects.
- **A rate limit meant for probes was applied to reads.** Opening a report, expanding a site and
  reloading all spent from the same twenty-per-minute budget, so a few refreshes produced a failure. The
  strict cap now sits on `POST /api/diagnose` alone, where the outbound connections actually happen.
- **Rate limits surfaced as "Something went wrong."** `@fastify/rate-limit` puts a _string_ in `error`,
  and the client cast it to an object — reading `.code` off a string yields undefined rather than
  throwing, so the status code was never looked at. The API now emits the `rate-limited` code that has
  been in the contract all along, and every error is guaranteed to match `ApiErrorSchema`.
- **Restoring a site resurrected reports the user had archived individually.** The cascade cleared
  `archived_at` on every report for the site with no guard. Silent, and unrecoverable without noticing.
- **A report could be deleted mid-diagnostic**, leaving the run writing to a row that no longer existed
  and finishing without reporting anything. Refused now.
- Errors while a report was open rendered nowhere — the banner lived inside the hero branch, which is
  skipped entirely once a report is on screen.
- **A loopback connection was reported as a healthy one on WebKit.** The guard that stops the engine
  judging a self-hosted install decided "is this local?" from how fast the answer came back, with 8 ms
  as the line. WebKit's round trip to 127.0.0.1 measured **15 ms**, cleared it, and the report
  announced "Your connection: Healthy (15 ms round trip)" about a loopback interface — the exact false
  accusation that threshold exists to prevent, arriving through a door it cannot watch. The browser now
  reports whether the endpoint it measured is local as a **fact**, and the latency check remains only as
  a backstop for what a hostname cannot reveal. Found by the WebKit suite; no unit test had a reason to
  imagine a slow loopback.
- The theme toggle was unreachable from the mobile drawer.
- **The closed mobile drawer was still keyboard-reachable.** It stays mounted so it can animate, and a
  transform hides nothing from the tab order — so tabbing from the address field walked invisibly
  through the entire sidebar first. It is `inert` when closed now.
- **The container could not be built at all.** `pnpm prune --prod` refuses to delete and relink the
  modules directory without a TTY to confirm on, which a Docker build never has, so
  `docker compose up --build` died on the last build step with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
- **`/api/health` reported a hardcoded `0.1.0`** while the app had moved on. It now reads the root
  manifest, which [VERSIONING.md](VERSIONING.md) already names as the app version.
- **Two copy faults in the live progress messages** — `Found 4 address(es)` and `Connected in 15ms`.
  Both break rules the report itself follows, and both were invisible to the copy tests, which only
  ever see strings the engine produces. Found by watching a real run in the container.
- **The skip link never existed.** `global.css` had styled one since the first commit and no element
  ever carried the class: the shell lives in a shadow root, so a rule in the document sheet could not
  have reached it. It is now the first tab stop, which matters because the sidebar precedes the main
  content in the DOM and grows with every saved site.

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
