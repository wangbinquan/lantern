import { describe, expect, test } from "bun:test";
import type { PtyTransport } from "../src/pty";
import { makeBastionFactory, type Ssh2Config } from "../src/ssh";
import type { EnvDescriptor } from "../src/types";

function fakeTransport(): PtyTransport {
  return {
    write: () => {},
    onData: () => {},
    close: () => {},
    exited: Promise.resolve(0),
  };
}

function descriptor(over: Partial<EnvDescriptor> = {}): EnvDescriptor {
  return {
    id: "env-A",
    form: "k8s",
    bastion: { host: "1.2.3.4", loginUser: "low", auth: { type: "password", secretRef: "low" } },
    ...over,
  };
}

describe("makeBastionFactory", () => {
  test("password auth: connects with the resolved password + explicit port", async () => {
    let captured: Ssh2Config | undefined;
    const connect = (cfg: Ssh2Config) => {
      captured = cfg;
      return Promise.resolve(fakeTransport());
    };
    const env = descriptor({
      bastion: {
        host: "1.2.3.4",
        port: 2222,
        loginUser: "low",
        auth: { type: "password", secretRef: "low" },
      },
    });
    const factory = makeBastionFactory(env, (ref) => (ref === "low" ? "pw-low" : "?"), connect);
    await factory();
    expect(captured).toEqual({ host: "1.2.3.4", port: 2222, username: "low", password: "pw-low" });
  });

  test("password auth: defaults the port to 22", async () => {
    let captured: Ssh2Config | undefined;
    const connect = (cfg: Ssh2Config) => {
      captured = cfg;
      return Promise.resolve(fakeTransport());
    };
    await makeBastionFactory(descriptor(), () => "pw", connect)();
    expect(captured?.port).toBe(22);
    expect(captured?.username).toBe("low");
  });

  test("password auth without secretRef rejects", async () => {
    const env = descriptor({
      bastion: { host: "h", loginUser: "low", auth: { type: "password" } },
    });
    await expect(
      makeBastionFactory(
        env,
        () => "pw",
        async () => fakeTransport(),
      )(),
    ).rejects.toThrow(/secretRef/);
  });

  test("key auth reads the key file (+ passphrase)", async () => {
    let captured: Ssh2Config | undefined;
    const connect = (cfg: Ssh2Config) => {
      captured = cfg;
      return Promise.resolve(fakeTransport());
    };
    const env = descriptor({
      bastion: {
        host: "h",
        loginUser: "low",
        auth: { type: "key", keyPath: `${import.meta.dir}/fixtures/fake_key`, secretRef: "pass" },
      },
    });
    await makeBastionFactory(env, (ref) => (ref === "pass" ? "phrase" : "?"), connect)();
    expect(captured?.privateKey).toContain("DUMMY-TEST-KEY");
    expect(captured?.passphrase).toBe("phrase");
    expect(captured?.password).toBeUndefined();
  });

  test("key auth without keyPath rejects", async () => {
    const env = descriptor({
      bastion: { host: "h", loginUser: "low", auth: { type: "key" } },
    });
    await expect(
      makeBastionFactory(
        env,
        () => "pw",
        async () => fakeTransport(),
      )(),
    ).rejects.toThrow(/keyPath/);
  });
});
