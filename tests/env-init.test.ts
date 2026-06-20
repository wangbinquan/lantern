import { describe, expect, test } from "bun:test";
import { buildEnvInitPlan, type EnvInitAnswers } from "../src/cli/env-init-plan";
import { EnvDescriptorSchema } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

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
