# Lantern — project guide for Claude

AI environment problem-localization assistant for **SSH-only, network-isolated**
dev environments. Reuses **opencode** (anomalyco/opencode 1.17.8, v2 runtime) as
the agent; the SSH capability lives in an external **`lanternd` daemon + `lantern`
CLI** that opencode drives via its built-in **bash tool**. Full design: `design/`.

## Hard constraints (non-negotiable)
- **Never modify the local opencode clone** (`/Users/wangbinquan/Documents/code/opencode`).
  Lantern's whole architecture is "reuse opencode, no source change". Consult it
  read-only to verify v2 behavior; don't change it.
- **All work on `main`**, no branches/PRs. **Small, frequent commits** → `push origin main`.
- **After every push, verify CI** (`gh run list/view` — check the *conclusion*,
  not just `gh run watch` exit). Fix red main promptly.
- **Never commit real secrets.** Env registry + plaintext creds live in
  `~/.lantern/` (outside the repo), read only by `lanternd`; redact passwords in
  all streamed/logged output.

## Toolchain (Bun)
- `bun install` / `bun test` / `bun run <script>` / `bunx`.
- **`bun:sqlite`** for the env registry (no better-sqlite3). **`ssh2`** for the
  real multi-hop/su PTY transport. `Bun.serve`/unix socket for the daemon RPC.
- Scripts: `bun run typecheck` (tsc --noEmit), `bun run lint` (oxlint),
  `bun run format` / `format:check` (prettier), `bun test`.
- **Pre-push:** run `bun run typecheck && bun run lint && bun run format:check && bun test`
  (mirrors CI's `check` job). CI also runs lychee link-check + actionlint + gitleaks.

## Layout (target)
```
src/
  classify/     read-only vs mutating command classifier (pure)
  pty/          marker protocol + expect FSM (boundary/exit-code/prompt)
  ssh/          SessionManager (transport-agnostic) + ssh2 adapter
  registry/     env descriptor (zod) + bun:sqlite store @ ~/.lantern
  secrets/      redaction + injection
  cli/          lantern.ts (CLI) + lanternd.ts (daemon)
tests/          bun:test, one file per module
.opencode/      opencode.json (v2 permissions) + agent/env-debugger.md
AGENTS.md       agent operating rules (use lantern; reads first; confirm mutations)
```

## Key design facts (verified against opencode 1.17.8 source)
- bash tool self-asserts (`packages/core/src/tool/bash.ts:143`, `save:[command]`);
  gating = config `permissions` flat ruleset, **deny wins**, default `ask`;
  blocks on `permission.v2.asked` until reply (`once|always|reject`).
- `opencode serve` = v2 API server (127.0.0.1:4096 + `--password`); SSE `GET /api/event`;
  reply `POST /api/session/:id/permission/:requestID/reply`. TUI/app = ready approval UI.
- v2 does NOT load disk tools / plugins / MCP → we integrate via the bash tool, not a custom tool.

## How verification works without a real env
The isolated env / internal LLM gateway / proprietary CLI aren't available here.
Verify the `lantern` stack against a **local fake multi-hop/su target** (spawned
bash + fake password-prompt scripts; see `tests/` and `scripts/`). The
opencode-driven leg is config-ready but needs the gateway + a real env to run live.
