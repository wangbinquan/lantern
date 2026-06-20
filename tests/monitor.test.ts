import { describe, expect, test } from "bun:test";
import { formatExecLine } from "../src/cli/monitor";
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
});
