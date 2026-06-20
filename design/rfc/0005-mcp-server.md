# RFC-0005: Re-architect Lantern as a minimal MCP server (connect + exec)

- **Status**: Accepted (2026-06-20)
- **Author**: Lantern
- **Supersedes**: the CLI + bash-tool + opencode-permission architecture (RFC-0001..0004 features)

## 1. Why (the correction)

The whole architecture rested on a **false premise**: that opencode v2 cannot consume
MCP, so the SSH capability had to be an external `lantern` CLI driven through opencode's
built-in **bash** tool, gated by an elaborate `opencode.json` permission glob.

**opencode v2 supports MCP.** Verified in the clone:
- `packages/core/src/config/mcp.ts` — `ConfigV2.MCP.Local` (`{type:"local", command:string[], cwd?, environment?, timeout?}`) and `Remote` (`{type:"remote", url}`).
- `tool/builtins.ts` registers MCP tools into the model toolset; `mcp.connect/status/auth` HTTP API exists; the app has per-directory MCP toggles.

So opencode spawns a **local MCP server** via `command` and talks MCP over **stdio**.
The CLI/bash detour was solving a non-problem.

## 2. What Lantern actually is

A **minimal stdio MCP server** whose only job is: **connect to the isolated env over
the multi-hop/su PTY and execute a command.** Everything else — fetching logs,
diagnosing (Arthas/dlv/py-spy), deploying — is **each business team's own opencode
skills**, which call the `exec` tool. Lantern does NOT bake in business commands.

```
opencode (MCP client)
  └─ spawns:  bun src/mcp/server.ts        (MCP.Local, stdio)
       tools:
         env_list                          → list configured environments
         exec(env, command[, timeout])     → run on that env's SSH session → {stdout, exitCode}
       backed by:
         SessionPool → SessionManager (bastion→su→ssh→su PTY)   [the hard, valuable part]
         registry (env connection descriptors) + OS keychain (secrets)
         safety: catastrophic-command backstop (rm -rf / mkfs / fork bomb)
```

Env setup is **out-of-band** (not via the model — secrets must never enter model
context): a small admin CLI `lantern env init|list|rm` writes the connection chain +
hidden-input passwords directly to the registry + keychain.

## 3. Keep / delete

**Keep (the genuinely hard + valuable core):** `ssh/` (multi-hop/su PTY engine),
`pty/` (marker protocol), `session/` (SessionPool, trimmed — no watch bus),
`registry/` + keychain, `util/shell`, a slim `safety/` catastrophic check, and the
env-admin CLI (`env init` reusing the wizard/prompt/host-key, rewired to write the
registry directly).

**Delete (business logic / over-engineering):** `daemon/{commands,swap,upload,observe,
watch,server,dispatch,protocol,audit,paths}`, most of `classify/` (keep only
catastrophic), `cli/{args,client,lantern,lanternd,watch-render}` — i.e. `logs`,
`state`, `snapshot`, `observe`, `swap`/`put`/`restart`, the read/mutate classifier,
`watch`, the unix-socket RPC daemon, and the per-command `lantern` CLI. And the env
descriptor's service/swap/observe/logs fields (connection-only now).

## 4. Safety / visibility (now the client's job)

- **Confirmation:** opencode's MCP tool-call permission prompts the operator per
  `exec` call. Lantern keeps only a slim **catastrophic backstop** (deny `rm -rf`,
  `mkfs`, fork bomb, etc.) server-side as defense.
- **Visibility:** the MCP client (opencode TUI) shows every tool call + result.
  No bespoke `watch` needed.
- **Secrets:** injected at the PTY by the server, redacted from every tool result;
  never pass through the model. Env setup is out-of-band (admin CLI → keychain).

## 5. Migration (slices, CI green each)

1. CLAUDE.md fix + this RFC.
2. Add `@modelcontextprotocol/sdk`; build `src/mcp/server.ts` (env_list + exec) +
   `src/safety/catastrophic.ts`, backed by SessionPool + registry. +tests. (Additive — old code still compiles.)
3. Delete the business modules + tests; trim pool/types/schema/registry; rewire env-init → direct registry.
4. Docs (README/AGENTS), `package.json` bin, `.opencode` mcp.servers example, CI.

## 6. Non-goals

No logs/diagnose/deploy tools in Lantern (skills do that). No bespoke confirmation
UI or real-time mirror (the MCP client provides both). No read/mutate classifier
beyond the catastrophic backstop.
