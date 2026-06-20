import { describe, expect, test } from "bun:test";
import type { PtyTransport } from "../src/pty";
import {
  makeBastionFactory,
  makeHostVerifier,
  normalizeFingerprint,
  type Ssh2Config,
} from "../src/ssh";
import type { EnvDescriptor } from "../src/types";

function fakeTransport(): PtyTransport {
  return { write: () => {}, onData: () => {}, close: () => {}, exited: Promise.resolve(0) };
}

function descriptor(over: Partial<EnvDescriptor> = {}): EnvDescriptor {
  return {
    id: "env-A",
    form: "k8s",
    bastion: {
      host: "1.2.3.4",
      loginUser: "low",
      auth: { type: "password", secretRef: "low" },
      insecureHostKey: true,
    },
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
        insecureHostKey: true,
      },
    });
    await makeBastionFactory(env, (ref) => (ref === "low" ? "pw-low" : "?"), connect)();
    expect(captured).toMatchObject({
      host: "1.2.3.4",
      port: 2222,
      username: "low",
      password: "pw-low",
    });
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
      bastion: { host: "h", loginUser: "low", auth: { type: "password" }, insecureHostKey: true },
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
        insecureHostKey: true,
      },
    });
    await makeBastionFactory(env, (ref) => (ref === "pass" ? "phrase" : "?"), connect)();
    expect(captured?.privateKey).toContain("DUMMY-TEST-KEY");
    expect(captured?.passphrase).toBe("phrase");
    expect(captured?.password).toBeUndefined();
  });

  test("key auth without keyPath rejects", async () => {
    const env = descriptor({
      bastion: { host: "h", loginUser: "low", auth: { type: "key" }, insecureHostKey: true },
    });
    await expect(
      makeBastionFactory(
        env,
        () => "pw",
        async () => fakeTransport(),
      )(),
    ).rejects.toThrow(/keyPath/);
  });

  test("fails closed when the host key is not pinned (Codex H1)", async () => {
    const env = descriptor({
      bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "low" } },
    });
    await expect(
      makeBastionFactory(
        env,
        () => "pw",
        async () => fakeTransport(),
      )(),
    ).rejects.toThrow(/host key not pinned/);
  });

  test("passes the pinned fingerprint into the connect config", async () => {
    let captured: Ssh2Config | undefined;
    const connect = (cfg: Ssh2Config) => {
      captured = cfg;
      return Promise.resolve(fakeTransport());
    };
    const env = descriptor({
      bastion: {
        host: "h",
        loginUser: "low",
        auth: { type: "password", secretRef: "low" },
        hostKeySha256: "AB:CD",
      },
    });
    await makeBastionFactory(env, () => "pw", connect)();
    expect(captured?.hostKeySha256).toBe("AB:CD");
  });
});

describe("makeHostVerifier (Codex H1)", () => {
  test("insecure accepts any key", () => {
    expect(makeHostVerifier(undefined, true)("deadbeef")).toBe(true);
  });
  test("no pin + not insecure rejects (fail-closed)", () => {
    expect(makeHostVerifier(undefined, false)("deadbeef")).toBe(false);
  });
  test("matches the pinned fingerprint, normalized", () => {
    const v = makeHostVerifier("SHA256:AB:cd:EF");
    expect(v("abcdef")).toBe(true);
    expect(v("ABCDEF")).toBe(true);
    expect(v("ab:cd:ef")).toBe(true);
    expect(v("ab:cd:00")).toBe(false);
  });
  test("normalizeFingerprint strips SHA256:/colons + lowercases", () => {
    expect(normalizeFingerprint("SHA256:AB:CD")).toBe("abcd");
  });
});
