# RFC-0006: 旁观模式 — exec log + `lantern monitor`

- **Status**: Implemented (2026-06-20)
- **Author**: Lantern

## 1. Why

opencode shows each `exec` tool call inline in the chat, but the operator wanted a
**dedicated read-only window** that mirrors what's actually happening on the
environment — a "second ssh terminal you just watch" — separate from the
conversation. The old `lantern watch` provided this via an event bus + streaming
RPC; that machinery was removed in RFC-0005 as over-engineering.

## 2. What (minimal)

A server-side **append-only log** + a **tail viewer**. No bus, no RPC, no streaming
protocol — just a file the MCP server appends to and a CLI that follows it.

- The MCP `exec` tool emits one `ExecLogEntry` per executed/refused command through
  an injectable `onExec` sink. The server wires it to **append a JSON line** to
  `~/.lantern/exec.jsonl` (best-effort; a log error never breaks `exec`).
- `lantern monitor` incrementally tails that file and pretty-prints each line:
  `HH:MM:SS env $ command` + indented output + `→ exit N`, or `⛔ command / refused: …`.

```
13:30:14 demo $ echo hello && date +%Y
    hello
    2026
    → exit 0
13:30:14 demo ⛔ rm -rf /tmp/x
    refused: catastrophic: rm -rf (recursive+force)
```

Two-window model: converse + approve in opencode, watch in `lantern monitor`. The
monitor shows already-executed commands (approval happens in the MCP client first).

## 3. Log entry (no secrets)

`{ ts, env, command, exitCode, stdoutBytes, stdout?, refused? }`. `command` is
model-written (already visible); `stdout` is a **2 KB preview**, already
password-redacted by the session (same content opencode sees); injected passwords
never appear. No full output (that's in the MCP result), so the file stays bounded.

## 4. Non-goals

No pushing to the window (it polls the file every 250 ms — human-paced commands).
No remote/multi-host aggregation. No retention/rotation policy yet (append-only;
rotate out-of-band if it ever grows — commands are human-paced, so it won't quickly).
