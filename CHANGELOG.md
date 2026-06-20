# Changelog

All notable changes to Lantern are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.0] — 2026-06-20

First tagged release. Lantern is a **minimal stdio MCP server** that lets opencode
(or any MCP client) connect to an SSH-only, network-isolated environment over the hard
multi-hop/su chain (bastion login → su → ssh internal → su) and execute commands.
Fetching logs, diagnosing, and deploying are each team's own opencode **skills**, which
call the `exec` tool — Lantern only does **connect + exec**.

### Added

- **MCP server** over stdio with two tools (RFC-0005):
  - `env_list` — the configured environments (ids, labels, role names).
  - `exec(env, command, role?, target?, timeoutMs?)` — run a command on one
    environment's persistent SSH session; returns `{stdout, exitCode}`.
- **Multi-hop / su PTY engine** — one persistent session per environment that scripts
  the human chain (login → su → ssh internal → su …) over a real PTY, injecting each
  password at its prompt and verifying identity with `whoami`.
- **Per-operation roles** (RFC-0007) — a role names an identity (which machine + which
  user); the skill picks one per operation. The descriptor is a skeleton (`bastion`
  + named `nodes`) plus `roles`; `resolveChain` flattens a role into the su/ssh steps;
  `SessionPool` keeps one session per `(env, role)`.
- **Runtime target** (RFC-0008) — a node address may be `${target}`, supplied per
  `exec`, so a skill can discover fleet/k8s worker IPs (e.g. `kubectl get node`) and
  ssh into a chosen one. Validated against the node's `toPattern` allowlist.
- **Multi-level nodes** — `nodes[].from` chains `bastion → gateway → internal → …`
  (recursive, with cycle detection).
- **`lantern env init`** interactive wizard, plus incremental **`env node add`** /
  **`env role add`** — configures the connection out-of-band; hidden password input;
  host-key TOFU pin via `ssh-keyscan`.
- **`lantern monitor`** — a read-only spectator window mirroring every executed /
  refused command on the environment, separate from the chat (RFC-0006).
- **Cross-platform secret backends** — macOS keychain / Windows DPAPI / Linux Secret
  Service (`secret-tool`), with a SQLite fallback; chosen automatically per platform.
- **Catastrophic-command backstop** — refuses `rm -rf` / `mkfs` / fork bomb etc.,
  with quote/backslash normalization so trivial obfuscation can't slip past.
- **Standalone binaries** — `bun --compile` builds `lantern` + `lantern-mcp` for
  `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `windows-x64`
  (Bun runtime + ssh2 + sqlite + MCP SDK all bundled), published on each `v*` tag.

### Security

- Passwords live in the OS secret vault, are injected at the PTY, and are redacted
  from every tool result, the spectator log, and the MCP response — they never enter
  model context. Setup is out-of-band; the model only ever names a role/target.
- A runtime `target` is validated by a **full-match** `toPattern` allowlist plus a host
  regex (no shell metacharacters) before it is shell-quoted into `ssh`.
- Tool-call confirmation and command visibility are the MCP client's job (opencode's
  permission gate + TUI); Lantern keeps only the slim catastrophic backstop.

### Notes

- CI is green on Linux + macOS + Windows (132 tests). The bash-fixture tests (real-PTY
  protocol, multi-hop/su orchestration) skip on native Windows — that logic is
  platform-agnostic JS, verified on Linux/macOS.
- Verified in-repo/CI: backend logic (injected spawn/crypt), cross-compilation, and the
  three-OS checks. The real `secret-tool`/DPAPI integration and a native-Windows ssh2
  multi-hop run are best-effort — confirm them on the actual machine (verification
  checklist in the docs) before relying on them in production.

[Unreleased]: https://github.com/wangbinquan/lantern/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wangbinquan/lantern/releases/tag/v0.1.0
