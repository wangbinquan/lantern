/**
 * Environment registry (design.md §3, decision #13): a local bun:sqlite store at
 * ~/.lantern/registry.db — OUTSIDE the opencode workspace, dir 0700 / db 0600.
 * Secrets go through an injectable SecretStore (keychain in production so they
 * never touch the db file — Codex C1); the SQLite `secrets` table is only used
 * by the fallback store.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EnvDescriptor, SecretResolver } from "../types";
import { EnvDescriptorSchema } from "./schema";
import { pickSecretStore, type SecretStore } from "./secret-store";

export function defaultRegistryPath(): string {
  return join(homedir(), ".lantern", "registry.db");
}

export interface EnvSummary {
  id: string;
  label?: string;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class Registry {
  private readonly db: Database;
  private readonly secrets: SecretStore;
  /** Human name of the chosen secret backend (for startup logging). */
  readonly secretBackend: string;

  constructor(path: string = defaultRegistryPath(), secretStore?: SecretStore) {
    const onDisk = path !== ":memory:";
    // chmod is POSIX-only — a no-op (and meaningless) on Windows, where the db is
    // protected by the user-profile ACL + DPAPI-encrypted secrets instead.
    const posix = process.platform !== "win32";
    if (onDisk) {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      if (posix) chmodSync(dir, 0o700); // secrets/registry live here — owner-only (Codex H7)
    }
    this.db = new Database(path, { create: true });
    if (onDisk && posix) chmodSync(path, 0o600);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.db.run("CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Pick an OS vault by platform; an injected store (tests) wins.
    if (secretStore) {
      this.secrets = secretStore;
      this.secretBackend = "injected";
    } else {
      const picked = pickSecretStore(this.db, path);
      this.secrets = picked.store;
      this.secretBackend = picked.name;
    }
  }

  // ---- environments ----

  upsertEnv(desc: EnvDescriptor): void {
    const parsed = EnvDescriptorSchema.parse(desc);
    this.db
      .query(
        `INSERT INTO environments (id, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(parsed.id, JSON.stringify(parsed), Date.now());
  }

  getEnv(id: string): EnvDescriptor | null {
    const row = this.db.query("SELECT json FROM environments WHERE id = ?").get(id) as {
      json: string;
    } | null;
    if (!row) return null;
    return EnvDescriptorSchema.parse(JSON.parse(row.json));
  }

  listEnvs(): EnvSummary[] {
    const rows = this.db.query("SELECT json FROM environments ORDER BY id").all() as {
      json: string;
    }[];
    return rows.map((r) => {
      const d = JSON.parse(r.json) as EnvDescriptor;
      return { id: d.id, label: d.label };
    });
  }

  removeEnv(id: string): boolean {
    return this.db.query("DELETE FROM environments WHERE id = ?").run(id).changes > 0;
  }

  // ---- secrets (delegated to the SecretStore) ----

  setSecret(ref: string, value: string): void {
    this.secrets.set(ref, value);
  }

  getSecret(ref: string): string | null {
    return this.secrets.get(ref);
  }

  removeSecret(ref: string): boolean {
    return this.secrets.remove(ref);
  }

  /** SecretResolver bound to this registry; throws if a ref is unknown. */
  readonly resolveSecret: SecretResolver = (ref: string) => {
    const value = this.secrets.get(ref);
    if (value == null) throw new RegistryError(`no secret stored for ref "${ref}"`);
    return value;
  };

  // ---- selected environment ----

  setCurrent(id: string): void {
    if (!this.getEnv(id)) throw new RegistryError(`unknown environment "${id}"`);
    this.db
      .query(
        "INSERT INTO state (key, value) VALUES ('current_env', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(id);
  }

  getCurrent(): string | null {
    const row = this.db.query("SELECT value FROM state WHERE key = 'current_env'").get() as {
      value: string;
    } | null;
    return row ? row.value : null;
  }

  close(): void {
    this.db.close();
  }
}
