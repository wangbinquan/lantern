/**
 * MCP tool handlers (RFC-0005) — the pure logic behind the `env_list` and `exec`
 * tools, decoupled from the stdio server wiring so they are unit-tested directly.
 * Lantern's whole surface: list environments, and run a command on one over its
 * multi-hop/su SSH session.
 */
import type { SessionPool } from "../session";
import type { Registry } from "../registry";
import { catastrophicReason } from "../safety/catastrophic";

export interface McpDeps {
  registry: Registry;
  pool: SessionPool;
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

/** Run a command on the named environment's SSH session (catastrophic backstop applies). */
export async function execTool(deps: McpDeps, args: ExecArgs): Promise<ExecResult> {
  const reason = catastrophicReason(args.command);
  if (reason) throw new Error(`refused (catastrophic): ${reason}`);
  if (!deps.registry.getEnv(args.env)) throw new Error(`unknown environment "${args.env}"`);
  const r = await deps.pool.run(args.env, args.command, args.timeoutMs);
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
