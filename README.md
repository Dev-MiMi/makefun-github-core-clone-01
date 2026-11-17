# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Dev-MiMi/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Dev-MiMi/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A dependency-free GitHub-compatible forge in one Node.js process. It shares real Git objects and repository state across smart HTTP Git, REST v3, GraphQL, and MCP.

## Run it

```sh
FORGE_PORT=3000 FORGE_TOKEN=development-token node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=pjp61cd9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

The server binds `0.0.0.0`. Without `FORGE_PORT` it selects an ephemeral port and prints it. `FORGE_OWNER` optionally sets the development login. Authenticate API and Git requests with the configured token.

In a make.fun trial, `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` activate ephemeral startup, registration, health checks, and completion polling automatically. All state is in memory for the lifetime of the process. Node.js 22 runs the committed standard-library `.mjs` runtime directly; no installation or Git executable is required.

Startup validates the local port, environment URL, and token before opening the server. Port 8080 is reserved and selects an ephemeral port instead. SIGINT and SIGTERM stop accepting requests, allow active requests to finish for up to ten seconds, and cancel completion polling when the server closes. Startup and server failures print a diagnostic and exit unsuccessfully.

## Readable sources and build

The root `domain.ts`, `git.ts`, `graphql.ts`, `api.ts`, and `server.ts` are the build sources. They were restored from the original recorded source writes after the original Babel compilation removed them. Restoration recovers earlier authored code; it is not a new implementation. Recorded fixes made to the runtime after compilation have been synchronized back into these sources. This recovery also adds bounded Git inflation buffers, HTTP framing and response-length improvements, and startup and shutdown handling in `main.ts`.

The required `main.ts` entrypoint deliberately contains plain JavaScript so Node 22 builds without TypeScript stripping can run it. It loads `server.mjs`; Babel is used only at build time. Edit the readable sources, then regenerate the committed runtime:

```sh
node build.mjs
node build.mjs --check
```

The build requires locally available `@babel/core` 7.20.12 and `@babel/plugin-transform-typescript` 7.20.13 (the restoration used the existing system packages). It performs no install and reads no Babel project configuration. `--check` compares every generated `.mjs` byte with the committed runtime files and fails on drift; it does not rewrite files.

## Tests

```sh
node --test test/*.test.mjs
```
