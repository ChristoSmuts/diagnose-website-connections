import { loadConfig } from './config.ts';
import { loadDotEnv } from './env.ts';
import { buildServer } from './server.ts';

// Loaded before loadConfig, which takes its snapshot of process.env at call time.
const envFile = loadDotEnv();
const config = loadConfig();
const app = await buildServer({ config });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      authMode: config.authMode,
      database: config.databasePath,
      resolvers: config.resolvers,
      // Named so an operator who edited the wrong file can see which one applied.
      envFile: envFile ?? 'none',
    },
    'diagnostics engine ready',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}

// Without this a container stop waits for the full timeout before the process dies.
//
// The signal is logged because a self-hosted operator otherwise sees a process
// that vanished with exit code 0 and no explanation — indistinguishable from a
// crash, an orchestrator restart, or an OOM kill from the outside.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

// Nothing below should ever fire. If it does, the reason is worth having.
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  process.exit(1);
});
process.on('beforeExit', (code) => {
  app.log.warn({ code }, 'event loop emptied — the server is no longer listening');
});
