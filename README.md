# github-core-clone — a GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/livermorewayne0106-png/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/livermorewayne0106-png/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A single-process GitHub-compatible forge for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01): git smart HTTP, the REST v3
surface, GraphQL v4, and an MCP endpoint, all over one in-memory store. Node's standard library
only — no dependencies, and no git binary (the grading sandbox has none): the git object model and
wire protocol are implemented in-process.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle from the contest kit, unchanged: the process binds an
ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, answers the env's health checks,
and exits when the env says the trial is done. The forge itself is the app `main.ts` serves.

## Layout

- `main.ts` — the lifecycle (bind, register, wait for done). Kept exactly as the kit ships it.
- `app.ts` — routing and bearer-token auth; dispatches to the four surfaces.
- `gitcore.ts` — the git object model: SHA-1 objects, trees, commits, tags, packfiles (read with
  delta resolution, write plain), reachability, shallow/deepen fetch selection, pkt-line framing.
- `store.ts` — the forge's state: repositories, refs, labels, issues, pull requests, comments;
  contents-API commits, three-way merges, pull-request file diffs. Every timestamp comes from
  `MAKEFUN_TRIAL_NOW`, so a trial's answers are byte-identical between its live and replay passes.
- `githttp.ts` — smart HTTP: `info/refs` (protocol v0 and v2), `ls-refs`, fetch (v2 sections and
  v0, with shallow and deepen), and receive-pack pushes with report-status.
- `rest.ts` — REST v3: user, repository CRUD, branches, commits, Git Data refs, the contents API,
  labels, issues and comments, pull requests and merges, pagination with `Link` headers.
- `graphql.ts` — GraphQL v4: a small parser/executor for the documents `gh` and
  github-mcp-server send — viewer/repository reads, issue and pull-request connections with cursor
  pagination, the create/close/merge/comment mutations, `node(id:)`, batched operations, and the
  `__type` introspection probes.
- `mcp.ts` — MCP at `/mcp`: JSON-RPC over streamable HTTP in both protocol eras (the 2026-07-28
  `server/discover` and the legacy `initialize` handshake), with the six GitHub tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) sharing the same store as REST and GraphQL.

## Notes

- The bearer token (`MAKEFUN_SHOP_TOKEN`) belongs to one user; repositories live under that
  user's login, and any other owner's name reads back 404, as GitHub answers for foreign private
  namespaces.
- State is in-memory and per-process: a fresh boot is an empty forge, which is what each trial
  grades.
