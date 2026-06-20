import { describe, expect, test } from "bun:test";
import { renderWatchEvent } from "../src/cli/watch-render";
import type { WatchEvent } from "../src/daemon";

const ESC = String.fromCharCode(27);

describe("renderWatchEvent (RFC-0001 slice 4)", () => {
  test("connect shows the chain", () => {
    const e: WatchEvent = { ts: 0, env: "e", kind: "connect", chain: ["me@h", "su root"] };
    expect(renderWatchEvent(e)).toContain("● e  connected  me@h → su root");
  });

  test("command shows method + $command", () => {
    const e: WatchEvent = {
      ts: 0,
      env: "e",
      kind: "command",
      method: "logs",
      command: "tail -n5 x",
    };
    expect(renderWatchEvent(e)).toContain("logs  $ tail -n5 x");
  });

  test("stdout indents each line; empty when showOutput=false", () => {
    const e: WatchEvent = { ts: 0, env: "e", kind: "stdout", text: "a\nb\n" };
    const out = renderWatchEvent(e);
    expect(out).toContain("│ a");
    expect(out).toContain("│ b");
    expect(renderWatchEvent(e, { showOutput: false })).toBe("");
  });

  test("exit shows mark/code/bytes + truncated", () => {
    expect(
      renderWatchEvent({ ts: 0, env: "e", kind: "exit", method: "state", exitCode: 0, bytes: 12 }),
    ).toContain("✓ exit 0 (12 B)");
    expect(
      renderWatchEvent({ ts: 0, env: "e", kind: "exit", method: "exec", exitCode: 1, bytes: 3 }),
    ).toContain("✗ exit 1 (3 B)");
    expect(
      renderWatchEvent({
        ts: 0,
        env: "e",
        kind: "exit",
        method: "logs",
        exitCode: 0,
        bytes: 5,
        truncated: true,
      }),
    ).toContain("(truncated)");
  });

  test("denied shows the reason", () => {
    const e: WatchEvent = {
      ts: 0,
      env: "e",
      kind: "denied",
      method: "exec",
      command: "rm -rf /",
      reason: "rm -rf (recursive+force)",
    };
    expect(renderWatchEvent(e)).toContain("refused: rm -rf (recursive+force)");
  });

  test("no ANSI by default; ANSI when color=true", () => {
    const e: WatchEvent = { ts: 0, env: "e", kind: "connect", chain: ["a"] };
    expect(renderWatchEvent(e)).not.toContain(ESC);
    expect(renderWatchEvent(e, { color: true })).toContain(ESC);
  });
});
