import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvDescriptorSchema, Registry, RegistryError } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const SAMPLE: EnvDescriptor = {
  id: "env-A-dev",
  label: "订单域-研发环境A",
  bastion: {
    host: "1.2.3.4",
    port: 22,
    loginUser: "low",
    auth: { type: "password", secretRef: "env-A/low" },
  },
  nodes: {
    app1: {
      via: [{ type: "su", user: "jump", secretRef: "env-A/jump", promptRe: "[Pp]assword:" }],
      to: "10.0.0.12",
      sshSecretRef: "env-A/node12",
    },
  },
  roles: {
    diagnose: { at: "app1", su: [{ type: "su", user: "high", secretRef: "env-A/high" }] },
    deploy: { su: [{ type: "su", user: "deployer", secretRef: "env-A/deployer" }] },
  },
  shellInit: "stty -echo 2>/dev/null; export LANG=C",
  session: { ttlSec: 1800, idleSec: 600 },
};

describe("Registry (in-memory)", () => {
  test("upsert + getEnv round-trips the full descriptor", () => {
    const r = new Registry(":memory:");
    r.upsertEnv(SAMPLE);
    expect(r.getEnv("env-A-dev")).toEqual(SAMPLE);
    r.close();
  });

  test("getEnv returns null for unknown id", () => {
    const r = new Registry(":memory:");
    expect(r.getEnv("nope")).toBeNull();
    r.close();
  });

  test("upsert overwrites; listEnvs returns summaries", () => {
    const r = new Registry(":memory:");
    r.upsertEnv(SAMPLE);
    r.upsertEnv({ ...SAMPLE, id: "env-B", label: "B" });
    r.upsertEnv({ ...SAMPLE, label: "A-renamed" });
    const list = r.listEnvs();
    expect(list).toEqual([
      { id: "env-A-dev", label: "A-renamed" },
      { id: "env-B", label: "B" },
    ]);
    r.close();
  });

  test("removeEnv reports whether a row was deleted", () => {
    const r = new Registry(":memory:");
    r.upsertEnv(SAMPLE);
    expect(r.removeEnv("env-A-dev")).toBe(true);
    expect(r.removeEnv("env-A-dev")).toBe(false);
    expect(r.getEnv("env-A-dev")).toBeNull();
    r.close();
  });

  test("invalid descriptor is rejected on upsert", () => {
    const r = new Registry(":memory:");
    // missing bastion
    expect(() => r.upsertEnv({ id: "bad" } as unknown as EnvDescriptor)).toThrow();
    // shell-metacharacter username / host are rejected (Codex H2 defense-in-depth)
    expect(() =>
      r.upsertEnv({
        ...SAMPLE,
        bastion: { ...SAMPLE.bastion, loginUser: "low; rm -rf /" },
      }),
    ).toThrow();
    expect(() =>
      r.upsertEnv({ ...SAMPLE, bastion: { ...SAMPLE.bastion, host: "h$(id)" } }),
    ).toThrow();
    r.close();
  });

  test("secrets: set/get/resolve + missing-ref throws", () => {
    const r = new Registry(":memory:");
    r.setSecret("env-A/high", "pw-high");
    expect(r.getSecret("env-A/high")).toBe("pw-high");
    expect(r.resolveSecret("env-A/high")).toBe("pw-high");
    r.setSecret("env-A/high", "pw-high-2"); // overwrite
    expect(r.getSecret("env-A/high")).toBe("pw-high-2");
    expect(r.getSecret("missing")).toBeNull();
    expect(() => r.resolveSecret("missing")).toThrow(RegistryError);
    expect(r.removeSecret("env-A/high")).toBe(true);
    r.close();
  });

  test("setCurrent validates env exists; getCurrent reflects it", () => {
    const r = new Registry(":memory:");
    expect(() => r.setCurrent("env-A-dev")).toThrow(RegistryError);
    r.upsertEnv(SAMPLE);
    r.setCurrent("env-A-dev");
    expect(r.getCurrent()).toBe("env-A-dev");
    r.close();
  });

  test("schema output is assignable to EnvDescriptor (drift guard)", () => {
    const parsed = EnvDescriptorSchema.parse(SAMPLE);
    const asEnv: EnvDescriptor = parsed; // compile-time assignability check
    expect(asEnv.id).toBe(SAMPLE.id);
  });
});

describe("Registry (file persistence)", () => {
  test("data survives close + reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-reg-"));
    const path = join(dir, "registry.db");
    try {
      const a = new Registry(path);
      a.upsertEnv(SAMPLE);
      a.setSecret("env-A/high", "pw-high");
      a.setCurrent("env-A-dev");
      a.close();

      const b = new Registry(path);
      expect(b.getEnv("env-A-dev")).toEqual(SAMPLE);
      expect(b.getSecret("env-A/high")).toBe("pw-high");
      expect(b.getCurrent()).toBe("env-A-dev");
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("constructor creates the parent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-reg-"));
    const path = join(dir, "nested", "deep", "registry.db");
    try {
      const r = new Registry(path);
      r.upsertEnv(SAMPLE);
      expect(r.getEnv("env-A-dev")?.id).toBe("env-A-dev");
      r.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
