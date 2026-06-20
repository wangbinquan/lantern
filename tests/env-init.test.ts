import { describe, expect, test } from "bun:test";
import { buildEnvInitPlan, type EnvInitAnswers } from "../src/cli/env-init-plan";
import { type EnvInitDeps, runEnvInit } from "../src/cli/env-init";
import type { Asker } from "../src/cli/prompt";
import { EnvDescriptorSchema } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

function scriptedAsker(answers: string[]): Asker {
  let i = 0;
  return () => Promise.resolve(answers[i++] ?? "");
}

interface AddParams {
  env: EnvDescriptor;
  secrets: Record<string, string>;
}

function refsOf(env: EnvDescriptor): string[] {
  const s = new Set<string>();
  if (env.bastion.auth.secretRef) s.add(env.bastion.auth.secretRef);
  for (const e of env.escalate ?? []) s.add(e.secretRef);
  for (const h of env.hops ?? []) {
    s.add(h.viaSecretRef);
    s.add(h.sshSecretRef);
    for (const e of h.escalate ?? []) s.add(e.secretRef);
  }
  return [...s].sort();
}

const base: EnvInitAnswers = {
  id: "prod-a",
  form: "proprietary",
  bastion: {
    host: "10.1.2.3",
    loginUser: "ops",
    auth: { kind: "password", password: "pw-ops" },
    hostKeySha256: "abc123",
  },
};

describe("buildEnvInitPlan (RFC-0002 slice 1)", () => {
  test("bastion-only password auth", () => {
    const { env, secrets } = buildEnvInitPlan(base);
    expect(env.id).toBe("prod-a");
    expect(env.bastion.auth).toMatchObject({ type: "password", secretRef: "prod-a/bastion" });
    expect(secrets).toEqual({ "prod-a/bastion": "pw-ops" });
    expect(env.escalate).toBeUndefined();
    expect(() => EnvDescriptorSchema.parse(env)).not.toThrow();
  });

  test("bastion su chain → indexed refs", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      escalate: [
        { user: "approot", password: "pw1" },
        { user: "deeper", password: "pw2" },
      ],
    });
    expect(env.escalate).toEqual([
      { type: "su", user: "approot", secretRef: "prod-a/bastion-su0" },
      { type: "su", user: "deeper", secretRef: "prod-a/bastion-su1" },
    ]);
    expect(secrets["prod-a/bastion-su0"]).toBe("pw1");
    expect(secrets["prod-a/bastion-su1"]).toBe("pw2");
  });

  test("hop with its own su chain", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      hops: [
        {
          to: "192.168.10.5",
          viaUser: "jump",
          viaPassword: "vp",
          sshPassword: "sp",
          escalate: [{ user: "appadmin", password: "ap" }],
        },
      ],
    });
    expect(env.hops?.[0]).toEqual({
      to: "192.168.10.5",
      viaUser: "jump",
      viaSecretRef: "prod-a/hop0-via",
      sshSecretRef: "prod-a/hop0-ssh",
      escalate: [{ type: "su", user: "appadmin", secretRef: "prod-a/hop0-su0" }],
    });
    expect(secrets["prod-a/hop0-via"]).toBe("vp");
    expect(secrets["prod-a/hop0-ssh"]).toBe("sp");
    expect(secrets["prod-a/hop0-su0"]).toBe("ap");
  });

  test("key auth with passphrase", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      bastion: {
        host: "h",
        loginUser: "ops",
        auth: { kind: "key", keyPath: "/k/id", passphrase: "ph" },
        hostKeySha256: "x",
      },
    });
    expect(env.bastion.auth).toEqual({
      type: "key",
      keyPath: "/k/id",
      secretRef: "prod-a/bastion-key",
    });
    expect(secrets["prod-a/bastion-key"]).toBe("ph");
  });

  test("key auth without passphrase → no secret", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      bastion: {
        host: "h",
        loginUser: "ops",
        auth: { kind: "key", keyPath: "/k/id" },
        insecureHostKey: true,
      },
    });
    expect(env.bastion.auth).toEqual({ type: "key", keyPath: "/k/id" });
    expect(env.bastion.insecureHostKey).toBe(true);
    expect(secrets).toEqual({});
  });

  test("services (proprietary + k8s)", () => {
    const { env } = buildEnvInitPlan({
      ...base,
      services: [
        {
          name: "order-svc",
          runtime: "jvm",
          locate: { pid: "pgrep -f order" },
          logs: { file: "/app/x.log" },
        },
        { name: "web", runtime: "go", locate: { k8s: { namespace: "ns", selector: "app=web" } } },
      ],
    });
    expect(env.services?.length).toBe(2);
    expect(env.services?.[0]).toMatchObject({ name: "order-svc", runtime: "jvm" });
  });

  test("secrets keys exactly match the descriptor's secretRefs", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      escalate: [{ user: "approot", password: "p" }],
      hops: [
        {
          to: "10.0.0.2",
          viaUser: "jump",
          viaPassword: "v",
          sshPassword: "s",
          escalate: [{ user: "ad", password: "a" }],
        },
      ],
    });
    expect(Object.keys(secrets).sort()).toEqual(refsOf(env));
  });

  test("rejects a shell-metachar username (schema validation)", () => {
    expect(() =>
      buildEnvInitPlan({ ...base, escalate: [{ user: "root; rm -rf /", password: "p" }] }),
    ).toThrow();
  });

  test("rejects a bad host", () => {
    expect(() =>
      buildEnvInitPlan({ ...base, bastion: { ...base.bastion, host: "h$(id)" } }),
    ).toThrow();
  });
});

