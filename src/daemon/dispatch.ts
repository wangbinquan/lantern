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
import { buildLogs, buildSnapshot, buildState, locatePidCommand, type LogsFlags } from "./commands";
import type { SessionPool } from "./pool";
import { buildObserve, buildObserveStop, type ObserveOp } from "./observe";
import { doPut, doRestart, doSwap, previewSwap, type SwapRun } from "./swap";
import { readArtifact } from "./upload";
import type { RpcRequest, RpcResponse } from "./protocol";
import type { EventBus } from "./watch";

export interface DispatchDeps {
  registry: Registry;
  pool: SessionPool;
  audit?: AuditSink;
  classifyOpts?: ClassifyOptions;
  now?: () => number;
  bus?: EventBus;
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
  // reject NaN so a bad --timeout/--count/--chunk-size falls back to the default
  // rather than disabling a timeout or emitting a broken command (Codex L-1 follow-up).
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Extract a numeric PID from a locate command's output: a line that is ONLY
 * digits, and only when the command succeeded — so noisy warnings or progress
 * lines can't yield the wrong PID (Codex M-3).
 */
function resolvePid(out: RunResult): string | null {
  if (out.exitCode !== 0) return null;
  const m = /(?:^|\n)[ \t]*(\d+)[ \t]*(?:\r?\n|$)/.exec(out.stdout);
  return m ? m[1]! : null;
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

/** Audit a non-command RPC (env.add/env.use) — Codex M4. */
function auditMeta(deps: DispatchDeps, envId: string, method: string, command: string): void {
  deps.audit?.({
    ts: (deps.now ?? Date.now)(),
    envId,
    method,
    command,
    exitCode: null,
    stdoutBytes: 0,
  });
  deps.bus?.publish({
    ts: (deps.now ?? Date.now)(),
    env: envId,
    kind: "meta",
    text: `${method} ${command}`,
  });
}

// --- watch bus publishers (RFC-0001 §4.4) ---
function pubCommand(deps: DispatchDeps, env: string, method: string, command: string): void {
  deps.bus?.publish({ ts: (deps.now ?? Date.now)(), env, kind: "command", method, command });
}
function pubExit(deps: DispatchDeps, env: string, method: string, r: RunResult): void {
  deps.bus?.publish({
    ts: (deps.now ?? Date.now)(),
    env,
    kind: "exit",
    method,
    exitCode: r.exitCode,
    bytes: Buffer.byteLength(r.stdout),
    truncated: r.truncated,
  });
}
function pubDenied(
  deps: DispatchDeps,
  env: string,
  method: string,
  command: string,
  reason: string,
): void {
  deps.bus?.publish({ ts: (deps.now ?? Date.now)(), env, kind: "denied", method, command, reason });
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
      const id = (p.env as EnvDescriptor).id;
      auditMeta(deps, id, "env.add", "(register env + secrets)");
      return { id };
    }

    case "env.list":
      return { environments: deps.registry.listEnvs() };

    case "env.use": {
      const id = strOpt(p.id);
      if (!id) throw new Error("missing env id");
      deps.registry.setCurrent(id);
      auditMeta(deps, id, "env.use", "(select environment)");
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
      pubCommand(deps, env.id, "logs", command);
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "logs", command, r);
      pubExit(deps, env.id, "logs", r);
      return { stdout: r.stdout, exitCode: r.exitCode, command };
    }

