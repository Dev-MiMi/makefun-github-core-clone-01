// SPDX-License-Identifier: MIT
// A CommonJS entrypoint works with Node 22 builds that lack type stripping.
import('./server.mjs').then(({ startServer }) => startServer()).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
