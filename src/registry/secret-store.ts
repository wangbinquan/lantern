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

// ---- Linux: Secret Service via `secret-tool` (libsecret / GNOME Keyring / KWallet) ----

export interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}
/** Injectable spawn so the store logic is unit-tested without the real tool. */
export type SpawnFn = (cmd: string[], input?: string) => SpawnResult;

const realSpawn: SpawnFn = (cmd, input) => {
  const r = Bun.spawnSync(cmd, input !== undefined ? { stdin: Buffer.from(input) } : {});
  return { success: r.success, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

export function secretToolAvailable(): boolean {
  return process.platform === "linux" && Bun.which("secret-tool") !== null;
}

/** `secret-tool` store: the secret goes in on STDIN (never argv), out via lookup. */
export class SecretToolSecretStore implements SecretStore {
  constructor(private readonly spawn: SpawnFn = realSpawn) {}
  private attrs(ref: string): string[] {
    return ["service", KEYCHAIN_SERVICE, "account", ref];
  }
  set(ref: string, value: string): void {
    const r = this.spawn(
      ["secret-tool", "store", "--label", KEYCHAIN_SERVICE, ...this.attrs(ref)],
      value,
    );
    if (!r.success) throw new Error(`secret-tool set failed for "${ref}": ${r.stderr.trim()}`);
  }
  get(ref: string): string | null {
    const r = this.spawn(["secret-tool", "lookup", ...this.attrs(ref)]);
    return r.success ? r.stdout.replace(/\r?\n$/, "") : null;
  }
  remove(ref: string): boolean {
    return this.spawn(["secret-tool", "clear", ...this.attrs(ref)]).success;
  }
}

// ---- Windows: DPAPI (per-user encryption) — ciphertext stored in the SQLite table ----

export interface DpapiCrypt {
  protect(plaintext: string): string; // → base64 ciphertext
  unprotect(ciphertext: string): string; // base64 → plaintext
}

/** Real DPAPI via PowerShell; the value crosses on STDIN, not argv. */
export const realDpapiCrypt: DpapiCrypt = {
  protect(plaintext) {
    const r = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,'CurrentUser'))",
      ],
      { stdin: Buffer.from(plaintext) },
    );
    if (!r.success) throw new Error(`DPAPI protect failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().trim();
  },
  unprotect(ciphertext) {
    const r = Bun.spawnSync(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,'CurrentUser'))",
      ],
      { stdin: Buffer.from(ciphertext) },
    );
    if (!r.success) throw new Error(`DPAPI unprotect failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString().replace(/\r?\n$/, "");
  },
};

export function dpapiAvailable(): boolean {
  return process.platform === "win32" && Bun.which("powershell") !== null;
}

/** Encrypts each secret with DPAPI and keeps the ciphertext in a backing store (sqlite). */
export class DpapiSecretStore implements SecretStore {
  constructor(
    private readonly backing: SecretStore,
    private readonly crypt: DpapiCrypt = realDpapiCrypt,
  ) {}
  set(ref: string, value: string): void {
    this.backing.set(ref, this.crypt.protect(value));
  }
  get(ref: string): string | null {
    const c = this.backing.get(ref);
    return c === null ? null : this.crypt.unprotect(c);
  }
  remove(ref: string): boolean {
    return this.backing.remove(ref);
  }
}

/**
 * Choose a secret backend by platform — an OS vault where one exists, else SQLite.
 * `:memory:` and LOCAL_SHELL force SQLite (tests / dev never touch the real vault).
 */
export function pickSecretStore(db: Database, path: string): { store: SecretStore; name: string } {
  if (path === ":memory:" || process.env.LANTERN_LOCAL_SHELL === "1") {
    return { store: new SqliteSecretStore(db), name: "sqlite" };
  }
  if (process.platform === "darwin" && keychainAvailable()) {
    return { store: new KeychainSecretStore(), name: "macOS keychain" };
  }
  if (secretToolAvailable()) {
    return { store: new SecretToolSecretStore(), name: "secret-service" };
  }
  if (dpapiAvailable()) {
    return { store: new DpapiSecretStore(new SqliteSecretStore(db)), name: "windows DPAPI" };
  }
  return { store: new SqliteSecretStore(db), name: "sqlite (PLAINTEXT — no OS vault)" };
}