    case "state": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const command = buildState(svc, env.form);
      pubCommand(deps, env.id, "state", command);
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "state", command, r);
      pubExit(deps, env.id, "state", r);
      return { stdout: r.stdout, exitCode: r.exitCode, command };
    }

    case "snapshot": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const timeoutMs = numOpt(p.timeoutMs);
      // Step 1: resolve the PID via a classifier-validated read command.
      const pidOut = await deps.pool.run(env.id, locatePidCommand(svc), timeoutMs);
      const pid = resolvePid(pidOut);
      if (!pid) throw new Error(`snapshot: could not resolve a PID for service "${svc.name}"`);
      // Step 2: passive diagnostic against the validated numeric PID (no $()).
      const command = buildSnapshot(svc, pid);
      pubCommand(deps, env.id, "snapshot", command);
      const r = await deps.pool.run(env.id, command, timeoutMs);
      record(deps, env.id, "snapshot", command, r);
      pubExit(deps, env.id, "snapshot", r);
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
        pubDenied(deps, env.id, "exec", command, verdict.reason);
        throw new Error(`refused (catastrophic): ${verdict.reason}`);
      }
      pubCommand(deps, env.id, "exec", command);
      const r = await deps.pool.run(env.id, command, numOpt(p.timeoutMs));
      record(deps, env.id, "exec", command, r, verdict.verdict, verdict.reason);
      pubExit(deps, env.id, "exec", r);
      return {
        stdout: r.stdout,
        exitCode: r.exitCode,
        command,
        verdict: verdict.verdict,
        reason: verdict.reason,
      };
    }

    case "put": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const file = strOpt(p.file);
      if (!file) throw new Error("missing --file");
      const artifact = await readArtifact(file);
      const run: SwapRun = (cmd) => deps.pool.run(env.id, cmd, numOpt(p.timeoutMs));
      pubCommand(deps, env.id, "put", `put ${file} → ${svc.swap?.remotePath ?? "(no remotePath)"}`);
      const result = await doPut(run, svc, artifact, numOpt(p.chunkSize));
      record(deps, env.id, "put", `put ${file} → ${result.remotePath}`, {
        stdout: "",
        exitCode: 0,
      });
      return { service: svc.name, ...result, bytes: artifact.bytes };
    }

    case "restart": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const cmd = svc.swap?.restartCmd;
      if (!cmd) throw new Error(`service "${svc.name}" has no swap.restartCmd`);
      pubCommand(deps, env.id, "restart", cmd);
      const run: SwapRun = (c) => deps.pool.run(env.id, c, numOpt(p.timeoutMs));
      const r = await doRestart(run, svc);
      record(deps, env.id, "restart", cmd, r);
      pubExit(deps, env.id, "restart", r);
      return { service: svc.name, command: cmd, exitCode: r.exitCode, stdout: r.stdout };
    }

    case "swap": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const file = strOpt(p.file);
      if (!file) throw new Error("missing --file");
      const artifact = await readArtifact(file);
      const rollback = p.rollback === false ? false : undefined; // --no-rollback
      const chunkSize = numOpt(p.chunkSize);
      if (p.dryRun === true) {
        return { dryRun: true, ...previewSwap(svc, artifact, { rollback, chunkSize }) };
      }
      const run: SwapRun = (c) => deps.pool.run(env.id, c, numOpt(p.timeoutMs));
      const result = await doSwap(run, svc, artifact, {
        rollback,
        chunkSize,
        onStep: (label, command) => pubCommand(deps, env.id, "swap", `[${label}] ${command}`),
      });
      record(
        deps,
        env.id,
        "swap",
        `swap ${file} → ${result.remotePath} (swapped=${result.swapped} rolledBack=${result.rolledBack})`,
        { stdout: "", exitCode: result.swapped ? 0 : 1 },
      );
      return { ...result };
    }

    case "observe": {
      const env = resolveEnv(deps, p);
      const svc = resolveService(env, p);
      const timeoutMs = numOpt(p.timeoutMs);
      // Step 1: resolve a numeric PID (same as snapshot, no $()).
      const pidOut = await deps.pool.run(env.id, locatePidCommand(svc), timeoutMs);
      const pid = resolvePid(pidOut);
      if (!pid) throw new Error(`observe: could not resolve a PID for service "${svc.name}"`);

      let command: string;
      if (p.stop === true) {
        command = buildObserveStop(svc, pid); // detach a stuck Arthas agent
      } else {
        const op = strOpt(p.op);
        const className = strOpt(p.class);
        const method = strOpt(p.method);
        if (!op || !className || !method) throw new Error("observe needs --op, --class, --method");
        command = buildObserve(
          svc,
          {
            op: op as ObserveOp,
            className,
            method,
            count: numOpt(p.count),
            maxSeconds: numOpt(p.maxSeconds),
          },
          pid,
        );
      }
      pubCommand(deps, env.id, "observe", command);
      const r = await deps.pool.run(env.id, command, timeoutMs);
      record(deps, env.id, "observe", command, r);
      pubExit(deps, env.id, "observe", r);
      return { stdout: r.stdout, exitCode: r.exitCode, command };
    }

    default:
      throw new Error(`unknown method "${req.method}"`);
  }
}
