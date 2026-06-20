import { describe, expect, test } from "bun:test";
import { spawnPty } from "../src/pty";
import { SessionError, SessionManager, type SessionEvent, type SessionOptions } from "../src/ssh";
import type { EnvDescriptor } from "../src/types";

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
    ...over,
  };
}

function mgr(desc: EnvDescriptor, events?: SessionEvent[], extra: Partial<SessionOptions> = {}) {
  return new SessionManager(factory(), desc, {
    resolveSecret,
    whoamiCmd: WHOAMI,
    syncTimeoutMs: 5000,
    commandTimeoutMs: 5000,
    onEvent: events ? (e) => events.push(e) : undefined,
    ...extra,
  });
}

describe("SessionManager", () => {
  test("escalates via su and runs commands as the target user", async () => {
    const s = mgr(descriptor({ escalate: [{ type: "su", user: "high", secretRef: "high" }] }));
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
    const s = mgr(
      descriptor({
        hops: [
          {
            to: "10.0.0.12",
            viaUser: "jump",
            viaSecretRef: "jump",
            sshSecretRef: "node12",
            escalate: [{ type: "su", user: "high", secretRef: "high" }],
          },
        ],
      }),
    );
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
      descriptor({ escalate: [{ type: "su", user: "high", secretRef: "high" }] }),
      { resolveSecret: () => "wrong-password", whoamiCmd: WHOAMI, syncTimeoutMs: 4000 },
    );
    await expect(s.connect()).rejects.toBeInstanceOf(SessionError);
    await s.release();
  });

  test("redacts passwords in events and command output", async () => {
    const events: SessionEvent[] = [];
    const s = mgr(
      descriptor({ escalate: [{ type: "su", user: "high", secretRef: "high" }] }),
      events,
    );
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
    const s = mgr(
      descriptor({ escalate: [{ type: "su", user: "high", secretRef: "high" }] }),
      events,
    );
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
    const s = mgr(descriptor(), undefined, { maxStdoutBytes: 50 });
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
