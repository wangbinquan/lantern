/**
 * Lightweight append-only audit (design.md §11). One JSONL line per command:
 * what ran, where, the classifier verdict, and the result. Off the env (local
 * file under ~/.lantern). Not tamper-evident — that's a Phase-2 hardening.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: number;
  envId: string;
  method: string;
  /** The remote command (already password-redacted by SessionManager). */
  command: string;
  verdict?: string;
  reason?: string;
  exitCode: number | null;
  stdoutBytes: number;
}

export type AuditSink = (entry: AuditEntry) => void;

export function fileAuditSink(path: string): AuditSink {
  mkdirSync(dirname(path), { recursive: true });
  return (entry) => {
    appendFileSync(path, JSON.stringify(entry) + "\n");
  };
}
