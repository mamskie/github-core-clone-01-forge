// Forge HTTP server: routing + auth + body parsing. Surfaces live in git.ts,
// rest.ts, graphql.ts, mcp.ts — all sharing the single store in store.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, VIEWER, FIXED_ISO } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let reqCounter = 0;

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  const h: Record<string, string> = { ...headers };
  if (status !== 204) {
    if (!h['content-type']) h['content-type'] = JSON_TYPE;
    h['content-length'] = String(body.length);
  }
  res.writeHead(status, h);
  if (status === 204) res.end();
  else res.end(body);
}
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendRaw(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers);
}

export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++reqCounter}`;
    const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        let url: URL;
        try { url = new URL(req.url ?? '/', 'http://entry'); } catch { sendJson(res, 404, { message: 'Not Found' }, baseHeaders); return; }
        const path = url.pathname;
        const method = req.method ?? 'GET';
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
        const host = headers['host'] ?? '127.0.0.1';
        const ctx: any = {
          store, token, viewer: VIEWER, requestId, baseUrl: `http://${host}`, nowIso: FIXED_ISO,
          authed: (h: Record<string, string>): boolean => {
            const a = h['authorization'] ?? '';
            if (token === '') return a.startsWith('Bearer ') && a.length > 7;
            return a === `Bearer ${token}`;
          },
        };
        try {
          if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }, baseHeaders); return; }
          const handlers = [handleGit, handleRest, handleGraphQL, handleMcp];
          for (const h of handlers) {
            const out = await h(method, path, url.searchParams, headers, body, ctx);
            if (out) {
              const b = Buffer.isBuffer(out.body) ? out.body : Buffer.from(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? ''), 'utf8');
              sendRaw(res, out.status, b, { ...baseHeaders, ...(out.headers ?? {}) });
              return;
            }
          }
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
        } catch (err) {
          process.stderr.write(`[forge] handler error ${method} ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
          try { sendJson(res, 500, { message: 'Internal Server Error' }, baseHeaders); } catch { /* already sent */ }
        }
      })();
    });
    req.on('error', () => { try { sendJson(res, 400, { message: 'Bad Request' }, baseHeaders); } catch { /* ignore */ } });
  });
}
