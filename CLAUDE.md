# Lantern — project guide for Claude

Lantern is a **minimal stdio MCP server** that lets opencode (or any MCP client)
**connect to an SSH-only, network-isolated environment and execute commands** over
the hard multi-hop/su chain (bastion login → su → ssh internal → su). That is its
*only* job. Business logic — fetching logs, diagnosing, deploying — is each team's
own opencode **skills**, which call the `exec` tool. Full design: `design/`.

**Scope discipline (learned the hard way):** Lantern was over-built into a product
(logs/state/snapshot/observe/swap/watch/classifier/CLI) on a FALSE premise that
opencode v2 can't consume MCP. It can. Keep Lantern to **connect + exec**; don't
re-add business features.

## Hard constraints (non-negotiable)
- **Never modify the local opencode clone** (`/Users/wangbinquan/Documents/code/opencode`).
  Lantern's whole architecture is "reuse opencode, no source change". Consult it
  read-only to verify v2 behavior; don't change it.
- **All work on `main`**, no branches/PRs. **Small, frequent commits** → `push origin main`.
- **After every push, verify CI** (`gh run list/view` — check the *conclusion*,
  not just `gh run watch` exit). Fix red main promptly.
- **Never commit real secrets.** Env registry lives in `~/.lantern/` (outside the
  repo); secrets live in the OS keychain, read only by the MCP server; passwords are
  injected at the PTY and redacted from every tool result (model never sees them).

## Toolchain (Bun)
- `bun install` / `bun test` / `bun run <script>` / `bunx`.
- **`bun:sqlite`** for the env registry (no better-sqlite3). **`ssh2`** for the
  real multi-hop/su PTY transport. **`@modelcontextprotocol/sdk`** (stdio) for the
  MCP server. OS keychain for secrets (macOS `security`).
- Scripts: `bun run typecheck` (tsc --noEmit), `bun run lint` (oxlint),
  `bun run format` / `format:check` (prettier), `bun test`.
- **Pre-push:** run `bun run typecheck && bun run lint && bun run format:check && bun test`
  (mirrors CI's `check` job). CI also runs lychee link-check + actionlint + gitleaks.

## Layout (target — minimal MCP server)
```
src/
  mcp/          stdio MCP server (tools: env_list, exec) — opencode spawns this
  ssh/          SessionManager (multi-hop/su PTY) + ssh2 adapter   [the hard part]
  pty/          marker protocol + expect FSM (boundary/exit-code/prompt)
  session/      SessionPool (one persistent session per env)
  registry/     env CONNECTION descriptor (zod) + bun:sqlite + keychain secrets
  safety/       catastrophic-command backstop (rm -rf / mkfs / fork bomb …)
  cli/          env-admin CLI (env init/list/rm → registry+keychain, out-of-band)
tests/          bun:test, one file per module
AGENTS.md       operating notes
```
Secrets stay in the OS keychain; the MCP server injects them at the PTY and
**never** returns them in tool results (the model must not see passwords).

## Key design facts (verified against the opencode 1.17.8 clone)
- **opencode v2 SUPPORTS MCP.** `packages/core/src/config/mcp.ts` defines
  `ConfigV2.MCP.Local` (`{type:"local", command:string[], cwd?, environment?}`) and
  `Remote` (`{type:"remote", url}`); `tool/builtins.ts` registers MCP tools into the
  model toolset; there's an `mcp.connect/status/auth` HTTP API. So opencode spawns a
  local MCP server via `command` and talks MCP over **stdio**. (The earlier
  "v2 can't consume MCP" claim was wrong — it caused the whole CLI/bash detour.)
- Configure in opencode v2 config: `mcp.servers.lantern = {type:"local", command:["bun","<repo>/src/mcp/server.ts"]}`.
- Tool-call confirmation + command visibility are the **client's** job (opencode's
  tool permission gate + TUI). Lantern only keeps a slim catastrophic backstop.

## How verification works without a real env
The isolated env / internal LLM gateway / proprietary CLI aren't available here.
Verify the SSH engine + MCP server against a **local fake target**: set
`LANTERN_LOCAL_SHELL=1` so sessions spawn a local `bash` instead of ssh, then
drive the MCP server over stdio with the `@modelcontextprotocol/sdk` **client**
(`tools/list` + `exec` + catastrophic→isError). Unit tests call the tool handlers
(`src/mcp/tools.ts`) directly. The opencode leg is config-ready (`mcp.servers`)
but needs opencode + the gateway + a real env to run live.
