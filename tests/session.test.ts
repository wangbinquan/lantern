import { describe, expect, test } from "bun:test";
import { spawnPty } from "../src/pty";
import { SessionError, SessionManager, type SessionEvent, type SessionOptions } from "../src/ssh";
import type { ChainStep, EnvDescriptor } from "../src/types";

const FIX = `${import.meta.dir}/fixtures/bin`;
const SECRETS: Record<string, string> = {
  high: "pw-high",
  jump: "pw-jump",
  node12: "sshpw-10.0.0.12",
};
const resolveSecret = (ref: string) => SECRETS[ref] ?? "WRONG";
// In tests, identity is tracked via LANTERN_WHO (the fake su/ssh set it), since
// we can't actually change uid. Production uses the default `id -un`.
const WHOAMI = `printf '%s\\n' "$LANTERN_WHO"`;

function factory(initialWho = "low") {
  return () =>
    spawnPty(["bash", "--norc", "--noprofile"], {
      env: {
        PATH: `${FIX}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME ?? "/tmp",
        LANTERN_WHO: initialWho,
        LANG: "C",
      },
    });
}

function descriptor(over: Partial<EnvDescriptor> = {}): EnvDescriptor {
  return {
    id: "test",
    bastion: { host: "127.0.0.1", loginUser: "low", auth: { type: "password", secretRef: "low" } },
    roles: { default: {} }, // engine runs the injected chain; roles only satisfy the type
    ...over,
  };
}

// chains the engine executes after the bastion login (resolveChain output shape)
const SU_HIGH: ChainStep[] = [{ kind: "su", user: "high", secretRef: "high" }];
const HOP_CHAIN: ChainStep[] = [
  { kind: "su", user: "jump", secretRef: "jump" },
  { kind: "ssh", to: "10.0.0.12", secretRef: "node12" },
  { kind: "su", user: "high", secretRef: "high" },
];

function mgr(
  desc: EnvDescriptor,
  chain: ChainStep[] = [],
  events?: SessionEvent[],
  extra: Partial<SessionOptions> = {},
) {
  return new SessionManager(
    factory(),
    desc,
    {
      resolveSecret,
      whoamiCmd: WHOAMI,
      syncTimeoutMs: 5000,
      commandTimeoutMs: 5000,
      onEvent: events ? (e) => events.push(e) : undefined,
      ...extra,
    },
    chain,
  );
}

// drives a real multi-hop/su chain over spawned `bash` + fixtures — skipped on
// native Windows (no POSIX bash / +x fixtures); the orchestration is platform-agnostic JS.
describe.skipIf(process.platform === "win32")("SessionManager", () => {
  test("releases the transport when establish() fails mid-setup (no leak, Codex H2)", async () => {
    class FakeTransport {
      closed = 0;
      write(_d: string): void {} // never echoes the sync marker → rawRun times out
      onData(_cb: (c: string) => void): void {}
      close(): void {
        this.closed++;
      }
      readonly exited = new Promise<number>(() => {}); // never exits
    }
    const made: FakeTransport[] = [];
    const s = new SessionManager(
      () => {
        const t = new FakeTransport();
        made.push(t);
        return t as unknown as import("../src/pty").PtyTransport;
      },
      descriptor(),
      { resolveSecret, whoamiCmd: WHOAMI, syncTimeoutMs: 150, commandTimeoutMs: 150 },
    );
    await expect(s.connect()).rejects.toThrow(); // sync marker never arrives
    expect(made.length).toBe(1);
    expect(made[0]!.closed).toBe(1); // released on failure, not leaked
    await s.release();
  });

  test("escalates via su and runs commands as the target user", async () => {
    const s = mgr(descriptor(), SU_HIGH);
    try {
      await s.connect();
      expect(await s.whoami()).toBe("high");
      const r = await s.run("echo hello");
      expect(r.stdout).toBe("hello");
      expect(r.exitCode).toBe(0);
    } finally {
      await s.release();
    }
  });

  test("walks su -> ssh hop -> su on the internal node", async () => {
    const s = mgr(descriptor(), HOP_CHAIN);
    try {
      await s.connect();
      expect(await s.whoami()).toBe("high");
    } finally {
      await s.release();
    }
  });

  test("throws SessionError on a failed su (wrong password)", async () => {
    const s = new SessionManager(
      factory(),
      descriptor(),
      { resolveSecret: () => "wrong-password", whoamiCmd: WHOAMI, syncTimeoutMs: 4000 },
      SU_HIGH,
    );
    await expect(s.connect()).rejects.toBeInstanceOf(SessionError);
    await s.release();
  });

  test("redacts passwords in events and command output", async () => {
    const events: SessionEvent[] = [];
    const s = mgr(descriptor(), SU_HIGH, events);
    try {
      await s.connect();
      const r = await s.run(`echo "pw is pw-high"`);
      expect(r.stdout).toBe("pw is ***");
      const joined = events.map((e) => e.text).join("\n");
      expect(joined).not.toContain("pw-high");
      expect(joined).toContain("***");
    } finally {
      await s.release();
    }
  });

  test("serializes concurrent run() calls in order", async () => {
    const s = mgr(descriptor());
    try {
      await s.connect();
      const results = await Promise.all([s.run("echo 1"), s.run("echo 2"), s.run("echo 3")]);
      expect(results.map((r) => r.stdout)).toEqual(["1", "2", "3"]);
    } finally {
      await s.release();
    }
  });

  test("propagates non-zero exit codes from run()", async () => {
    const s = mgr(descriptor());
    try {
      await s.connect();
      expect((await s.run("false")).exitCode).toBe(1);
      expect((await s.run("(exit 9)")).exitCode).toBe(9);
    } finally {
      await s.release();
    }
  });

  test("lazily reconnects after the idle window", async () => {
    const s = mgr(descriptor({ session: { idleSec: 0.001 } }));
    try {
      await s.connect();
      expect(s.factoryCalls).toBe(1);
      await Bun.sleep(25);
      await s.run("true");
      expect(s.factoryCalls).toBe(2);
    } finally {
      await s.release();
    }
  });

  test("lazily reconnects after the TTL window", async () => {
    const s = mgr(descriptor({ session: { ttlSec: 0.001 } }));
    try {
      await s.connect();
      expect(s.factoryCalls).toBe(1);
      await Bun.sleep(25);
      await s.run("true");
      expect(s.factoryCalls).toBe(2);
    } finally {
      await s.release();
    }
  });

  test("emits step + write events during escalation", async () => {
    const events: SessionEvent[] = [];
    const s = mgr(descriptor(), SU_HIGH, events);
    try {
      await s.connect();
      expect(events.some((e) => e.kind === "step" && e.text.includes("su - high"))).toBe(true);
      expect(events.some((e) => e.kind === "write" && e.text === "***")).toBe(true);
    } finally {
      await s.release();
    }
  });

  test("a command timeout drops the session; the next run reconnects cleanly (H6)", async () => {
    const s = mgr(descriptor());
    try {
      await s.connect();
      expect(s.factoryCalls).toBe(1);
      // marker never arrives within the timeout → the dirty PTY is released.
      await expect(s.run("sleep 5", { timeoutMs: 200 })).rejects.toBeDefined();
      const r = await s.run("echo back");
      expect(r.stdout).toBe("back");
      expect(s.factoryCalls).toBe(2);
    } finally {
      await s.release();
    }
  });

  test("caps oversized command output (M5)", async () => {
    const s = mgr(descriptor(), [], undefined, { maxStdoutBytes: 50 });
    try {
      await s.connect();
      const r = await s.run("printf 'x%.0s' $(seq 1 500)"); // 500 x's
      expect(r.truncated).toBe(true);
      expect(r.stdout.startsWith("x".repeat(50))).toBe(true);
      expect(r.stdout).toContain("truncated");
      expect(r.stdout.length).toBeLessThan(120);
      const small = await s.run("echo small");
      expect(small.truncated).toBe(false);
    } finally {
      await s.release();
    }
  });
});
