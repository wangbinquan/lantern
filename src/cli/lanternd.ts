#!/usr/bin/env bun
/**
 * lanternd entrypoint — start the daemon on the local unix socket. Holds the env
 * sessions; the `lantern` CLI talks to it per command. Mints a per-start
 * capability token (Codex C2) and uses the OS keychain for secrets on macOS
 * (Codex C1).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import {
  Daemon,
  defaultAuditPath,
  defaultRegistryDbPath,
  defaultSocketPath,
  defaultTokenPath,
  EventBus,
  fileAuditSink,
  SessionPool,
} from "../daemon";
import { spawnPty } from "../pty";
import { KeychainSecretStore, keychainAvailable, Registry } from "../registry";

const localShell = process.env.LANTERN_LOCAL_SHELL === "1";

// Secrets in the OS keychain on macOS so they never touch a file opencode can
// read (Codex C1); fall back to the registry sqlite (0700/0600) elsewhere.
const useKeychain = !localShell && keychainAvailable();
const registry = new Registry(
  defaultRegistryDbPath(),
  useKeychain ? new KeychainSecretStore() : undefined,
);

// Watch bus: lanternd publishes everything it does on an env here; `lantern
// watch` clients subscribe over the socket for a read-only live mirror (RFC-0001).
const bus = new EventBus();
const pool = localShell
  ? new SessionPool(registry, () => () => spawnPty(["bash", "--norc", "--noprofile"]), {}, bus)
  : new SessionPool(registry, undefined, {}, bus);

// Per-start capability token, required on every RPC (Codex C2).
const token = randomBytes(32).toString("hex");
const tokenPath = defaultTokenPath();
writeFileSync(tokenPath, token, { mode: 0o600 });
chmodSync(tokenPath, 0o600);

const daemon = new Daemon(
  { registry, pool, audit: fileAuditSink(defaultAuditPath()), bus, locks: new Set() },
  { token },
);
const socketPath = defaultSocketPath();

if (localShell) {
  process.stderr.write(
    "\n⚠️  LANTERN_LOCAL_SHELL=1 — DEV/DEMO MODE: sessions run on THIS machine (no ssh).\n" +
      "    Auto-approved read commands execute locally. Do NOT use against a real environment.\n\n",
  );
}
process.stderr.write(
  `lanternd: secrets in ${useKeychain ? "OS keychain (service 'lantern')" : "local sqlite (no keychain)"}\n`,
);
daemon.listen(socketPath);
process.stderr.write(`lanternd listening on ${socketPath}\n`);

const shutdown = (): void => {
  daemon.stop();
  void pool.releaseAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
