import { describe, expect, test } from "bun:test";
import {
  buildEnvInitPlan,
  buildNodePlan,
  buildRolePlan,
  type EnvInitAnswers,
} from "../src/cli/env-init-plan";
import { type EnvInitDeps, promptNode, promptRole, runEnvInit } from "../src/cli/env-init";
import type { Asker } from "../src/cli/prompt";
import { EnvDescriptorSchema, Registry } from "../src/registry";
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
  for (const node of Object.values(env.nodes ?? {})) {
    s.add(node.sshSecretRef);
    for (const v of node.via ?? []) s.add(v.secretRef);
  }
  for (const role of Object.values(env.roles)) {
    for (const su of role.su ?? []) s.add(su.secretRef);
  }
  return [...s].sort();
}

// minimal valid answers: bastion + one bastion role
const base: EnvInitAnswers = {
  id: "prod-a",
  bastion: {
    host: "10.1.2.3",
    loginUser: "ops",
    auth: { kind: "password", password: "pw-ops" },
    hostKeySha256: "abc123",
  },
  roles: [{ name: "default" }],
};

describe("buildEnvInitPlan (RFC-0007)", () => {
  test("bastion-only password auth + a bare role", () => {
    const { env, secrets } = buildEnvInitPlan(base);
    expect(env.id).toBe("prod-a");
    expect(env.bastion.auth).toMatchObject({ type: "password", secretRef: "prod-a/bastion" });
    expect(secrets).toEqual({ "prod-a/bastion": "pw-ops" });
    expect(env.roles).toEqual({ default: {} });
    expect(env.nodes).toBeUndefined();
    expect(() => EnvDescriptorSchema.parse(env)).not.toThrow();
  });

  test("role su chain → indexed refs", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      roles: [
        {
          name: "deploy",
          su: [
            { user: "approot", password: "pw1" },
            { user: "deeper", password: "pw2" },
          ],
        },
      ],
    });
    expect(env.roles.deploy?.su).toEqual([
      { type: "su", user: "approot", secretRef: "prod-a/role-deploy-su0" },
      { type: "su", user: "deeper", secretRef: "prod-a/role-deploy-su1" },
    ]);
    expect(secrets["prod-a/role-deploy-su0"]).toBe("pw1");
    expect(secrets["prod-a/role-deploy-su1"]).toBe("pw2");
  });

  test("node with a via chain + a role landing on it", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      nodes: [
        {
          name: "app1",
          via: [{ user: "jump", password: "vp" }],
          to: "192.168.10.5",
          sshPassword: "sp",
        },
      ],
      roles: [{ name: "restart", at: "app1", su: [{ user: "appadmin", password: "ap" }] }],
    });
    expect(env.nodes?.app1).toEqual({
      via: [{ type: "su", user: "jump", secretRef: "prod-a/node-app1-via0" }],
      to: "192.168.10.5",
      sshSecretRef: "prod-a/node-app1-ssh",
    });
    expect(env.roles.restart).toEqual({
      at: "app1",
      su: [{ type: "su", user: "appadmin", secretRef: "prod-a/role-restart-su0" }],
    });
    expect(secrets["prod-a/node-app1-via0"]).toBe("vp");
    expect(secrets["prod-a/node-app1-ssh"]).toBe("sp");
    expect(secrets["prod-a/role-restart-su0"]).toBe("ap");
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

  test("secrets keys exactly match the descriptor's secretRefs", () => {
    const { env, secrets } = buildEnvInitPlan({
      ...base,
      nodes: [
        { name: "n1", via: [{ user: "jump", password: "v" }], to: "10.0.0.2", sshPassword: "s" },
      ],
      roles: [
        { name: "ops", at: "n1", su: [{ user: "ad", password: "a" }] },
        { name: "xfer", su: [{ user: "dep", password: "d" }] },
      ],
    });
    expect(Object.keys(secrets).sort()).toEqual(refsOf(env));
  });

  test("rejects a shell-metachar username (schema validation)", () => {
    expect(() =>
      buildEnvInitPlan({
        ...base,
        roles: [{ name: "x", su: [{ user: "root; rm -rf /", password: "p" }] }],
      }),
    ).toThrow();
  });

  test("rejects a bad host", () => {
    expect(() =>
      buildEnvInitPlan({ ...base, bastion: { ...base.bastion, host: "h$(id)" } }),
    ).toThrow();
  });

  test("rejects an env with no roles", () => {
    expect(() => buildEnvInitPlan({ ...base, roles: [] })).toThrow();
  });

  test("rejects a role.at that names no node", () => {
    expect(() => buildEnvInitPlan({ ...base, roles: [{ name: "x", at: "ghost" }] })).toThrow();
  });
});

