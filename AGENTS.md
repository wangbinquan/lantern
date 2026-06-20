# AGENTS.md — operating notes for AI agents using the Lantern MCP server

Lantern is a **stdio MCP server** that connects to an SSH-only, network-isolated
environment over a multi-hop/su chain and runs commands. It exposes two tools —
**`env_list`** and **`exec`**. That is the whole surface; business actions (fetching
logs, diagnosing, deploying) are **your own skills**, composed from `exec` calls.

## Setup (operator, once)
1. Configure an environment out-of-band (secrets never touch the model):
   `bun src/cli/lantern.ts env init <id>` — prompts for the login, internal nodes,
   and per-operation roles; hidden passwords go to the OS keychain; host key
   auto-pinned (TOFU). List/select/remove with `lantern env list|use|current|rm`;
   add identities incrementally with `lantern env node add <env> <node>` /
   `lantern env role add <env> <role>`.
2. Declare the MCP server in opencode v2 config so opencode spawns it over stdio:
   ```jsonc
   { "mcp": { "servers": {
     "lantern": { "type": "local", "command": ["bun", "/abs/path/to/src/mcp/server.ts"] }
   } } }
   ```
3. opencode now has `env_list` + `exec`. It shows every tool call + result, and
   prompts for confirmation per call — that IS the human-in-the-loop boundary.
4. (Optional) For a dedicated read-only spectator window, open a second terminal and
   run `bun src/cli/lantern.ts monitor` — a live mirror of every executed/refused
   command on the environment (RFC-0006), separate from the chat.

## Rules for the agent
- **Run commands on the environment via `exec`** (`{env, command, role?, timeoutMs?}`).
  Pick the env id + the `role` for your operation from `env_list` (each env lists its
  roles, e.g. `restart` / `filexfer` / `diagnose`). The role decides which machine +
  user the command runs as; omit it only when the env has exactly one role. Only the
  server holds credentials, so nothing else can reach the environment.
- **Read before you write.** Gather evidence (logs, status, stack traces) with
  read-only commands first; keep them bounded (`tail`/`grep`/`--since`), don't dump
  whole logs. Reach for mutations (restart, file changes, redeploy) only once the
  cause is localized.
- **Each `exec` is confirmed by the client.** Don't try to batch around the prompt
  or smuggle multiple side effects into one command to avoid review.
- **The server refuses catastrophic commands** (`rm -rf`, `mkfs`, fork bomb, …).
  That's a backstop, not a license — don't probe it.
- **Never echo, log, or ask the user for passwords.** The server injects them at
  the PTY and redacts them from every result; they never appear in tool output.
- Prefer LIVE diagnostics (jstack/py-spy/Arthas batch one-shots via `exec`) over a
  rebuild-and-redeploy loop when they can reach the answer.
