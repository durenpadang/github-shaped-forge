// The forge's process entry: one HTTP listener serving git smart HTTP, REST v3, GraphQL v4 and MCP.
import { createApp } from './app.ts';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const server = createApp();

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`forge listening on ${port}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}