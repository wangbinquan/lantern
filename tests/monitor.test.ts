import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatExecLine, nextRead } from "../src/cli/monitor";
import type { ExecLogEntry } from "../src/mcp/tools";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("formatExecLine (RFC-0006 spectator)", () => {
  test("a run shows command, indented output, and exit", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "prod-a",
      command: "tail -n2 app.log",
      exitCode: 0,
      stdoutBytes: 11,
      stdout: "line1\nline2",
    };
    const s = stripAnsi(formatExecLine(e));
    expect(s).toContain("prod-a $ tail -n2 app.log");
    expect(s).toContain("    line1");
    expect(s).toContain("    line2");
    expect(s).toContain("→ exit 0");
  });

  test("a refusal shows ⛔ + reason and no exit line", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "prod-a",
      command: "rm -rf /",
      exitCode: null,
      stdoutBytes: 0,
      refused: "catastrophic: rm -rf (recursive+force)",
    };
    const s = stripAnsi(formatExecLine(e));
    expect(s).toContain("⛔ rm -rf /");
    expect(s).toContain("refused: catastrophic");
    expect(s).not.toContain("exit");
  });

  test("non-zero exit + a truncation marker when stdout was capped", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "e",
      command: "x",
      exitCode: 2,
      stdoutBytes: 5000,
      stdout: "abc",
    };
    const s = stripAnsi(formatExecLine(e));
    expect(s).toContain("→ exit 2");
    expect(s).toContain("…(5000 B)");
  });

  test("empty stdout renders no blank indented line", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "e",
      command: "true",
      exitCode: 0,
      stdoutBytes: 0,
      stdout: "",
    };
    const s = stripAnsi(formatExecLine(e));
    expect(s).toBe(`${new Date(0).toTimeString().slice(0, 8)} e $ true\n    → exit 0`);
  });

  test("a session error renders ✗ + error, no exit (Codex M3)", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "e",
      command: "slow-cmd",
      exitCode: null,
      stdoutBytes: 0,
      error: "command timed out",
    };
    const s = stripAnsi(formatExecLine(e));
    expect(s).toContain("✗ slow-cmd");
    expect(s).toContain("error: command timed out");
    expect(s).not.toContain("exit");
  });

  test("shows the role (identity) when present (RFC-0007)", () => {
    const e: ExecLogEntry = {
      ts: 0,
      env: "prod-a",
      role: "restart",
      command: "systemctl restart svc",
      exitCode: 0,
      stdoutBytes: 0,
    };
    expect(stripAnsi(formatExecLine(e))).toContain("prod-a (restart) $ systemctl restart svc");
  });

  test("no false truncation marker for multibyte output (Codex L5)", () => {
    const out = "日本語ログ"; // 5 chars, 15 bytes — would falsely mark if compared by char length
    const e: ExecLogEntry = {
      ts: 0,
      env: "e",
      command: "x",
      exitCode: 0,
      stdoutBytes: Buffer.byteLength(out),
      stdout: out,
    };
    expect(stripAnsi(formatExecLine(e))).not.toContain("…(");
  });
});

describe("nextRead (RFC-0006 tail)", () => {
  test("follows appends, then re-reads from start after truncation (Codex M4)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mon-"));
    const f = join(dir, "exec.jsonl");
    try {
      writeFileSync(f, "a\nb\n");
      const r1 = nextRead(f, 0);
      expect(r1.chunk).toBe("a\nb\n");
      expect(r1.reset).toBe(false);

      appendFileSync(f, "c\n");
      const r2 = nextRead(f, r1.next);
      expect(r2.chunk).toBe("c\n");
      expect(r2.reset).toBe(false);

      writeFileSync(f, "x\n"); // truncated/rotated — smaller than the prior offset
      const r3 = nextRead(f, r2.next);
      expect(r3.reset).toBe(true);
      expect(r3.chunk).toBe("x\n"); // re-read from the start, not skipped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
