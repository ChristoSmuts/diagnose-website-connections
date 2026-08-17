import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const app = await buildServer({ config });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { authMode: config.authMode, database: config.databasePath, resolvers: config.resolvers },
    'diagnostics engine ready',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}

// Without this a container stop waits for the full timeout before the process dies.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
