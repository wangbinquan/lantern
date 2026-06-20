/** Lantern on-disk locations (honor $LANTERN_HOME for tests/sandboxes). */
import { homedir } from "node:os";
import { join } from "node:path";

export function lanternHome(): string {
  return process.env.LANTERN_HOME ?? join(homedir(), ".lantern");
}

export function registryDbPath(): string {
  return join(lanternHome(), "registry.db");
}

/** Append-only log of executed commands — the spectator window tails this (RFC-0006). */
export function execLogPath(): string {
  return join(lanternHome(), "exec.jsonl");
}
