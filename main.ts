// SPDX-License-Identifier: MIT
// Plain JavaScript keeps the required main.ts runnable without type stripping.
function reportFailure(context, error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[forge] ${context}: ${detail}`);
  process.exitCode = 1;
}

function validateStartup() {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    let url;
    try { url = new URL(envUrl); }
    catch { throw new Error('MAKEFUN_ENV_URL must be an absolute HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('MAKEFUN_ENV_URL must use HTTP or HTTPS without URL credentials.');
    }
  } else if (process.env.FORGE_PORT !== undefined) {
    const value = process.env.FORGE_PORT;
    const port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port > 65535) {
      throw new Error('FORGE_PORT must be an integer from 0 to 65535.');
    }
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? process.env.FORGE_TOKEN ?? 'development-token';
  if (!token.trim()) throw new Error('The configured forge token must not be empty.');
}

function manageServer(server) {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Finish active requests, then bound shutdown for stalled connections.
    const deadline = setTimeout(() => server.closeAllConnections(), 10000);
    deadline.unref();
    server.close(() => clearTimeout(deadline));
  };
  const onSignal = signal => {
    console.error(`[forge] ${signal}: closing server`);
    shutdown();
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  process.once('SIGTERM', onTerm);
  process.once('SIGINT', onInt);
  server.on('error', error => {
    reportFailure('server error', error);
    shutdown();
  });
  server.once('close', () => {
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
  });
}

Promise.resolve().then(() => {
  validateStartup();
  return import('./server.mjs');
}).then(({ startServer }) => manageServer(startServer())).catch(error => {
  reportFailure('startup failed', error);
});
