/**
 * Runtime configuration, all overridable by environment variable.
 *
 * Defaults are chosen so that `docker compose up` — or plain `pnpm dev` — works
 * with no configuration at all, which is the whole point of a self-hosted tool.
 */

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const list = (value: string | undefined, fallback: readonly string[]): string[] =>
  value === undefined || value.trim() === ''
    ? [...fallback]
    : value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

export interface Config {
  port: number;
  host: string;
  authMode: 'none' | 'password' | 'multiuser';
  password: string | null;
  databasePath: string;
  /**
   * Explicit DNS resolvers. Never the system resolver: during development the
   * host's was a local proxy on 127.0.0.1 that refused queries outright, while
   * public resolvers worked. Measurements must not depend on where the container
   * happens to run.
   */
  resolvers: string[];
  /** Repeated TTFB samples. More is more reliable but slower and rude to the target. */
  stabilitySamples: number;
  timeouts: {
    dnsMs: number;
    connectMs: number;
    tlsMs: number;
    httpMs: number;
    totalMs: number;
  };
  limits: {
    maxRedirects: number;
    maxResponseBytes: number;
    /**
     * Probes per minute per client IP.
     *
     * Scoped to POST /api/diagnose alone. This is the only route that opens
     * outbound connections to a stranger-supplied address, so it is the only one
     * where the abuse potential justifies a limit this tight. Applying it to
     * reads as well meant an ordinary page reload could exhaust the budget meant
     * for probes and surface as a generic failure.
     */
    rateLimitPerMinute: number;
    /** Every other route, per client IP. A backstop against a runaway client, not a probe limit. */
    readsPerMinute: number;
  };
  corsOrigins: string[];
  /**
   * Where the browser measures its latency baseline, when it must not be here.
   *
   * The "your connection" and "the path between" vantages compare the browser's
   * round trip to this service against its round trip to the target. Self-hosted
   * on your own machine that baseline is loopback — 1-5ms, and no reflection of
   * anyone's internet — so the engine correctly refuses to judge either.
   *
   * Point this at another instance of this app reachable across the internet and
   * the browser measures against that instead, which gives both vantages a real
   * baseline. Null, the default, means same-origin: the honest local behaviour of
   * reporting "not measured" rather than a flattering number.
   *
   * The server never fetches this. Only the browser does, so it opens no SSRF
   * surface here.
   */
  controlUrl: string | null;
  logLevel: string;
}

/**
 * Validates CONTROL_URL at boot rather than letting the browser fail on it later.
 *
 * A typo here would otherwise surface as every client vantage silently reading
 * "not measured", which is indistinguishable from the default local behaviour —
 * exactly the sort of misconfiguration that costs an hour to spot.
 */
function controlOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`CONTROL_URL must be an absolute URL (got "${value}")`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`CONTROL_URL must be http or https (got "${parsed.protocol}")`);
  }

  // Stored as a bare origin: the browser appends /api/ping, and a trailing path
  // or query on the configured value would produce a URL that 404s.
  return parsed.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = (env.AUTH_MODE ?? 'none') as Config['authMode'];

  if (!['none', 'password', 'multiuser'].includes(authMode)) {
    throw new Error(`AUTH_MODE must be none, password or multiuser (got "${authMode}")`);
  }

  const password = env.AUTH_PASSWORD ?? null;
  if (authMode === 'password' && (password === null || password.length === 0)) {
    // Failing loudly at boot beats silently serving an unprotected instance to
    // someone who believed they had turned authentication on.
    throw new Error('AUTH_MODE=password requires AUTH_PASSWORD to be set.');
  }

  return {
    port: num(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    authMode,
    password,
    databasePath: env.DATABASE_PATH ?? './data/dwc.db',
    resolvers: list(env.DNS_RESOLVERS, ['1.1.1.1', '8.8.8.8', '9.9.9.9']),
    stabilitySamples: num(env.STABILITY_SAMPLES, 5),
    timeouts: {
      dnsMs: num(env.TIMEOUT_DNS_MS, 5_000),
      connectMs: num(env.TIMEOUT_CONNECT_MS, 8_000),
      tlsMs: num(env.TIMEOUT_TLS_MS, 8_000),
      httpMs: num(env.TIMEOUT_HTTP_MS, 15_000),
      totalMs: num(env.TIMEOUT_TOTAL_MS, 45_000),
    },
    limits: {
      maxRedirects: num(env.MAX_REDIRECTS, 10),
      maxResponseBytes: num(env.MAX_RESPONSE_BYTES, 5_000_000),
      rateLimitPerMinute: num(env.RATE_LIMIT_PER_MINUTE, 20),
      readsPerMinute: num(env.READS_PER_MINUTE, 600),
    },
    corsOrigins: list(env.CORS_ORIGINS, ['http://localhost:5173', 'http://localhost:4173']),
    controlUrl: controlOrigin(env.CONTROL_URL),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
