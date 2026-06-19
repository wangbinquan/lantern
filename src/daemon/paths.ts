import { homedir } from "node:os";
import { join } from "node:path";

const root = () => process.env.LANTERN_HOME ?? join(homedir(), ".lantern");

export function defaultSocketPath(): string {
  return process.env.LANTERN_SOCK ?? join(root(), "lanternd.sock");
}

export function defaultAuditPath(): string {
  return join(root(), "audit.jsonl");
}

export function defaultRegistryDbPath(): string {
  return join(root(), "registry.db");
}
