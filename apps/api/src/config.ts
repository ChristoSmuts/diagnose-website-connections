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
    : value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

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
    /** Probes per minute per client IP. */
    rateLimitPerMinute: number;
  };
  corsOrigins: string[];
  logLevel: string;
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
    },
    corsOrigins: list(env.CORS_ORIGINS, ['http://localhost:5173', 'http://localhost:4173']),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
