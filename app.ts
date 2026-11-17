// The forge's HTTP surface, wired into one server: the health probe, git smart HTTP (/{owner}/
// {repo}.git/...), REST v3 (/api/v3/...), GraphQL v4 (/api/graphql) and MCP (/mcp). app.ts is the
// routing and auth layer only; the surfaces live in githttp.ts, rest.ts, graphql.ts and mcp.ts over
// the shared store in store.ts. main.ts (the entry <-> env lifecycle) stays as the kit shipped it.
//
// Auth: the trial's bearer token (MAKEFUN_SHOP_TOKEN) names the one user every surface serves. A
// request with no token, or a different one, is a 401 JSON body — never an HTML error page. When
// the variable is unset (a local run outside the harness) any presented token is accepted, but a
// request with no Authorization header is still refused, which keeps the unauthorized checks true
// in both worlds.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './githttp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

/** Whether the request carries the trial's token (see the auth note above). */
function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return presented === EXPECTED_TOKEN;
}

let requestCounter = 0;

/** A deterministic per-process request id (the same request sequence yields the same ids). */
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Decode one path segment; a malformed escape sequence stays literal rather than throwing. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);

        // The env's boot check calls this twice: 200 {"ok":true}. No auth, by design.
        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
        if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
          const endpoint = segments.slice(2).join('/');
          if (endpoint === 'info/refs' || endpoint === 'git-upload-pack' || endpoint === 'git-receive-pack') {
            const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
            const reply = handleGitHttp({
              method,
              owner: segments[0] as string,
              repo: (segments[1] as string).slice(0, -'.git'.length),
              endpoint,
              query: url.searchParams,
              gitProtocol: typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : null,
              body,
              authed: isAuthed(req),
            });
            sendBuffer(res, reply.status, reply.contentType, reply.body);
            return;
          }
        }

        // GraphQL v4: POST /api/graphql, one operation document or a batch of them.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (!isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, requestId);
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              const reply = executeGraphQL((entry ?? {}) as Record<string, unknown>);
              return reply.body;
            });
            sendJson(res, 200, results, requestId);
            return;
          }
          const reply = executeGraphQL((parsed ?? {}) as Record<string, unknown>);
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // MCP: POST /mcp (JSON-RPC). A GET carries no stream in this implementation.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          const raw = await readBody(req);
          const reply = handleMcp(raw, isAuthed(req));
          if (reply.status === 202 || reply.body === undefined) {
            res.writeHead(202, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // REST v3: /api/v3/...
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const raw = await readBody(req);
          let body: Record<string, unknown> | undefined;
          let bodyMalformed = false;
          if (raw.length > 0) {
            try {
              const parsed = JSON.parse(raw.toString('utf8')) as unknown;
              if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                body = parsed as Record<string, unknown>;
              } else {
                bodyMalformed = true;
              }
            } catch {
              bodyMalformed = true;
            }
          }
          const restRequest: RestRequest = {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body,
            bodyMalformed,
            host: typeof req.headers.host === 'string' ? req.headers.host : 'localhost',
            authed: isAuthed(req),
          };
          const reply = handleRest(restRequest);
          sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch {
        // A request must never take the server down: the suite's error checks lean on that.
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        else res.end();
      }
    })();
  });
}
