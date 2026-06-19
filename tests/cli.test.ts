import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli } from "../src/cli/args";
import { rpc } from "../src/cli/client";
import { Daemon, SessionPool } from "../src/daemon";
import type { RpcResponse, RunResultPayload } from "../src/daemon";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

describe("parseCli", () => {
  test("help variants", () => {
    expect(parseCli([]).kind).toBe("help");
    expect(parseCli(["--help"]).kind).toBe("help");
    expect(parseCli(["help"]).kind).toBe("help");
  });

  test("ping", () => {
    expect(parseCli(["ping"])).toEqual({ kind: "rpc", method: "ping", params: {} });
  });

  test("env list/current/use", () => {
    expect(parseCli(["env", "list"])).toMatchObject({ method: "env.list" });
    expect(parseCli(["env", "current"])).toMatchObject({ method: "env.current" });
    expect(parseCli(["env", "use", "env-A"])).toEqual({
      kind: "rpc",
      method: "env.use",
      params: { id: "env-A" },
    });
    expect(parseCli(["env", "use"]).kind).toBe("error");
    expect(parseCli(["env", "bogus"]).kind).toBe("error");
  });

  test("logs flags", () => {
    expect(
      parseCli(["logs", "--service", "svc", "--env", "E", "--grep", "ERR", "--tail", "50"]),
    ).toEqual({
      kind: "rpc",
      method: "logs",
      params: { service: "svc", envId: "E", grep: "ERR", tail: 50 },
    });
  });

  test("logs --grep-b64 decodes the pattern", () => {
    const b64 = Buffer.from("a|b").toString("base64");
    const parsed = parseCli(["logs", "--service", "svc", "--grep-b64", b64]);
    expect(parsed).toMatchObject({ method: "logs", params: { grep: "a|b" } });
  });

  test("logs/state require --service", () => {
    expect(parseCli(["logs", "--env", "E"]).kind).toBe("error");
    expect(parseCli(["state", "--env", "E"]).kind).toBe("error");
  });

  test("exec via --command and via -- passthrough", () => {
    expect(parseCli(["exec", "--env", "E", "--command", "echo hi"])).toEqual({
      kind: "rpc",
      method: "exec",
      params: { envId: "E", command: "echo hi" },
    });
    expect(parseCli(["exec", "--env", "E", "--", "echo", "hi"])).toEqual({
      kind: "rpc",
      method: "exec",
      params: { envId: "E", command: "echo hi" },
    });
    expect(parseCli(["exec", "--env", "E"]).kind).toBe("error");
  });

  test("unknown command is an error", () => {
    expect(parseCli(["frobnicate"]).kind).toBe("error");
  });
});

describe("unix socket round-trip (Daemon <-> rpc client)", () => {
  function localFactory() {
    return () =>
      spawnPty(["bash", "--norc", "--noprofile"], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", LANG: "C" },
      });
  }

  test("ping, env.use, and exec over the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-sock-"));
    const socketPath = join(dir, "d.sock");
    const registry = new Registry(":memory:");
    const env: EnvDescriptor = {
      id: "envX",
      form: "proprietary",
      bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "low" } },
      services: [{ name: "svc", runtime: "jvm" }],
    };
    registry.upsertEnv(env);
    const pool = new SessionPool(registry, () => localFactory(), { commandTimeoutMs: 5000 });
    const daemon = new Daemon({ registry, pool });
    daemon.listen(socketPath);

    try {
      const pong = (await rpc(socketPath, { id: 1, method: "ping" })) as RpcResponse<{
        pong: boolean;
      }>;
      expect(pong.ok && pong.result.pong).toBe(true);

      const used = await rpc(socketPath, { id: 2, method: "env.use", params: { id: "envX" } });
      expect(used.ok).toBe(true);

      const ex = (await rpc(socketPath, {
        id: 3,
        method: "exec",
        params: { command: "echo socktest" },
      })) as RpcResponse<RunResultPayload>;
      expect(ex.ok).toBe(true);
      if (ex.ok) {
        expect(ex.result.stdout).toBe("socktest");
        expect(ex.result.exitCode).toBe(0);
        expect(ex.result.verdict).toBe("read");
      }

      const bad = await rpc(socketPath, {
        id: 4,
        method: "exec",
        params: { command: "rm -rf /tmp/x" },
      });
      expect(bad.ok).toBe(false);
    } finally {
      daemon.stop();
      await pool.releaseAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
