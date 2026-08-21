import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CreateSiteRequestSchema,
  ListSitesQuerySchema,
  StartDiagnosticRequestSchema,
  SubmitClientEvidenceRequestSchema,
  UpdateSiteRequestSchema,
  type DiagnosticEvent,
  type Evidence,
  type Principal,
} from '@dwc/contracts';
import { analyse } from '@dwc/diagnostics';
import {
  openDatabase,
  DuplicateSiteError,
  RunningReportError,
  type Repositories,
} from '@dwc/persistence';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
// The app version lives in the root manifest (see VERSIONING.md). Reading it here
// rather than repeating the literal is what stops /api/health quietly reporting a
// version the deployment stopped being months ago — it had already drifted once.
import rootManifest from '../../../package.json' with { type: 'json' };
import type { Config } from './config.ts';
import { detectEdge } from './edge.ts';
import { resolvePrincipal, expectedToken, matchesToken } from './principal.ts';
import { probeIcon } from './probes/icon.ts';
import { runServerProbe } from './probes/run.ts';
import { BlockedTargetError, InvalidUrlError, normalizeUrl } from './safety/ssrf.ts';

export interface BuildOptions {
  config: Config;
  /** Injectable so tests can use an in-memory database. */
  repositories?: Repositories;
}

export async function buildServer(options: BuildOptions): Promise<FastifyInstance> {
  const { config } = options;
  const repos = options.repositories ?? openDatabase({ path: config.databasePath });

  const app = Fastify({
    logger: { level: config.logLevel },
    // Off unless configured. See TRUST_PROXY in config.ts for why the default
    // matters: with it on and nothing in front, a client can pick its own
    // rate-limit bucket.
    trustProxy: config.trustProxy,
    // Diagnostics legitimately take tens of seconds; the default would abort
    // a perfectly healthy probe mid-flight.
    requestTimeout: config.timeouts.totalMs + 15_000,
  });

  /*
   * Compress the app, never the measurements.
   *
   * 276 KB of JavaScript was going over the wire uncompressed whenever nothing
   * was in front of the container — and the container should not depend on what
   * is. `/api/download` opts out explicitly: it sends incompressible bytes with
   * `content-encoding: identity` on purpose, because the point is to measure the
   * link rather than a compressor.
   */
  await app.register(compress, {
    global: true,
    encodings: ['br', 'gzip', 'deflate'],
    threshold: 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  /*
   * The global limit is a backstop, not the probe limit.
   *
   * Probing sends traffic to third parties on a stranger's behalf, so that
   * deserves a tight per-IP cap — but it was applied to every route, reads
   * included. Opening a report, expanding a site and reloading the page all spent
   * from the same twenty-per-minute budget, and a few refreshes while testing was
   * enough to exhaust it. The strict limit now sits on POST /api/diagnose alone,
   * where the outbound connections actually happen.
   */
  await app.register(rateLimit, {
    max: config.limits.readsPerMinute,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    /*
     * Without this the plugin sends {statusCode, error: "Too Many Requests",
     * message} — where `error` is a string, not the {code, message} object every
     * other response uses. The web client read `body.error.code` off a string,
     * got undefined, and rendered "Something went wrong." for what was really a
     * rate limit. `rate-limited` has been in ApiErrorSchema all along, unemitted.
     */
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: {
        code: 'rate-limited' as const,
        message: `Too many requests. Try again in ${context.after}.`,
        retryAfter: Math.ceil(context.ttl / 1000),
      },
    }),
  });

  /*
   * Guarantees every error matches ApiErrorSchema.
   *
   * Route handlers were careful, but anything thrown outside one — a plugin, a
   * schema failure, an unexpected throw — fell through to Fastify's default
   * serializer and produced a shape the client cannot read. One contract for
   * errors is worth more than five careful call sites.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    // Already in our shape (the rate limiter builds its own): pass it through.
    // @fastify/rate-limit throws whatever errorResponseBuilder returns, so this
    // arrives carrying an `error` object rather than being a plain FastifyError.
    const carried = (error as unknown as { error?: unknown }).error;
    if (typeof carried === 'object' && carried !== null) {
      return reply.status(status).send({ error: carried });
    }

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled request failure');
      return reply.status(status).send({
        error: { code: 'internal', message: 'Something went wrong running that check.' },
      });
    }

    return reply.status(status).send({
      error: { code: 'invalid-url', message: error.message },
    });
  });

  app.addHook('onClose', () => {
    if (options.repositories === undefined) repos.close();
  });

  // --- helpers -------------------------------------------------------------

  const requirePrincipal = (request: FastifyRequest, reply: FastifyReply): Principal | null => {
    const principal = resolvePrincipal(config, request);
    if (principal === null) {
      void reply.status(401).send({
        error: { code: 'unauthorized', message: 'Sign in to use this instance.' },
      });
      return null;
    }
    return principal;
  };

  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof InvalidUrlError) {
      return reply.status(400).send({ error: { code: 'invalid-url', message: error.message } });
    }
    if (error instanceof BlockedTargetError) {
      return reply.status(400).send({ error: { code: 'blocked-target', message: error.message } });
    }
    if (error instanceof DuplicateSiteError) {
      return reply.status(409).send({ error: { code: 'invalid-url', message: error.message } });
    }
    if (error instanceof RunningReportError) {
      return reply.status(409).send({ error: { code: 'invalid-url', message: error.message } });
    }
    app.log.error({ err: error }, 'unhandled request failure');
    return reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong running that check.' },
    });
  };

  // --- health & control endpoints ------------------------------------------

  /*
   * Deployment facts the browser needs before it can measure anything.
   *
   * `controlUrl` belongs here rather than in its own endpoint for the same reason
   * `authMode` does: both answer "how is this instance set up", both are read
   * once at startup, and neither is worth a second round trip.
   */
  app.get('/api/health', { config: { rateLimit: false } }, (request) => ({
    status: 'ok' as const,
    version: rootManifest.version,
    authMode: config.authMode,
    controlUrl: config.controlUrl,
    /*
     * Whether the browser's connection to us ended at a CDN edge.
     *
     * The browser cannot work this out for itself — from out there a
     * CDN-fronted instance and a directly-reachable one look identical — so the
     * endpoint that received the request has to say. It decides the route
     * verdict, which is why this rides along with the other deployment facts
     * rather than being inferred from a timing.
     */
    edgeTerminated: config.edgeTerminated ?? detectEdge(request.headers),
    /** Third-party endpoints the browser should time. Empty unless configured. */
    referenceUrls: config.referenceUrls,
  }));

  /**
   * The control endpoint the entire attribution rests on.
   *
   * It must do as close to zero work as possible: any latency the browser
   * measures here is the network rather than us, which is precisely what makes
   * it usable as a baseline for the user's connection.
   */
  app.get('/api/ping', { config: { rateLimit: false } }, (_request, reply) => {
    void reply.header('cache-control', 'no-store').send({ t: Date.now() });
  });

  /*
   * Deterministic payload for the browser's download throughput test.
   *
   * Authenticated and rate-limited, unlike its neighbours. `/api/ping` and
   * `/api/health` stay open because they are tiny and because a paired instance
   * is queried by a browser holding no session with it — this one hands out up to
   * 8 MB per call, which on a metered free tier is a bandwidth cannon anyone
   * could point at the host. The browser running a probe holds the cookie, so
   * the throughput test is unaffected.
   */
  app.get(
    '/api/download',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' }, compress: false } },
    (request, reply) => {
      const principal = requirePrincipal(request, reply);
      if (principal === null) return reply;

      const query = request.query as { bytes?: string };
      const requested = Number(query.bytes ?? 1_000_000);
      // Capped: this is the user's bandwidth being spent.
      const size = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 1), 8_000_000);

      return (
        reply
          .header('content-type', 'application/octet-stream')
          .header('cache-control', 'no-store')
          // Incompressible, so we measure the link rather than the compressor.
          .header('content-encoding', 'identity')
          .send(Buffer.allocUnsafe(size))
      );
    },
  );

  app.post(
    '/api/upload',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    (request, reply) => {
      const principal = requirePrincipal(request, reply);
      if (principal === null) return reply;
      return reply.header('cache-control', 'no-store').send({ received: true, at: Date.now() });
    },
  );

  /*
   * Ten attempts a minute, not six hundred.
   *
   * This route was covered only by the global read limit, which is sized for
   * page loads. A shared password behind a 600-a-minute budget is a password
   * that can be worked through.
   */
  app.post(
    '/api/session',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    (request, reply) => {
      if (config.authMode !== 'password') {
        return reply.status(400).send({
          error: { code: 'invalid-url', message: 'This instance does not use a password.' },
        });
      }
      const body = request.body as { password?: string };
      if (
        typeof body.password !== 'string' ||
        !matchesToken(body.password, config.password ?? ' ')
      ) {
        return reply
          .status(401)
          .send({ error: { code: 'unauthorized', message: 'That password is not correct.' } });
      }

      /*
       * Secure only when the request actually arrived over TLS.
       *
       * Setting it unconditionally would break a plain-HTTP instance on a trusted
       * network, since the browser would refuse to store the cookie and the login
       * would appear to succeed and then silently fail. `request.protocol` reads
       * X-Forwarded-Proto only when TRUST_PROXY is on, which is exactly when a
       * reverse proxy is the thing terminating TLS.
       */
      const secure = request.protocol === 'https' ? ' Secure;' : '';
      return reply
        .header(
          'set-cookie',
          `dwc_session=${expectedToken(config)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=2592000`,
        )
        .send({ ok: true });
    },
  );

  // --- sites ---------------------------------------------------------------

  app.get('/api/sites', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const query = ListSitesQuerySchema.parse(request.query);
    return reply.send({ sites: repos.sites.list(principal.id, query.include) });
  });

  app.post('/api/sites', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    try {
      const body = CreateSiteRequestSchema.parse(request.body);
      const target = normalizeUrl(body.url);
      const site = repos.sites.create({
        principalId: principal.id,
        url: target.normalizedUrl,
        label: body.label ?? target.host,
        tags: body.tags,
      });
      return reply.status(201).send({ site });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.patch('/api/sites/:id', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    const body = UpdateSiteRequestSchema.parse(request.body);
    const site = repos.sites.update(principal.id, id, body);

    return site === null ? notFound(reply) : reply.send({ site });
  });

  app.post('/api/sites/:id/archive', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    const site = repos.sites.archive(principal.id, id);
    return site === null ? notFound(reply) : reply.send({ site });
  });

  app.post('/api/sites/:id/restore', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    const site = repos.sites.restore(principal.id, id);
    return site === null ? notFound(reply) : reply.send({ site });
  });

  app.delete('/api/sites/:id', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    return repos.sites.hardDelete(principal.id, id) ? reply.status(204).send() : notFound(reply);
  });

  // --- reports -------------------------------------------------------------

  app.get('/api/sites/:id/reports', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    const query = ListSitesQuerySchema.parse(request.query);
    return reply.send({ reports: repos.reports.listForSite(principal.id, id, query.include) });
  });

  app.get('/api/reports/:id', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    const { id } = request.params as { id: string };
    const report = repos.reports.findById(principal.id, id);
    return report === null ? notFound(reply) : reply.send({ report });
  });

  app.post('/api/reports/:id/archive', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;
    const { id } = request.params as { id: string };
    return repos.reports.archive(principal.id, id) ? reply.send({ ok: true }) : notFound(reply);
  });

  app.post('/api/reports/:id/restore', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;
    const { id } = request.params as { id: string };
    return repos.reports.restore(principal.id, id) ? reply.send({ ok: true }) : notFound(reply);
  });

  app.delete('/api/reports/:id', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;
    const { id } = request.params as { id: string };
    try {
      return repos.reports.hardDelete(principal.id, id)
        ? reply.status(204).send()
        : notFound(reply);
    } catch (error) {
      // RunningReportError: a diagnostic is still streaming into this row.
      return fail(reply, error);
    }
  });

  // --- the diagnostic itself, streamed -------------------------------------

  /**
   * Run a diagnostic, streaming progress as Server-Sent Events.
   *
   * Streaming rather than one blocking response because a full probe genuinely
   * takes several seconds — watching it progress is far better than staring at
   * a spinner, and it lets the UI render each section as its evidence lands.
   *
   * SSE over WebSockets: the traffic is one-way, and SSE survives proxies and
   * reconnects without any extra machinery.
   */
  app.post(
    '/api/diagnose',
    // The tight per-IP cap lives here, on the one route that opens outbound
    // connections to an address a stranger chose.
    { config: { rateLimit: { max: config.limits.rateLimitPerMinute, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const principal = requirePrincipal(request, reply);
      if (principal === null) return reply;

      let body;
      try {
        body = StartDiagnosticRequestSchema.parse(request.body);
      } catch (error) {
        return fail(reply, error);
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // Nginx buffers SSE into uselessness without this.
        'x-accel-buffering': 'no',
      });

      const send = (event: DiagnosticEvent): void => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      let reportId: string | null = null;

      try {
        const target = normalizeUrl(body.url);

        const site =
          (body.siteId !== undefined
            ? repos.sites.findById(principal.id, body.siteId)
            : repos.sites.findByUrl(principal.id, target.normalizedUrl)) ??
          repos.sites.create({
            principalId: principal.id,
            url: target.normalizedUrl,
            label: target.host,
            tags: [],
          });

        const report = repos.reports.create({ principalId: principal.id, siteId: site.id });
        reportId = report.id;
        send({ type: 'started', reportId: report.id, siteId: site.id });

        const evidence = await runServerProbe(body.url, config, (phase, status, message) => {
          send({ type: 'phase', phase, status, message });
        });

        send({
          type: 'phase',
          phase: 'analysing',
          status: 'started',
          message: 'Working out what it means…',
        });

        // The browser has not reported yet, so the verdict deliberately cannot
        // blame the user's connection. It is revised when client evidence arrives.
        const bundle: Evidence = { server: evidence, additionalVantages: [], client: null };
        const verdict = analyse(bundle);
        const completed = repos.reports.complete(report.id, bundle, verdict);

        send({ type: 'phase', phase: 'analysing', status: 'complete', message: 'Done' });
        if (completed !== null) send({ type: 'complete', report: completed });

        /*
         * Fetch the site's favicon, once, after the verdict is already out.
         *
         * Deliberately after the stream's payload and deliberately unawaited by
         * anything the reader is waiting on: it is decoration, and it must never
         * delay or fail a diagnosis. `needsIcon` keeps it to one attempt per site
         * — a site with no favicon is not worth asking about on every run.
         */
        if (repos.sites.needsIcon(principal.id, site.id)) {
          try {
            const icon = await probeIcon({
              origin: target.normalizedUrl,
              timeoutMs: Math.min(config.timeouts.httpMs, 5_000),
              resolvers: config.resolvers,
            });
            repos.sites.setIcon(principal.id, site.id, icon);
          } catch (error) {
            // Recorded as "looked, found nothing" so it is not retried forever.
            request.log.debug({ err: error }, 'favicon lookup failed');
            repos.sites.setIcon(principal.id, site.id, null);
          }
        }
      } catch (error) {
        const message =
          error instanceof InvalidUrlError || error instanceof BlockedTargetError
            ? error.message
            : 'Something went wrong running that check.';

        if (reportId !== null) {
          try {
            repos.reports.fail(reportId, message);
          } catch {
            // Already finished; the stored record stands.
          }
        }
        app.log.error({ err: error }, 'diagnostic failed');
        send({ type: 'failed', reportId, error: message });
      } finally {
        reply.raw.end();
      }

      return reply;
    },
  );

  /**
   * Merge browser-measured evidence and re-run attribution.
   *
   * This is the step that unlocks the other two verdicts: only with a client
   * baseline can the engine distinguish a slow site from a slow connection.
   */
  app.post('/api/reports/:id/client-evidence', (request, reply) => {
    const principal = requirePrincipal(request, reply);
    if (principal === null) return reply;

    try {
      const body = SubmitClientEvidenceRequestSchema.parse({
        ...(request.body as object),
        reportId: (request.params as { id: string }).id,
      });

      const report = repos.reports.findById(principal.id, body.reportId);
      if (report === null || report.evidence === null) return notFound(reply);

      const merged: Evidence = { ...report.evidence, client: body.client };
      const verdict = analyse(merged);

      /*
       * Saved, so revisiting the report shows what was actually measured.
       *
       * The browser half belongs to this run and cannot start until the server
       * half has answered, so it necessarily arrives after the row is written.
       * Leaving it in memory meant a report that had measured the reader's
       * connection went back to claiming it had not, the moment they clicked away
       * and returned — and the stored verdict is what a re-open, an export and the
       * sidebar's culprit dot all read from.
       *
       * `attachClientEvidence` writes only into the gap where no client evidence
       * exists, so this completes a report and can never rewrite one. A second
       * submission returns null and changes nothing; the revised verdict is still
       * returned for display, because it is correct either way and the caller has
       * no use for the difference.
       */
      repos.reports.attachClientEvidence(principal.id, body.reportId, merged, verdict);

      return reply.send({ verdict, evidence: merged });
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Serve the built web app from the same origin, when it exists.
   *
   * Same-origin is not a convenience here, it is a measurement requirement: the
   * browser times /api/ping to characterise the user's connection, and a
   * cross-origin setup would add a CORS preflight to every one of those samples
   * and inflate the baseline. Bundling both into one container also means
   * self-hosting is a single process with no reverse proxy to configure.
   *
   * Skipped silently in development, where Vite serves the app and proxies /api.
   */
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });

    // SPA fallback: anything not under /api and not a real file gets index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return notFound(reply);
      return reply.sendFile('index.html');
    });
    app.log.info({ webRoot }, 'serving the web app from this process');
  }

  return app;
}

const notFound = (reply: FastifyReply): FastifyReply =>
  reply.status(404).send({ error: { code: 'not-found', message: 'That could not be found.' } });
