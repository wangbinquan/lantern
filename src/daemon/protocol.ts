/**
 * lanternd RPC protocol — newline-delimited JSON over a local unix socket. The
 * `lantern` CLI (invoked per command by opencode's bash tool) sends one request
 * and prints the result. Request/response are intentionally simple and typed.
 */
import type { EnvSummary } from "../registry";

export type RpcMethod =
  | "ping"
  | "env.add"
  | "env.list"
  | "env.use"
  | "env.current"
  | "logs"
  | "state"
  | "snapshot"
  | "exec"
  | "watch"
  | "put"
  | "restart"
  | "swap"
  | "observe";

export interface RpcRequest {
  id: number;
  method: RpcMethod;
  params?: Record<string, unknown>;
  /** Capability token (Codex C2); required when the daemon was started with one. */
  token?: string;
}

export interface RpcOk<T = unknown> {
  id: number;
  ok: true;
  result: T;
}

export interface RpcErr {
  id: number;
  ok: false;
  error: string;
}

export type RpcResponse<T = unknown> = RpcOk<T> | RpcErr;

// ---- result payloads ----

export interface PingResult {
  pong: true;
}

export interface EnvListResult {
  environments: EnvSummary[];
}

export interface EnvCurrentResult {
  current: string | null;
}

export interface RunResultPayload {
  stdout: string;
  exitCode: number | null;
  /** The remote command that was executed (redacted). */
  command: string;
  /** Present for `exec`: the classifier verdict. */
  verdict?: "read" | "mutate" | "deny";
  reason?: string;
}
