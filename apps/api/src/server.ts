import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
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
import { openDatabase, DuplicateSiteError, type Repositories } from '@dwc/persistence';
import type { Config } from './config.ts';
import { resolvePrincipal, expectedToken } from './principal.ts';
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
    // Diagnostics legitimately take tens of seconds; the default would abort
    // a perfectly healthy probe mid-flight.
    requestTimeout: config.timeouts.totalMs + 15_000,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.limits.rateLimitPerMinute,
    timeWindow: '1 minute',
    // Probing sends traffic to third parties on a stranger's behalf, so the
    // limit is per-IP and deliberately modest.
    keyGenerator: (request) => request.ip,
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
    app.log.error({ err: error }, 'unhandled request failure');
    return reply.status(500).send({
      error: { code: 'internal', message: 'Something went wrong running that check.' },
    });
  };

  // --- health & control endpoints ------------------------------------------

  app.get('/api/health', () => ({
    status: 'ok' as const,
    version: '0.1.0',
    authMode: config.authMode,
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

  /** Deterministic payload for the browser's download throughput test. */
  app.get('/api/download', { config: { rateLimit: false } }, (request, reply) => {
    const query = request.query as { bytes?: string };
    const requested = Number(query.bytes ?? 1_000_000);
    // Capped: this is the user's bandwidth being spent.
    const size = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 1), 8_000_000);

    void reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'no-store')
      // Incompressible, so we measure the link rather than the compressor.
      .header('content-encoding', 'identity')
      .send(Buffer.allocUnsafe(size));
  });

  app.post('/api/upload', { config: { rateLimit: false } }, (request, reply) => {
    void reply.header('cache-control', 'no-store').send({ received: true, at: Date.now() });
    void request;
  });

  app.post('/api/session', (request, reply) => {
    if (config.authMode !== 'password') {
      return reply.status(400).send({
        error: { code: 'invalid-url', message: 'This instance does not use a password.' },
      });
    }
    const body = request.body as { password?: string };
    if (body.password !== config.password) {
      return reply
        .status(401)
        .send({ error: { code: 'unauthorized', message: 'That password is not correct.' } });
    }
    return reply
      .header(
        'set-cookie',
        `dwc_session=${expectedToken(config)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      )
      .send({ ok: true });
  });

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
    return repos.sites.hardDelete(principal.id, id)
      ? reply.status(204).send()
      : notFound(reply);
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
    return repos.reports.hardDelete(principal.id, id)
      ? reply.status(204).send()
      : notFound(reply);
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
  app.post('/api/diagnose', async (request, reply) => {
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

      send({ type: 'phase', phase: 'analysing', status: 'started', message: 'Working out what it means…' });

      // The browser has not reported yet, so the verdict deliberately cannot
      // blame the user's connection. It is revised when client evidence arrives.
      const bundle: Evidence = { server: evidence, additionalVantages: [], client: null };
      const verdict = analyse(bundle);
      const completed = repos.reports.complete(report.id, bundle, verdict);

      send({ type: 'phase', phase: 'analysing', status: 'complete', message: 'Done' });
      if (completed !== null) send({ type: 'complete', report: completed });
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
  });

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

      // The stored report is immutable, so the revised verdict is returned for
      // display rather than written over the original record.
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
