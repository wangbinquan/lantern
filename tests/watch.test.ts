import { describe, expect, test } from "bun:test";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";
import { dispatch, EventBus, SessionPool, type DispatchDeps, type WatchEvent } from "../src/daemon";

function ev(env: string, text: string): WatchEvent {
  return { ts: 0, env, kind: "meta", text };
}

/** Collect the `text` of meta events delivered to a subscriber. */
function collector(into: string[]): (e: WatchEvent) => void {
  return (e) => {
    if (e.kind === "meta") into.push(e.text);
  };
}

describe("EventBus (RFC-0001)", () => {
  test("replays the ring buffer to a new subscriber, then delivers live", () => {
    const bus = new EventBus();
    bus.publish(ev("a", "1"));
    bus.publish(ev("a", "2"));
    const got: string[] = [];
    bus.subscribe(collector(got));
    expect(got).toEqual(["1", "2"]); // replay
    bus.publish(ev("a", "3"));
    expect(got).toEqual(["1", "2", "3"]); // live
  });

  test("replay: false skips the backlog", () => {
    const bus = new EventBus();
    bus.publish(ev("a", "old"));
    const got: string[] = [];
    bus.subscribe(collector(got), { replay: false });
    expect(got).toEqual([]);
    bus.publish(ev("a", "new"));
    expect(got).toEqual(["new"]);
  });

  test("ring buffer caps at bufferSize, dropping oldest", () => {
    const bus = new EventBus({ bufferSize: 2 });
    bus.publish(ev("a", "1"));
    bus.publish(ev("a", "2"));
    bus.publish(ev("a", "3"));
    expect(bus.buffered).toBe(2);
    const got: string[] = [];
    bus.subscribe(collector(got));
    expect(got).toEqual(["2", "3"]);
  });

  test("broadcasts to multiple subscribers", () => {
    const bus = new EventBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe(collector(a));
    bus.subscribe(collector(b));
    bus.publish(ev("x", "hi"));
    expect(a).toEqual(["hi"]);
    expect(b).toEqual(["hi"]);
    expect(bus.subscriberCount).toBe(2);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    const got: string[] = [];
    const off = bus.subscribe(collector(got));
    bus.publish(ev("a", "1"));
    off();
    bus.publish(ev("a", "2"));
    expect(got).toEqual(["1"]);
    expect(bus.subscriberCount).toBe(0);
  });

  test("a throwing subscriber does not break the others", () => {
    const bus = new EventBus();
    const got: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(collector(got));
    expect(() => bus.publish(ev("a", "ok"))).not.toThrow();
    expect(got).toEqual(["ok"]);
  });
});

describe("pool + dispatch → bus wiring (RFC-0001 slice 2)", () => {
  const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);

  test("a state command publishes connect/command/stdout/exit; catastrophic exec publishes denied", async () => {
    const registry = new Registry(":memory:");
    const env: EnvDescriptor = {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [{ name: "sys", runtime: "jvm", locate: { pid: "echo 4242" } }],
    };
    registry.upsertEnv(env);

    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    const deps: DispatchDeps = { registry, pool, bus };

    try {
      const r = await dispatch(deps, {
        id: 1,
        method: "state",
        params: { envId: "e", service: "sys" },
      });
      expect(r.ok).toBe(true);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("connect");
      expect(kinds).toContain("command");
      expect(kinds).toContain("stdout");
      expect(kinds).toContain("exit");
      const cmd = events.find((e) => e.kind === "command");
      expect(cmd?.kind === "command" && cmd.command).toContain("echo 4242");
      const connect = events.find((e) => e.kind === "connect");
      expect(connect?.kind === "connect" && connect.chain[0]).toBe("me@h");

      await dispatch(deps, {
        id: 2,
        method: "exec",
        params: { envId: "e", command: "rm -rf /tmp/x" },
      });
      const denied = events.find((e) => e.kind === "denied");
      expect(denied?.kind === "denied" && denied.reason).toContain("rm -rf");
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });
});
