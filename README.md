# forge — a GitHub-shaped forge in one Node process

A from-scratch implementation of the four surfaces the conformance kit grades, with no third-party
dependencies, no native git binary, and no external services.

* **git smart HTTP** — pkt-line codec, protocol v2 `ls-refs` and `fetch` (including `shallow`/`deepen`
  and `deepen-since`), protocol v0 `receive-pack` with `report-status`, packfile writer and reader,
  `OFS_DELTA`/`REF_DELTA` resolution, annotated tag advertisement.
* **REST v3** (`/api/v3`) — repositories, branches, contents, commits, trees, issues, comments,
  labels, milestones, pull requests, reviews, merges, search, rate limit.
* **GraphQL v4** (`/api/graphql`) — a small engine with its own selection-set parser, `__type`
  introspection, Relay global ids, cursor connections, and the issue/pull mutations `gh` uses.
* **MCP** (`/mcp`) — JSON-RPC 2.0 with the `initialize` handshake and the six repository tools
  `github-mcp-server` exposes.

State is in memory, seeded from a deterministic scenario, so every process start is a clean forge.

Run it:

```sh
node main.ts    # PORT defaults to 8080
```

License: MIT (see `LICENSE`).