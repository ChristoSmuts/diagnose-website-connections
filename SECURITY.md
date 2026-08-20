# Security

## Reporting a vulnerability

Please report privately rather than opening a public issue — open a
[GitHub security advisory](https://docs.github.com/code-security/security-advisories/guiding-contributors-to-report-security-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Expect an acknowledgement within a few days.

Include what you tried, what happened, and what you expected. A URL that reaches somewhere it should
not is the most valuable single thing you can send.

## The threat model

This service accepts a URL from an untrusted user and connects to it. That is **server-side request
forgery by design**, and it is the primary risk. A self-hosted instance typically sits inside a
private network, so a successful bypass reaches exactly the things that matter: internal admin panels,
databases, and cloud instance-metadata endpoints.

### What is in place

- Only `http` and `https` schemes are accepted.
- Names are **resolved first**, then **every returned address** is validated against a denylist
  covering loopback, RFC1918, link-local, unique-local, and cloud metadata (`169.254.169.254`).
- The validated IP is **pinned** for the actual connection. This closes the window between checking
  and connecting, which is what DNS rebinding exploits.
- Every redirect hop is re-validated before it is followed. Redirects are followed manually, one at a
  time, for this reason.
- Redirect count, response size and total duration are capped; requests are rate-limited per client IP.
- The container runs as a non-root user with `no-new-privileges`.

### Two bypasses already found and fixed

Recorded because both are easy to reintroduce:

1. **Bracketed IPv6 literals.** `URL.hostname` returns `[::1]` for an IPv6 literal, and Node's
   `isIP()` does not recognise the bracketed form — so the address was treated as a hostname and
   skipped the denylist entirely. Brackets must be stripped before validating.
2. **Global `fetch` bypassing IP pinning.** `fetch` performs its own DNS resolution, so the pinned
   address was discarded and DNS rebinding was reopened. `apps/api/src/probes/http.ts` is built on
   `node:https` with an explicit pinned `lookup` for this reason and must not be replaced with `fetch`.

### Known limitation

`AUTH_MODE=multiuser` is **not implemented**. The server starts and then refuses every authenticated
request, so it fails closed rather than silently allowing access — but nothing behind it works.
`AUTH_MODE=none` is the default and is appropriate only for an instance you alone can reach.
**Set `AUTH_MODE=password` with `AUTH_PASSWORD` before exposing an instance to the internet.**

`AUTH_MODE=password` is one shared secret, not user accounts. Everyone who signs in resolves to the
same principal and therefore shares one report history — which is fine for a handful of testers and is
not privacy between them. Two properties of the session are worth stating plainly rather than leaving
to be discovered:

- The cookie is a reversible encoding of the password, not a hash or a signed token. Anyone who obtains
  it recovers the password. It is `HttpOnly`, and `Secure` whenever the request arrived over TLS.
- There is no rotation and no revocation short of changing `AUTH_PASSWORD`, which signs everyone out.

Signed sessions would fix both and are deliberately not in scope yet; the shared secret is already the
weakest link, and hashing what is derived from it would protect nothing that is not already shared.

## Deploying safely

- Do not expose an instance publicly with `AUTH_MODE=none`.
- Run it where it cannot reach anything you would mind it reaching — a DMZ or an egress-filtered
  network is the right place for something that connects to attacker-supplied URLs.
- Keep the image current: the probe engine's value depends on the platform's TLS stack, so an outdated
  base image degrades both security and accuracy.

## Scope

In scope: SSRF and denylist bypasses, authentication bypass, injection in the persistence layer,
anything letting one `Principal` read another's data.

Out of scope: findings that require an attacker to already control the host; the deliberate absence of
authentication under `AUTH_MODE=none`; rate limits being tuneable.
