import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DpapiSecretStore,
  MemorySecretStore,
  pickSecretStore,
  Registry,
  SecretToolSecretStore,
  type SpawnFn,
  SqliteSecretStore,
} from "../src/registry";
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

describe("SecretToolSecretStore (Linux, injected spawn)", () => {
  test("stores via stdin, looks up, clears — never puts the secret in argv", () => {
    const vault = new Map<string, string>();
    let argvLeaked = false;
    const spawn: SpawnFn = (cmd, input) => {
      const ref = cmd[cmd.indexOf("account") + 1]!;
      if (cmd.includes("hunter2")) argvLeaked = true; // the secret must never be an arg
      if (cmd[1] === "store") {
        vault.set(ref, input!);
        return { success: true, stdout: "", stderr: "" };
      }
      if (cmd[1] === "lookup") {
        const v = vault.get(ref);
        return v !== undefined
          ? { success: true, stdout: v + "\n", stderr: "" }
          : { success: false, stdout: "", stderr: "" };
      }
      return { success: vault.delete(ref), stdout: "", stderr: "" }; // clear
    };
    const s = new SecretToolSecretStore(spawn);
    s.set("e/pw", "hunter2");
    expect(argvLeaked).toBe(false);
    expect(s.get("e/pw")).toBe("hunter2");
    expect(s.get("missing")).toBeNull();
    expect(s.remove("e/pw")).toBe(true);
    expect(s.get("e/pw")).toBeNull();
  });
});

describe("DpapiSecretStore (Windows, injected crypt)", () => {
  test("encrypts at rest in the backing store; decrypts on get", () => {
    const backing = new MemorySecretStore();
    const crypt = {
      protect: (s: string) => `enc(${s})`,
      unprotect: (c: string) => c.replace(/^enc\((.*)\)$/, "$1"),
    };
    const s = new DpapiSecretStore(backing, crypt);
    s.set("e/pw", "hunter2");
    expect(backing.get("e/pw")).toBe("enc(hunter2)"); // ciphertext on disk, not plaintext
    expect(s.get("e/pw")).toBe("hunter2");
    expect(s.get("missing")).toBeNull();
    expect(s.remove("e/pw")).toBe(true);
  });
});

describe("pickSecretStore", () => {
  test(":memory: forces sqlite (tests/dev never touch the real OS vault)", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(pickSecretStore(db, ":memory:").name).toBe("sqlite");
    db.close();
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
