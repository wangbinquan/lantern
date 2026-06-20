import { describe, expect, test } from "bun:test";
import { resolveChain, resolveRole } from "../src/session";
import type { EnvDescriptor } from "../src/types";

function env(over: Partial<EnvDescriptor>): EnvDescriptor {
  return {
    id: "e",
    bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "e/low" } },
    roles: {},
    ...over,
  };
}

describe("resolveChain (RFC-0007 + RFC-0008)", () => {
  test("a bastion role → just its su chain", () => {
    const e = env({ roles: { r: { su: [{ type: "su", user: "x", secretRef: "e/x" }] } } });
    expect(resolveChain(e, "r")).toEqual([{ kind: "su", user: "x", secretRef: "e/x" }]);
  });

  test("a static node → via su + ssh + role su", () => {
    const e = env({
      nodes: {
        app1: {
          via: [{ type: "su", user: "j", secretRef: "e/j" }],
          to: "10.0.0.1",
          sshSecretRef: "e/ssh",
        },
      },
      roles: { r: { at: "app1", su: [{ type: "su", user: "root", secretRef: "e/root" }] } },
    });
    expect(resolveChain(e, "r")).toEqual([
      { kind: "su", user: "j", secretRef: "e/j" },
      { kind: "ssh", to: "10.0.0.1", secretRef: "e/ssh" },
      { kind: "su", user: "root", secretRef: "e/root" },
    ]);
  });

  test("a templated node substitutes the runtime target", () => {
    const e = env({
      nodes: { worker: { to: "${target}", sshSecretRef: "e/w", toPattern: "10\\.0\\.0\\.[0-9]+" } },
      roles: { w: { at: "worker" } },
    });
    expect(resolveChain(e, "w", "10.0.0.5")).toEqual([
      { kind: "ssh", to: "10.0.0.5", secretRef: "e/w" },
    ]);
  });

  test("a templated node requires a target", () => {
    const e = env({
      nodes: { worker: { to: "${target}", sshSecretRef: "e/w" } },
      roles: { w: { at: "worker" } },
    });
    expect(() => resolveChain(e, "w")).toThrow(/needs a target/);
  });

  test("a target failing toPattern is rejected", () => {
    const e = env({
      nodes: { worker: { to: "${target}", sshSecretRef: "e/w", toPattern: "10\\.0\\.0\\.[0-9]+" } },
      roles: { w: { at: "worker" } },
    });
    expect(() => resolveChain(e, "w", "192.168.1.1")).toThrow(/toPattern/);
  });

  test("a target with shell metacharacters is rejected", () => {
    const e = env({
      nodes: { worker: { to: "${target}", sshSecretRef: "e/w" } },
      roles: { w: { at: "worker" } },
    });
    expect(() => resolveChain(e, "w", "10.0.0.5; rm -rf /")).toThrow(/invalid target/);
  });

  test("a target on a non-templated role is rejected", () => {
    expect(() => resolveChain(env({ roles: { r: {} } }), "r", "10.0.0.5")).toThrow(
      /takes no target/,
    );
  });

  test("unknown role / node throw", () => {
    expect(() => resolveChain(env({ roles: { r: {} } }), "nope")).toThrow(/no role/);
    expect(() => resolveChain(env({ roles: { r: { at: "ghost" } } }), "r")).toThrow(/unknown node/);
  });
});

describe("resolveRole", () => {
  test("defaults to the sole role; requires a choice when several", () => {
    expect(resolveRole(env({ roles: { only: {} } }))).toBe("only");
    expect(resolveRole(env({ roles: { a: {}, b: {} } }), "b")).toBe("b");
    expect(() => resolveRole(env({ roles: { a: {}, b: {} } }))).toThrow(/pass a role/);
  });
});
