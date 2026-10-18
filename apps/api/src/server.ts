import { createApp } from './app.js';
import { configuration } from './config.js';

const config = configuration();
const { app } = await createApp({
  ...config,
  logger: {
    level: 'info',
    redact: ['req.headers.authorization', 'req.body', 'res.headers'],
  },
});
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  console.error('API startup failed. Check configuration and database access.');
  await app.close();
  process.exitCode = 1;
}
