import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore, Registry, SqliteSecretStore } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

describe("MemorySecretStore", () => {
  test("set/get/overwrite/remove", () => {
    const s = new MemorySecretStore();
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
    s.set("a", "2");
    expect(s.get("a")).toBe("2");
    expect(s.get("missing")).toBeNull();
    expect(s.remove("a")).toBe(true);
    expect(s.get("a")).toBeNull();
    expect(s.remove("a")).toBe(false);
  });
});

describe("SqliteSecretStore", () => {
  test("set/get/remove against the secrets table", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE secrets (ref TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const s = new SqliteSecretStore(db);
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
    expect(s.get("missing")).toBeNull();
    expect(s.remove("a")).toBe(true);
    expect(s.get("a")).toBeNull();
    db.close();
  });
});

describe("Registry with an injected secret store (Codex C1)", () => {
  test("a secret resolved via the store does NOT land in the on-disk db", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-c1-"));
    const path = join(dir, "registry.db");
    try {
      const r = new Registry(path, new MemorySecretStore());
      const env: EnvDescriptor = {
        id: "e",
        bastion: { host: "h", loginUser: "u", auth: { type: "password", secretRef: "e/low" } },
        roles: { default: {} },
      };
      r.upsertEnv(env);
      r.setSecret("e/low", "TOPSECRET-VALUE-123");
      expect(r.getSecret("e/low")).toBe("TOPSECRET-VALUE-123");
      expect(r.resolveSecret("e/low")).toBe("TOPSECRET-VALUE-123");
      r.close();
      // opencode's read tool could read this file — the plaintext secret must not be in it.
      const bytes = readFileSync(path, "latin1");
      expect(bytes).not.toContain("TOPSECRET-VALUE-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
