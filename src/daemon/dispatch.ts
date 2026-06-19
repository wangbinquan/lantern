/**
 * RPC dispatch — the pure request handler (no sockets). Tested directly with an
 * in-memory registry + spawnPty session factory; the unix-socket server (slice
 * 7b) just frames NDJSON around this.
 */
import { classifyCommand, type ClassifyOptions } from "../classify";
import type { Registry } from "../registry";
import type { RunResult } from "../ssh";
import type { EnvDescriptor, ServiceDescriptor } from "../types";
import type { AuditSink } from "./audit";
import { buildLogs, buildState, type LogsFlags } from "./commands";
import type { SessionPool } from "./pool";
import type { RpcRequest, RpcResponse } from "./protocol";

export interface DispatchDeps {
  registry: Registry;
  pool: SessionPool;
  audit?: AuditSink;
  classifyOpts?: ClassifyOptions;
  now?: () => number;
}

export async function dispatch(deps: DispatchDeps, req: RpcRequest): Promise<RpcResponse> {
  try {
    return { id: req.id, ok: true, result: await handle(deps, req) };
  } catch (e) {
    return { id: req.id, ok: false, error: (e as Error).message };
  }
}

function strOpt(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numOpt(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function resolveEnv(deps: DispatchDeps, params: Record<string, unknown>): EnvDescriptor {
  const envId = strOpt(params.envId) ?? deps.registry.getCurrent();
  if (!envId) {
    throw new Error("no environment selected (use `lantern env use <id>` or pass --env)");
  }
  const env = deps.registry.getEnv(envId);
  if (!env) throw new Error(`unknown environment "${envId}"`);
  return env;
}

function resolveService(env: EnvDescriptor, params: Record<string, unknown>): ServiceDescriptor {
  const name = strOpt(params.service);
  if (!name) throw new Error("missing --service");
  const svc = env.services?.find((s) => s.name === name);
  if (!svc) throw new Error(`env "${env.id}" has no service "${name}"`);
  return svc;
}

function record(
  deps: DispatchDeps,
  envId: string,
  method: string,
  command: string,
  r: RunResult,
  verdict?: string,
  reason?: string,
): void {
  deps.audit?.({
    ts: (deps.now ?? Date.now)(),
    envId,
    method,
    command,
    verdict,
    reason,
    exitCode: r.exitCode,
    stdoutBytes: Buffer.byteLength(r.stdout),
  });
}

async function handle(deps: DispatchDeps, req: RpcRequest): Promise<unknown> {
  const p = req.params ?? {};
  switch (req.method) {
    case "ping":
      return { pong: true };

    case "env.add": {
      if (!p.env || typeof p.env !== "object") throw new Error("env.add needs an `env` descriptor");
      deps.registry.upsertEnv(p.env as EnvDescriptor); // upsertEnv validates via zod
      if (p.secrets && typeof p.secrets === "object") {
        for (const [ref, value] of Object.entries(p.secrets as Record<string, unknown>)) {
          deps.registry.setSecret(ref, String(value));
        }
      }
      return { id: (p.env as EnvDescriptor).id };
    }

    case "env.list":
      return { environments: deps.registry.listEnvs() };

    case "env.use": {
      const id = strOpt(p.id);
      if (!id) throw new Error("missing env id");
      deps.registry.setCurrent(id);
      return { current: id };
    }

    case "env.current":
      return { current: deps.registry.getCurrent() };

    case "logs": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const flags: LogsFlags = {
        tail: numOpt(p.tail),
        since: strOpt(p.since),
        grep: strOpt(p.grep),
        limitBytes: numOpt(p.limitBytes),
        container: strOpt(p.container),
      };
      const command = buildLogs(svc, env.form, flags);
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "logs", command, r);
      return { stdout: r.stdout, exitCode: r.exitCode, command };
    }

    case "state": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const command = buildState(svc, env.form);
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "state", command, r);
      return { stdout: r.stdout, exitCode: r.exitCode, command };
    }

    case "exec": {
      const env = resolveEnv(deps, p);
      const command = strOpt(p.command);
      if (!command) throw new Error("missing --command");
      const verdict = classifyCommand(command, deps.classifyOpts);
      if (verdict.verdict === "deny") {
        // Backstop: refuse catastrophic commands even though opencode's
        // permission gate already approved this lantern invocation.
        record(
          deps,
          env.id,
          "exec",
          command,
          { stdout: "", exitCode: null },
          verdict.verdict,
          verdict.reason,
        );
        throw new Error(`refused (catastrophic): ${verdict.reason}`);
      }
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "exec", command, r, verdict.verdict, verdict.reason);
      return {
        stdout: r.stdout,
        exitCode: r.exitCode,
        command,
        verdict: verdict.verdict,
        reason: verdict.reason,
      };
    }

    default:
      throw new Error(`unknown method "${req.method}"`);
  }
}
