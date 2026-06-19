# AGENTS.md — operating rules for AI agents working a Lantern environment

This project drives **opencode** (unmodified) as the agent. The SSH capability
lives in the external **`lantern` CLI + `lanternd` daemon**; opencode operates
the isolated environment by invoking `lantern …` through its built-in **bash**
tool. The hardened permission ruleset is in `.opencode/opencode.json`.

## Setup (operator, once)
1. Start the daemon: `bun src/cli/lanternd.ts` (or the installed `lanternd`).
   Sessions hold the multi-hop/su PTY; registry + secrets live in `~/.lantern/`.
2. Register an environment (descriptor + secrets) — stdin JSON:
   `echo '{"env": {…descriptor…}, "secrets": {"env-A/low":"…"}}' | lantern env add`
3. Point opencode at an internal LLM gateway in `.opencode/opencode.json`
   (`provider`/`model` with the OpenAI/Anthropic-compatible `baseURL` + key).
4. Run opencode (`opencode serve` + TUI) with `--password` bound to loopback.

## Hard rules for the agent
- **Operate the environment ONLY via `lantern`.** Never run raw `ssh`, `su`,
  `kubectl`, or shell pipelines — they are denied by `.opencode/opencode.json`.
- **Read-only first.** `lantern env list|current`, `lantern logs|state|snapshot`
  are read-only-by-construction and auto-run (still displayed). Everything else
  (`env use`, `exec`, `observe`, `redefine`, `put`, `swap`, `restart`) is a
  mutation and requires explicit per-command confirmation.
- **Confirm every mutation individually. Never select "always" on a mutating
  command** (it persists across restarts and widens blast radius). Reads may use
  "always".
- **Complex grep patterns** go via `--grep-b64 <base64>` so the bash string stays
  metachar-free (otherwise `|`/`>` fall to a confirmation prompt and `;`/`&`/`` ` ``/`$(`
  are denied outright).
- **Never echo, log, or ask for passwords.** `lanternd` injects them at the PTY
  and redacts them everywhere.
- Keep evidence bounded (`--tail`, `--grep`, `--since`); don't dump whole logs.
- Prefer LIVE diagnostics (`snapshot`/`observe`) over rebuild-and-swap.

## Two-layer safety (don't rely on either alone)
1. **opencode permission gate** (`.opencode/opencode.json`): allow read-only
   `lantern` subcommands, ask the rest, deny shell metacharacters / `rm -rf` /
   `sudo` / raw `ssh`. This is the human-confirmation boundary.
2. **lanternd classifier**: re-classifies `exec` free-text and refuses
   catastrophic commands; read subcommands are read-only by construction.
