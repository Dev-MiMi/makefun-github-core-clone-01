import { createServer } from 'node:http';
import { Store, ApiError } from './domain.mjs';
import { rest, mcp } from './api.mjs';
import { graphql } from './graphql.mjs';
import { handleGit } from './git.mjs';
function authorized(header, token) {
  if (header === `Bearer ${token}` || header === `token ${token}`) return true;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const separator = decoded.indexOf(':');
    return separator >= 0 && decoded.slice(separator + 1) === token;
  }
  return false;
}
export function createHandler(store, token) {
  let requestNumber = 0;
  return async (req, res) => {
    res.setHeader('X-GitHub-Request-Id', String(++requestNumber));
    const send = (status, body, headers = {}, serialized) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        ...headers
      });
      res.end(serialized ?? (body === undefined ? '' : JSON.stringify(body)));
    };
    try {
      let url;
      try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
      catch { throw new ApiError(400, 'Invalid request URL'); }
      if (url.pathname === '/healthz' && req.method === 'GET') {
        send(200, {
          ok: true
        });
        return;
      }
      if (!authorized(req.headers.authorization, token)) {
        send(401, {
          message: 'Requires authentication'
        });
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new ApiError(413, 'Request too large');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (handleGit(store, req, res, url, bytes)) return;
      let body = {};
      if (bytes.length) {
        try {
          body = JSON.parse(bytes.toString());
        } catch {
          if (url.pathname === '/mcp') {
            send(400, {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32700,
                message: 'Parse error'
              }
            });
            return;
          }
          throw new ApiError(400, 'Malformed JSON');
        }
      }
      if (url.pathname === '/api/graphql') {
        if (req.method !== 'POST') throw new ApiError(404, 'Not Found');
        send(200, graphql(store, body));
        return;
      }
      const result = url.pathname === '/mcp' ? mcp(store, body, req.method) : rest(store, req.method ?? 'GET', url, body);
      send(result.status, result.body, result.headers, result.serialized);
    } catch (err) {
      if (!res.headersSent) send(err instanceof ApiError ? err.status : 500, {
        message: err instanceof Error ? err.message : 'Internal server error'
      });else res.end();
    }
  };
}
export function startServer() {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? process.env.FORGE_TOKEN ?? 'development-token';
  if (process.env.FORGE_OWNER) {
    store.viewer = process.env.FORGE_OWNER;
    store.ownerBound = true;
  }
  const server = createServer(createHandler(store, token));
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  const envUrl = process.env.MAKEFUN_ENV_URL;
  const requestedPort = envUrl ? 0 : Number(process.env.FORGE_PORT ?? 0);
  server.listen(requestedPort === 8080 ? 0 : requestedPort, '0.0.0.0', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    console.log(`forge listening on ${address.port}`);
    if (!envUrl) return;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    };
    try {
      const registration = await fetch(`${envUrl.replace(/\/$/, '')}/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          port: address.port
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
      while (true) {
        try {
          const r = await fetch(`${envUrl.replace(/\/$/, '')}/done`, {
            headers,
            signal: AbortSignal.timeout(30000)
          });
          const result = await r.json();
          if (result.done === true) {
            server.close();
            server.closeAllConnections();
            process.exit(0);
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });
  return server;
}
