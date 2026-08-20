import { timingSafeEqual } from 'node:crypto';
import { LOCAL_PRINCIPAL, type Principal } from '@dwc/contracts';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.ts';

/**
 * Resolve who is making a request.
 *
 * Every route obtains its principal through here and passes it to the
 * repositories, even though the default deployment has exactly one. The
 * indirection costs almost nothing now; adding it later would mean revisiting
 * every query, and missing one would leak another account's data.
 */
export function resolvePrincipal(config: Config, request: FastifyRequest): Principal | null {
  switch (config.authMode) {
    case 'none':
      // Self-hosted single user: the instance is inherently theirs.
      return LOCAL_PRINCIPAL;

    case 'password': {
      // One shared secret, for an instance exposed to the internet.
      const cookie = parseCookies(request.headers.cookie)['dwc_session'];
      return cookie !== undefined && matchesToken(cookie, expectedToken(config))
        ? { id: 'local', name: 'Local', mode: 'password' }
        : null;
    }

    case 'multiuser':
      // Wired up when the multi-user adapter lands; refusing is the safe
      // default rather than silently falling through to an open instance.
      return null;

    default: {
      const exhaustive: never = config.authMode;
      throw new Error(`Unhandled auth mode: ${String(exhaustive)}`);
    }
  }
}

/**
 * Deterministic token derived from the configured password.
 *
 * Deliberately not a hash: the server has to recognise the cookie without
 * storing sessions, and the password is a single shared secret either way, so
 * hashing would protect nothing that is not already shared. It does mean anyone
 * holding the cookie can recover the password, which is why SECURITY.md records
 * it as a limitation and why the cookie is Secure and HttpOnly.
 */
export function expectedToken(config: Config): string {
  return Buffer.from(`dwc:${config.password ?? ''}`).toString('base64url');
}

/**
 * Compare in constant time.
 *
 * `timingSafeEqual` throws on a length mismatch, and the length itself leaks a
 * little, so unequal lengths are rejected up front — a wrong-length guess is not
 * a near miss worth hiding. The point is that a right-length guess reveals
 * nothing about how many leading bytes were correct.
 */
export function matchesToken(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}
