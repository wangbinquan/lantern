# AGENTS.md — operating rules for AI agents working a Lantern environment

This project drives **opencode** (unmodified) as the agent. The SSH capability
lives in the external **`lantern` CLI + `lanternd` daemon**; opencode operates
the isolated environment by invoking `lantern …` through its built-in **bash**
tool. The hardened permission ruleset is in `.opencode/opencode.json`.

## Setup (operator, once)
1. Start the daemon: `bun src/cli/lanternd.ts` (or the installed `lanternd`).
   Sessions hold the multi-hop/su PTY; registry + secrets live in `~/.lantern/`.
2. Register an environment. **Interactive (recommended):** `lantern env init <id>`
   — prompts for the hop/su chain + services, hidden passwords → keychain, host
   key auto-pinned (TOFU). **Scripted:** `echo '{"env":{…}, "secrets":{…}}' | lantern env add`.
3. Point opencode at an internal LLM gateway in `.opencode/opencode.json`
   (`provider`/`model` with the OpenAI/Anthropic-compatible `baseURL` + key).
4. Run opencode (`opencode serve` + TUI) with `--password` bound to loopback.
5. (Optional, recommended) Open a second terminal and run `lantern watch` for a
   **read-only live mirror** of everything lanternd does on the environment
   (connection chain, commands, output, exit codes, denials — passwords `***`).
   Two-window model: converse + approve in opencode, observe in `lantern watch`.
   It shows already-executed commands (approval happens in opencode beforehand).

## Hard rules for the agent
- **Operate the environment ONLY via `lantern`.** Raw `ssh`/`su` are denied by
  `.opencode/opencode.json`; raw `kubectl`/other env tools and shell pipelines
  (`|`/`>`) fall to a confirmation prompt — reject them and use `lantern` instead.
  (Only `lanternd` holds the credentials, so direct tools can't reach the env
  anyway; the gate's job is to keep you on the `lantern` path.)
- **Read-only first.** `lantern env list|current`, `lantern logs|state|snapshot`
  are read-only-by-construction and auto-run (still displayed). Everything else
  (`env use`, `exec`, and the Phase-2 `observe`/`redefine`/`put`/`swap`/`restart`)
  is a mutation and requires explicit per-command confirmation. Implemented today:
  `env list/use/current`, `logs`, `state`, `snapshot`, `exec`.
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
