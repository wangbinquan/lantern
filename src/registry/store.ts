/**
 * Environment registry (design.md §3, decision #13): a local bun:sqlite store at
 * ~/.lantern/registry.db — OUTSIDE the opencode workspace so the model's
 * read/grep cannot reach the plaintext credentials (research env; keychain/Vault
 * later behind the same SecretResolver interface). Holds env descriptors,
 * secrets (secretRef → plaintext), and the currently-selected env.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EnvDescriptor, SecretResolver } from "../types";
import { EnvDescriptorSchema } from "./schema";

export function defaultRegistryPath(): string {
  return join(homedir(), ".lantern", "registry.db");
}

export interface EnvSummary {
  id: string;
  label?: string;
  form: string;
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class Registry {
  private readonly db: Database;

  constructor(path: string = defaultRegistryPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS environments (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.db.run("CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  // ---- environments ----

  /** Validate and upsert a descriptor (throws ZodError on an invalid shape). */
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
      return { id: d.id, label: d.label, form: d.form };
    });
  }

  removeEnv(id: string): boolean {
    return this.db.query("DELETE FROM environments WHERE id = ?").run(id).changes > 0;
  }

  // ---- secrets ----

  setSecret(ref: string, value: string): void {
    this.db
      .query(
        "INSERT INTO secrets (ref, value) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET value = excluded.value",
      )
      .run(ref, value);
  }

  getSecret(ref: string): string | null {
    const row = this.db.query("SELECT value FROM secrets WHERE ref = ?").get(ref) as {
      value: string;
    } | null;
    return row ? row.value : null;
  }

  removeSecret(ref: string): boolean {
    return this.db.query("DELETE FROM secrets WHERE ref = ?").run(ref).changes > 0;
  }

  /** SecretResolver bound to this registry; throws if a ref is unknown. */
  readonly resolveSecret: SecretResolver = (ref: string) => {
    const value = this.getSecret(ref);
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
