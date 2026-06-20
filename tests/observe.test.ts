import { describe, expect, test } from "bun:test";
import {
  buildObserve,
  buildObserveStop,
  dispatch,
  EventBus,
  ObserveError,
  SessionPool,
  type WatchEvent,
} from "../src/daemon";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor, ServiceDescriptor } from "../src/types";

const svc = (arthasJar?: string): ServiceDescriptor => ({
  name: "order-svc",
  runtime: "jvm",
  diag: arthasJar ? { arthasJar } : undefined,
});

const JAR = "/opt/arthas/arthas-boot.jar";

describe("buildObserve (RFC-0004 slice 1)", () => {
  test("watch uses the FIXED safe expression + bounded -n, batch-mode + stop", () => {
    const cmd = buildObserve(
      svc(JAR),
      { op: "watch", className: "com.x.OrderService", method: "price", count: 5 },
      "1234",
    );
    expect(cmd).toBe(
      "java -jar '/opt/arthas/arthas-boot.jar' 1234 --batch-mode -c " +
        "'watch com.x.OrderService price '\\''{params,returnObj,throwExp}'\\'' -n 5 ; stop'",
    );
  });

  test("trace / stack / tt forms", () => {
    const o = (op: "trace" | "stack" | "tt") =>
      buildObserve(svc(JAR), { op, className: "C", method: "m", count: 3 }, "9");
    expect(o("trace")).toContain("-c 'trace C m -n 3 ; stop'");
    expect(o("stack")).toContain("-c 'stack C m -n 3 ; stop'");
    expect(o("tt")).toContain("-c 'tt -t C m -n 3 ; stop'");
  });

  test("count clamps to 1..1000 (default 10); NaN falls back to 10 (L-1)", () => {
    const n = (count?: number) =>
      buildObserve(svc(JAR), { op: "trace", className: "C", method: "m", count }, "1");
    expect(n(5000)).toContain("-n 1000 ");
    expect(n(0)).toContain("-n 1 ");
    expect(n(-3)).toContain("-n 1 ");
    expect(n(undefined)).toContain("-n 10 ");
    expect(n(Number.NaN)).toContain("-n 10 ");
  });

  test("rejects an op that is not read-only", () => {
    expect(() =>
      buildObserve(svc(JAR), { op: "redefine" as never, className: "C", method: "m" }, "1"),
    ).toThrow(ObserveError);
  });

  test("rejects class / method with shell metacharacters", () => {
    expect(() =>
      buildObserve(svc(JAR), { op: "watch", className: "C; rm -rf /", method: "m" }, "1"),
    ).toThrow(/invalid class/);
    expect(() =>
      buildObserve(svc(JAR), { op: "watch", className: "C", method: "m()" }, "1"),
    ).toThrow(/invalid method/);
  });

  test("allows wildcards, inner classes, and <init>", () => {
    expect(() =>
      buildObserve(svc(JAR), { op: "watch", className: "com.x.*$Inner", method: "<init>" }, "1"),
    ).not.toThrow();
  });

  test("requires diag.arthasJar and a numeric pid", () => {
    expect(() => buildObserve(svc(), { op: "watch", className: "C", method: "m" }, "1")).toThrow(
      /arthasJar/,
    );
    expect(() =>
      buildObserve(svc(JAR), { op: "watch", className: "C", method: "m" }, "1; rm"),
    ).toThrow(/invalid pid/);
  });

  test("--max-seconds wraps with timeout; 0/NaN/undefined → no wrapper (RFC-0004 §6)", () => {
    expect(
      buildObserve(
        svc(JAR),
        { op: "trace", className: "C", method: "m", count: 3, maxSeconds: 30 },
        "9",
      ),
    ).toBe(
      "timeout 30 java -jar '/opt/arthas/arthas-boot.jar' 9 --batch-mode -c 'trace C m -n 3 ; stop'",
    );
    const noWrap = (maxSeconds?: number) =>
      buildObserve(svc(JAR), { op: "trace", className: "C", method: "m", maxSeconds }, "9");
    expect(noWrap(0).startsWith("java")).toBe(true);
    expect(noWrap(Number.NaN).startsWith("java")).toBe(true);
    expect(noWrap(undefined).startsWith("java")).toBe(true);
  });

  test("buildObserveStop detaches the agent", () => {
    expect(buildObserveStop(svc(JAR), "1234")).toBe(
      "java -jar '/opt/arthas/arthas-boot.jar' 1234 --batch-mode -c stop",
    );
    expect(() => buildObserveStop(svc(), "1")).toThrow(/arthasJar/);
    expect(() => buildObserveStop(svc(JAR), "1; rm")).toThrow(/invalid pid/);
  });
});

