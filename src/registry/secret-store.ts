/**
 * Secret storage backends (Codex C1). Secrets must NOT live in any file that
 * opencode's auto-allowed `read` tool can reach, so production (macOS) keeps
 * them in the OS keychain; the SQLite store is a fallback for platforms without
 * a keychain (relies on the ~/.lantern 0700/0600 perms). The resolver stays
 * synchronous (Bun.spawnSync) so nothing downstream needs to change.
 */
import type { Database } from "bun:sqlite";

export interface SecretStore {
  set(ref: string, value: string): void;
  get(ref: string): string | null;
  remove(ref: string): boolean;
}

/** In-memory store — tests and ephemeral use. */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  set(ref: string, value: string): void {
    this.map.set(ref, value);
  }
  get(ref: string): string | null {
    return this.map.get(ref) ?? null;
  }
  remove(ref: string): boolean {
    return this.map.delete(ref);
  }
}

/** SQLite-backed store (uses the registry db's `secrets` table). Fallback only. */
export class SqliteSecretStore implements SecretStore {
  constructor(private readonly db: Database) {}
  set(ref: string, value: string): void {
    this.db
      .query(
        "INSERT INTO secrets (ref, value) VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET value = excluded.value",
      )
      .run(ref, value);
  }
  get(ref: string): string | null {
    const row = this.db.query("SELECT value FROM secrets WHERE ref = ?").get(ref) as {
      value: string;
    } | null;
    return row ? row.value : null;
  }
  remove(ref: string): boolean {
    return this.db.query("DELETE FROM secrets WHERE ref = ?").run(ref).changes > 0;
  }
}

const KEYCHAIN_SERVICE = "lantern";

export function keychainAvailable(): boolean {
  return process.platform === "darwin" && Bun.which("security") !== null;
}

/**
 * macOS Keychain store via the `security` CLI — secrets stay out of every file
 * opencode can read (Codex C1). NOTE: add-generic-password takes the password as
 * a `-w <value>` argv, briefly visible to the same user via `ps`; acceptable vs.
 * a plaintext file. A native keychain binding would remove even that.
 */
export class KeychainSecretStore implements SecretStore {
  set(ref: string, value: string): void {
    const r = Bun.spawnSync([
      "security",
      "add-generic-password",
      "-a",
      ref,
      "-s",
      KEYCHAIN_SERVICE,
      "-U", // update if it already exists
      "-w",
      value,
    ]);
    if (!r.success) {
      throw new Error(`keychain set failed for "${ref}": ${r.stderr.toString().trim()}`);
    }
  }
  get(ref: string): string | null {
    const r = Bun.spawnSync([
      "security",
      "find-generic-password",
      "-a",
      ref,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ]);
    if (!r.success) return null;
    return r.stdout.toString().replace(/\r?\n$/, "");
  }
  remove(ref: string): boolean {
    return Bun.spawnSync(["security", "delete-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE])
      .success;
  }
}
