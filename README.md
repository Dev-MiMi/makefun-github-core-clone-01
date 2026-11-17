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

In a make.fun trial, `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` activate ephemeral startup, registration, health checks, and completion polling automatically. All state is in memory for the lifetime of the process. No installation or Git executable is required.

## Tests

```sh
node --test test/forge.test.mjs
```
