import { describe, expect, test } from "bun:test";
import { parseCli } from "../src/cli/args";
import { buildSnapshot, CommandError } from "../src/daemon";
import type { Runtime, ServiceDescriptor } from "../src/types";

const svc = (runtime: Runtime, pid?: string): ServiceDescriptor => ({
  name: "s",
  runtime,
  locate: pid ? { pid } : undefined,
});

describe("buildSnapshot (read-only by construction)", () => {
  test("jvm -> jstack of the remotely-resolved pid", () => {
    expect(buildSnapshot(svc("jvm", "pgrep -f app"))).toBe("jstack $(pgrep -f app | head -n 1)");
  });
  test("python -> py-spy dump", () => {
    expect(buildSnapshot(svc("python", "echo 1"))).toBe("py-spy dump --pid $(echo 1 | head -n 1)");
  });
  test("go -> proc status", () => {
    expect(buildSnapshot(svc("go", "echo 1"))).toBe("cat /proc/$(echo 1 | head -n 1)/status");
  });
  test("requires locate.pid", () => {
    expect(() => buildSnapshot(svc("jvm"))).toThrow(CommandError);
  });
});

describe("parseCli snapshot", () => {
  test("snapshot --service --env", () => {
    expect(parseCli(["snapshot", "--service", "svc", "--env", "E"])).toEqual({
      kind: "rpc",
      method: "snapshot",
      params: { service: "svc", envId: "E" },
    });
  });
  test("snapshot requires --service", () => {
    expect(parseCli(["snapshot", "--env", "E"]).kind).toBe("error");
  });
});
