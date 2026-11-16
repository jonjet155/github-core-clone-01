# github-core-clone-01 — Naomi Router Forge

A standalone GitHub-compatible git forge in Node 22, standard library only.
No git binary, no package manager, no outside service, no UI.

## What it implements

- **Git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` protocol v2
  (with `ls-refs`, shallow fetch and filter), `receive-pack` v0. The git
  object model is implemented from scratch: SHA-1, pkt-line, packfiles
  (delta-free writes, REF/OFS delta reads), refs, trees, commits, tags.
- **REST v3** at `/api/v3`: repos, refs, branches, commits, contents
  (create/update/delete with stale-sha 409), labels, issues, comments,
  pull requests (squash merge, conflict detection).
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository`, `node`,
  `__type` introspection, issue/PR connections with cursor pagination,
  and the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations.
- **MCP** at `/mcp`: the 2026-07-28 era via `server/discover` (legacy
  `initialize` as a fallback), with `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` tools acting on the same in-memory store as REST.

## Running

`main.ts` is the entrypoint: it binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls
`$MAKEFUN_ENV_URL/done` until the env says the trial is over and exits 0.
Authentication is `Bearer $MAKEFUN_SHOP_TOKEN` (exact match).

```sh
node main.ts
```

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entrypoint lifecycle (register / poll done). |
| `app.ts` | HTTP server: routing for git, REST, GraphQL, MCP. |
| `store.ts` | In-memory store: repos, refs, objects, issues, PRs, labels. |
| `gitcore.ts` | SHA-1, pkt-line, pack read/write, tree/commit/tag codecs. |
| `gitproto.ts` | Smart-HTTP advertisements, ls-refs, fetch planning, receive-pack. |
| `graphql.ts` | Small GraphQL parser + executor over the store. |
| `mcp.ts` | JSON-RPC 2.0 MCP endpoint and the six tools. |
| `scenario.ts` | Scenario RNG (viewer login `adaiversen`). |

## Determinism

No clock in any stored value: every REST-made commit and every
`merged_at` uses the fixed timestamp `2025-01-01T00:00:00Z`. IDs are
sequential (repos from 5000, issues/comments from 1). Two runs on the
same instance leave the same state export byte for byte.

## License

MIT — see `LICENSE`.
