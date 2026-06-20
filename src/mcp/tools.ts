/**
 * MCP tool handlers (RFC-0005) — the pure logic behind the `env_list` and `exec`
 * tools, decoupled from the stdio server wiring so they are unit-tested directly.
 * Lantern's whole surface: list environments, and run a command on one over its
 * multi-hop/su SSH session.
 */
import type { SessionPool } from "../session";
import type { Registry } from "../registry";
import { catastrophicReason } from "../safety/catastrophic";

/** One executed (or refused) command, for the read-only spectator log (RFC-0006). */
export interface ExecLogEntry {
  ts: number;
  env: string;
  command: string;
  exitCode: number | null;
  stdoutBytes: number;
  /** Capped stdout preview (passwords already redacted by the session). */
  stdout?: string;
  /** Set instead of running, when the catastrophic backstop refused the command. */
  refused?: string;
}

export interface McpDeps {
  registry: Registry;
  pool: SessionPool;
  /** Spectator sink — receives every executed/refused command (no secrets). */
  onExec?: (entry: ExecLogEntry) => void;
}

export interface ExecArgs {
  env: string;
  command: string;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  exitCode: number | null;
}

/** stdout preview kept in the spectator log — bounds the file; full output is in the MCP result. */
const MONITOR_STDOUT_CAP = 2048;

/** Run a command on the named environment's SSH session (catastrophic backstop applies). */
export async function execTool(deps: McpDeps, args: ExecArgs): Promise<ExecResult> {
  const reason = catastrophicReason(args.command);
  if (reason) {
    deps.onExec?.({
      ts: Date.now(),
      env: args.env,
      command: args.command,
      exitCode: null,
      stdoutBytes: 0,
      refused: `catastrophic: ${reason}`,
    });
    throw new Error(`refused (catastrophic): ${reason}`);
  }
  if (!deps.registry.getEnv(args.env)) throw new Error(`unknown environment "${args.env}"`);
  const r = await deps.pool.run(args.env, args.command, args.timeoutMs);
  deps.onExec?.({
    ts: Date.now(),
    env: args.env,
    command: args.command,
    exitCode: r.exitCode,
    stdoutBytes: Buffer.byteLength(r.stdout),
    stdout: r.stdout.slice(0, MONITOR_STDOUT_CAP),
  });
  return { stdout: r.stdout, exitCode: r.exitCode };
}

export interface EnvListResult {
  environments: { id: string; label?: string }[];
}

/** List configured environments (ids + labels; no secrets). */
export function envListTool(deps: McpDeps): EnvListResult {
  return {
    environments: deps.registry.listEnvs().map((e) => ({ id: e.id, label: e.label })),
  };
}