describe("incremental role / node (lantern env role|node add)", () => {
  test("buildRolePlan builds one role + its secrets", () => {
    const { role, secrets } = buildRolePlan("prod-a", {
      name: "restart",
      at: "app1",
      su: [{ user: "svc", password: "p" }],
    });
    expect(role).toEqual({
      at: "app1",
      su: [{ type: "su", user: "svc", secretRef: "prod-a/role-restart-su0" }],
    });
    expect(secrets).toEqual({ "prod-a/role-restart-su0": "p" });
  });

  test("buildNodePlan builds one node + its secrets", () => {
    const { node, secrets } = buildNodePlan("prod-a", {
      name: "app1",
      via: [{ user: "jump", password: "v" }],
      to: "10.0.0.9",
      sshPassword: "s",
    });
    expect(node).toEqual({
      via: [{ type: "su", user: "jump", secretRef: "prod-a/node-app1-via0" }],
      to: "10.0.0.9",
      sshSecretRef: "prod-a/node-app1-ssh",
    });
    expect(secrets).toEqual({ "prod-a/node-app1-via0": "v", "prod-a/node-app1-ssh": "s" });
  });

  test("promptRole collects at + su; bastion → at undefined", async () => {
    expect(
      await promptRole(scriptedAsker(["app1", "svcuser", "svcpw", ""]), "restart", ["app1"]),
    ).toEqual({
      name: "restart",
      at: "app1",
      su: [{ user: "svcuser", password: "svcpw" }],
    });
    expect(await promptRole(scriptedAsker(["", "deployer", "dp", ""]), "filexfer", [])).toEqual({
      name: "filexfer",
      at: undefined,
      su: [{ user: "deployer", password: "dp" }],
    });
  });

  test("promptNode collects via + to + ssh password", async () => {
    expect(await promptNode(scriptedAsker(["jump", "jp", "", "10.0.0.9", "sp"]), "app1")).toEqual({
      name: "app1",
      via: [{ user: "jump", password: "jp" }],
      to: "10.0.0.9",
      sshPassword: "sp",
    });
  });

  test("adding a role merges into the env and re-validates on upsert", () => {
    const reg = new Registry(":memory:");
    reg.upsertEnv({
      id: "e",
      bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "e/low" } },
      nodes: { app1: { to: "10.0.0.9", sshSecretRef: "e/app1-ssh" } },
      roles: { base: {} },
    });
    const env = reg.getEnv("e")!;
    const { role } = buildRolePlan("e", {
      name: "restart",
      at: "app1",
      su: [{ user: "svc", password: "p" }],
    });
    env.roles.restart = role;
    reg.upsertEnv(env);
    expect(Object.keys(reg.getEnv("e")!.roles).sort()).toEqual(["base", "restart"]);
    // a role.at that names no node is rejected by the same upsert path
    env.roles.bad = { at: "ghost" };
    expect(() => reg.upsertEnv(env)).toThrow();
    reg.close();
  });
});

describe("runEnvInit flow (RFC-0007)", () => {
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

  test("password bastion + host-key auto-pin + one bastion role → env.add then env.use", async () => {
    // label, host, port, user, authKind, password, confirm-pin, nodes?(n),
    //   role: name, at(default bastion), su(none), more-roles(n)
    const { sent, deps } = captureDeps([
      "",
      "h",
      "",
      "ops",
      "",
      "pw-ops",
      "",
      "n",
      "default",
      "",
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
    expect(add.env.roles).toEqual({ default: {} });
    expect(add.secrets[add.env.bastion.auth.secretRef!]).toBe("pw-ops");
    expect(sent[1]!.params).toEqual({ id: "prod-a" });
  });

  test("a node + two roles across bastion and node", async () => {
    const { sent, deps } = captureDeps([
      "prod",
      "h",
      "",
      "low",
      "",
      "pw",
      "", // bastion + pin
      "y", // configure nodes?
      "app1",
      "jump",
      "jp",
      "",
      "10.0.0.12",
      "sp", // node1: name, via-user, via-pw, via-stop, to, ssh-pw
      "n", // more nodes?
      "restart",
      "app1",
      "svcuser",
      "svcpw",
      "", // role1: name, at, su-user, su-pw, su-stop
      "y", // more roles?
      "filexfer",
      "",
      "deployer",
      "deppw",
      "", // role2: name, at(bastion), su-user, su-pw, su-stop
      "n", // more roles?
    ]);
    await runEnvInit("prod-a", { noUse: true }, deps);

    const add = sent[0]!.params as unknown as AddParams;
    expect(add.env.nodes?.app1?.to).toBe("10.0.0.12");
    expect(add.env.nodes?.app1?.via?.[0]).toMatchObject({ type: "su", user: "jump" });
    expect(add.env.roles.restart).toMatchObject({ at: "app1" });
    expect(add.env.roles.restart?.su?.[0]).toMatchObject({ user: "svcuser" });
    expect(add.env.roles.filexfer?.at).toBeUndefined(); // bastion
    expect(add.env.roles.filexfer?.su?.[0]).toMatchObject({ user: "deployer" });
    // passwords landed in the secrets map under the generated refs
    expect(Object.values(add.secrets)).toEqual(
      expect.arrayContaining(["jp", "sp", "svcpw", "deppw"]),
    );
  });

  test("--insecure-host-key skips the fetch + pin; --no-use skips env.use", async () => {
    const { sent, deps } = captureDeps(
      ["", "h", "", "ops", "", "pw", "n", "default", "", "", "n"], // no host-key Qs
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

  test("scan failure + declined insecure → aborts, never silently insecure (H-1)", async () => {
    // label, host, port, user, authKind, password, manual(blank), confirm-insecure(n)
    const { deps } = captureDeps(["", "h", "", "ops", "", "pw", "", "n"], {
      fetchFingerprint: () => null,
    });
    await expect(runEnvInit("e", {}, deps)).rejects.toThrow(/host key not pinned/);
  });

  test("scan failure + EXPLICIT insecure confirmation sets insecureHostKey (H-1)", async () => {
    const { sent, deps } = captureDeps(
      ["", "h", "", "ops", "", "pw", "", "y", "n", "default", "", "", "n"],
      { fetchFingerprint: () => null },
    );
    await runEnvInit("e", {}, deps);
    const add = sent[0]!.params as unknown as AddParams;
    expect(add.env.bastion.insecureHostKey).toBe(true);
    expect(add.env.bastion.hostKeySha256).toBeUndefined();
  });
});