describe("observe dispatch (LOCAL_SHELL: pid resolve + command construction)", () => {
  const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);

  test("resolves a numeric pid, builds + publishes the Arthas command", async () => {
    const env: EnvDescriptor = {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [
        { name: "svc", runtime: "jvm", locate: { pid: "echo 4242" }, diag: { arthasJar: JAR } },
      ],
    };
    const registry = new Registry(":memory:");
    registry.upsertEnv(env);
    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    try {
      // the java -jar against a non-existent arthas jar will fail, but the command
      // is constructed + published before pool.run, which is what we assert here.
      const r = await dispatch(
        { registry, pool, bus },
        {
          id: 1,
          method: "observe",
          params: {
            envId: "e",
            service: "svc",
            op: "watch",
            class: "com.x.OrderService",
            method: "price",
            count: 5,
          },
        },
      );
      expect(r.ok).toBe(true);
      const cmd = events.find((e) => e.kind === "command" && e.method === "observe");
      expect(cmd?.kind === "command" && cmd.command).toContain(
        "watch com.x.OrderService price '\\''{params,returnObj,throwExp}'\\'' -n 5 ; stop",
      );
      expect(cmd?.kind === "command" && cmd.command).toContain("4242 --batch-mode");
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("ignores noisy locate output, resolves the pure-numeric PID (M-3)", async () => {
    const env: EnvDescriptor = {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [
        {
          name: "svc",
          runtime: "jvm",
          locate: { pid: "echo 'warn 2026'; echo 4242" }, // noise line + real pid line
          diag: { arthasJar: JAR },
        },
      ],
    };
    const registry = new Registry(":memory:");
    registry.upsertEnv(env);
    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    try {
      await dispatch(
        { registry, pool, bus },
        {
          id: 1,
          method: "observe",
          params: { envId: "e", service: "svc", op: "trace", class: "C", method: "m" },
        },
      );
      const cmd = events.find((e) => e.kind === "command" && e.method === "observe");
      expect(cmd?.kind === "command" && cmd.command).toContain("4242 --batch-mode");
      expect(cmd?.kind === "command" && cmd.command).not.toContain("2026 --batch-mode");
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("a NaN --timeout falls back to the default and still runs (numOpt L-1 follow-up)", async () => {
    const env: EnvDescriptor = {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [
        { name: "svc", runtime: "jvm", locate: { pid: "echo 4242" }, diag: { arthasJar: JAR } },
      ],
    };
    const registry = new Registry(":memory:");
    registry.upsertEnv(env);
    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    try {
      // a NaN timeout would immediately fail the locate run if numOpt didn't reject it
      await dispatch(
        { registry, pool, bus },
        {
          id: 1,
          method: "observe",
          params: {
            envId: "e",
            service: "svc",
            op: "trace",
            class: "C",
            method: "m",
            timeoutMs: Number.NaN,
          },
        },
      );
      const cmd = events.find((e) => e.kind === "command" && e.method === "observe");
      expect(cmd).toBeDefined(); // pid resolved + command built despite the NaN timeout
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("--stop builds the Arthas detach command (no op/class/method)", async () => {
    const env: EnvDescriptor = {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [
        { name: "svc", runtime: "jvm", locate: { pid: "echo 4242" }, diag: { arthasJar: JAR } },
      ],
    };
    const registry = new Registry(":memory:");
    registry.upsertEnv(env);
    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    try {
      await dispatch(
        { registry, pool, bus },
        {
          id: 1,
          method: "observe",
          params: { envId: "e", service: "svc", stop: true },
        },
      );
      const cmd = events.find((e) => e.kind === "command" && e.method === "observe");
      expect(cmd?.kind === "command" && cmd.command).toContain("4242 --batch-mode -c stop");
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });
});
