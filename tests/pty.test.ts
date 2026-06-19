import { describe, expect, test } from "bun:test";
import {
  Expecter,
  ExpectTimeoutError,
  markerRegex,
  MARKER_PREFIX,
  newMarkerId,
  parseCompletion,
  type PtyTransport,
  spawnPty,
  stripAnsi,
  wrapCommand,
} from "../src/pty";

describe("marker", () => {
  test("newMarkerId is hex, no dashes", () => {
    const id = newMarkerId();
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).not.toContain("-");
  });

  test("wrapCommand embeds marker + printf on its own line", () => {
    const w = wrapCommand("ls -la", "abc");
    expect(w).toContain("ls -la\n");
    expect(w).toContain(`${MARKER_PREFIX}abc__%d`);
    expect(w).toContain('"$?"');
  });

  test("parseCompletion: not done when marker absent", () => {
    const c = parseCompletion("partial output without marker", "abc");
    expect(c.done).toBe(false);
    expect(c.exitCode).toBeNull();
  });

  test("parseCompletion: extracts stdout + exit code, drops injected newline", () => {
    const text = `file1\nfile2\n${MARKER_PREFIX}abc__0\n`;
    const c = parseCompletion(text, "abc");
    expect(c.done).toBe(true);
    expect(c.stdout).toBe("file1\nfile2");
    expect(c.exitCode).toBe(0);
    expect(c.remainder).toBe("");
  });

  test("parseCompletion: non-zero + negative exit codes", () => {
    expect(parseCompletion(`x\n${MARKER_PREFIX}id__1\n`, "id").exitCode).toBe(1);
    expect(parseCompletion(`x\n${MARKER_PREFIX}id__137\n`, "id").exitCode).toBe(137);
  });

  test("parseCompletion: remainder is text after the marker", () => {
    const c = parseCompletion(`out\n\n${MARKER_PREFIX}id__0\nnext-prompt$ `, "id");
    expect(c.remainder).toBe("next-prompt$ ");
  });

  test("markerRegex captures the exit code", () => {
    const m = markerRegex("id").exec(`${MARKER_PREFIX}id__42\n`);
    expect(m?.[1]).toBe("42");
  });
});

describe("stripAnsi", () => {
  test("removes SGR color codes", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
  test("removes cursor/CSI sequences", () => {
    expect(stripAnsi("a[2Kb[1;2Hc")).toBe("abc");
  });
  test("leaves plain text untouched", () => {
    expect(stripAnsi("hello world\n")).toBe("hello world\n");
  });
});

describe("Expecter (synthetic feed)", () => {
  test("resolves when pattern arrives after expect()", async () => {
    const e = new Expecter();
    const p = e.expect(/Password: /, 1000);
    e.feed("some banner\nPass");
    e.feed("word: ");
    const m = await p;
    expect(m.before).toBe("some banner\n");
    expect(m.match).toBe("Password: ");
  });

  test("resolves with already-buffered data", async () => {
    const e = new Expecter();
    e.feed("ready> ");
    const m = await e.expect("ready> ", 1000);
    expect(m.before).toBe("");
    expect(m.match).toBe("ready> ");
  });

  test("consumes buffer through the match", async () => {
    const e = new Expecter();
    e.feed("AAAmarkerBBB");
    await e.expect("marker", 1000);
    expect(e.peek()).toBe("BBB");
  });

  test("times out and reports pending buffer", async () => {
    const e = new Expecter();
    e.feed("nope");
    let err: unknown;
    try {
      await e.expect(/never/, 50);
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(ExpectTimeoutError);
    expect((err as ExpectTimeoutError).pending).toBe("nope");
  });

  test("rejects concurrent expect()", async () => {
    const e = new Expecter();
    const p1 = e.expect(/x/, 200);
    await expect(e.expect(/y/, 200)).rejects.toThrow(/busy/);
    e.feed("x");
    await p1;
  });

  test("string pattern is matched literally (regex chars escaped)", async () => {
    const e = new Expecter();
    e.feed("cost is $5.00 today");
    const m = await e.expect("$5.00", 1000);
    expect(m.match).toBe("$5.00");
  });
});

// ---- integration: drive a real spawned bash through the marker/expect protocol ----

function shell(): { t: PtyTransport; exp: Expecter } {
  const t = spawnPty(["bash", "--norc", "--noprofile"]);
  const exp = new Expecter();
  t.onData((c) => exp.feed(c));
  return { t, exp };
}

async function runCmd(t: PtyTransport, exp: Expecter, cmd: string, timeoutMs = 5000) {
  const id = newMarkerId();
  t.write(wrapCommand(cmd, id));
  const { before, match } = await exp.expect(markerRegex(id), timeoutMs);
  const c = parseCompletion(before + match, id);
  return { stdout: stripAnsi(c.stdout), exitCode: c.exitCode };
}

describe("PTY protocol against real bash", () => {
  test("captures stdout + zero exit", async () => {
    const { t, exp } = shell();
    try {
      const r = await runCmd(t, exp, "echo hello");
      expect(r.stdout).toBe("hello");
      expect(r.exitCode).toBe(0);
    } finally {
      t.close();
    }
  });

  test("multi-line output + sequential commands on one session", async () => {
    const { t, exp } = shell();
    try {
      const r1 = await runCmd(t, exp, "echo a; echo b");
      expect(r1.stdout).toBe("a\nb");
      const r2 = await runCmd(t, exp, "echo second");
      expect(r2.stdout).toBe("second");
      expect(r2.exitCode).toBe(0);
    } finally {
      t.close();
    }
  });

  test("propagates non-zero exit codes", async () => {
    const { t, exp } = shell();
    try {
      expect((await runCmd(t, exp, "false")).exitCode).toBe(1);
      expect((await runCmd(t, exp, "(exit 7)")).exitCode).toBe(7);
    } finally {
      t.close();
    }
  });

  test("expect/respond to a password-style prompt (su simulation)", async () => {
    const { t, exp } = shell();
    try {
      t.write(`printf 'Password: '; read -r pw; echo "AUTH=$pw"\n`);
      const prompt = await exp.expect(/Password: /, 3000);
      expect(prompt.match).toBe("Password: ");
      t.write("s3cret\n");
      const got = await exp.expect(/AUTH=s3cret/, 3000);
      expect(got.match).toBe("AUTH=s3cret");
    } finally {
      t.close();
    }
  });
});