describe("runEnvInit flow (RFC-0002 slice 4)", () => {
  function captureDeps(answers: string[], over: Partial<EnvInitDeps> = {}) {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const deps: EnvInitDeps = {
      asker: scriptedAsker(answers),
      fetchFingerprint: () => ({
        hex: "deadbeefhex",
        display: "SHA256:Zm9v",
        keyType: "ssh-ed25519",
      }),
      send: (method, params) => {
        sent.push({ method, params });
        return Promise.resolve({ ok: true });
      },
      log: () => {},
      ...over,
    };
    return { sent, deps };
  }

  test("password bastion + host-key auto-pin + one service → env.add then env.use", async () => {
    // ordered answers: label, form, host, port, user, authKind, password,
    //   confirm-pin, su(none), confirm-hops(n), confirm-add-svc(default y),
    //   svc name, runtime, pid, logfile, confirm-add-svc(n)
    const { sent, deps } = captureDeps([
      "",
      "",
      "h",
      "",
      "ops",
      "",
      "pw-ops",
      "",
      "",
      "n",
      "",
      "order-svc",
      "",
      "pgrep -f order",
      "",
      "n",
    ]);
    await runEnvInit("prod-a", {}, deps);

    expect(sent.map((s) => s.method)).toEqual(["env.add", "env.use"]);
    const add = sent[0]!.params as unknown as AddParams;
    expect(add.env.bastion).toMatchObject({
      host: "h",
      loginUser: "ops",
      port: 22,
      hostKeySha256: "deadbeefhex",
    });
    expect(add.env.bastion.auth.type).toBe("password");
    expect(add.secrets[add.env.bastion.auth.secretRef!]).toBe("pw-ops");
    expect(add.env.services?.[0]).toMatchObject({
      name: "order-svc",
      runtime: "jvm",
      locate: { pid: "pgrep -f order" },
    });
    expect(sent[1]!.params).toEqual({ id: "prod-a" });
  });

  test("--insecure-host-key skips the fetch + pin; --no-use skips env.use", async () => {
    const { sent, deps } = captureDeps(
      ["", "", "h", "", "ops", "", "pw", "", "n", "n"], // no host-key Qs, no su/hop/svc
      {
        fetchFingerprint: () => {
          throw new Error("must not fetch when --insecure-host-key");
        },
      },
    );
    await runEnvInit("e", { insecureHostKey: true, noUse: true }, deps);

    expect(sent.map((s) => s.method)).toEqual(["env.add"]);
    const add = sent[0]!.params as unknown as AddParams;
    expect(add.env.bastion.insecureHostKey).toBe(true);
    expect(add.env.bastion.hostKeySha256).toBeUndefined();
  });
});
