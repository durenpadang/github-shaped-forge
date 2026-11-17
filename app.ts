// The HTTP surface: one process, one port, four protocols. /api/v3 answers REST, /api/graphql answers
// GraphQL, /mcp answers MCP, /<owner>/<repo>.git answers git's smart HTTP, /healthz answers the probe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { handleRest } from './lib/rest.ts';
import { readBody, sendError, sendJson } from './lib/rest-shapes.ts';
import { handleGit } from './lib/git.ts';
import { handleGraphql } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

/** Split a URL path into decoded segments. */
function segmentsOf(url: string): string[] {
  const path = url.split('?')[0];
  return path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** The whole application: git, REST, GraphQL and MCP behind one listener. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
    const segments = segmentsOf(url);

    const run = async (): Promise<void> => {
      if (segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        await handleGraphql({ req, res, method, segments, query, body: () => readBody(req) });
        return;
      }

      if (segments.length >= 1 && segments[0] === 'mcp') {
        await handleMcp({ req, res, method, segments, query, body: () => readBody(req) });
        return;
      }

      if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
        const handled = await handleRest({ req, res, method, segments, query, body: () => readBody(req) });
        if (!handled) sendError(res, 404, 'Not Found');
        return;
      }

      if (segments.some((s) => s.endsWith('.git')) || (segments.length >= 3 && segments[1].endsWith('.git'))) {
        const handled = await handleGit({ req, res, method, segments, query });
        if (!handled) sendError(res, 404, 'Not Found');
        return;
      }

      sendJson(res, 200, { name: 'forge', protocols: ['git', 'rest', 'graphql', 'mcp'] });
    };

    run().catch((err: unknown) => {
      console.error('unhandled:', err instanceof Error ? err.stack : err);
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
      else res.end();
    });
  });
}

/** The process's entry: bind the port the environment names, or 8080. */
export function main(): void {
  const port = Number(process.env.PORT ?? '8080');
  const app = createApp();
  app.listen(port, '0.0.0.0', () => {
    const address = app.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(`forge listening on ${bound}\n`);
  });
}