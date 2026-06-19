/**
 * Read-only-by-construction command builders (design.md §5/§8). The auto-allowed
 * read subcommands (logs/state) never take free-form remote shell — lanternd
 * builds the remote command from the service descriptor + structured flags here.
 * Server-side filtering (grep/head/tail) runs on the REMOTE shell, so the bash
 * string opencode sees stays a clean `lantern logs …` with no shell metachars.
 */
import type { EnvForm, ServiceDescriptor } from "../types";

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** POSIX single-quote a value for safe interpolation into a remote command. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

export interface LogsFlags {
  tail?: number;
  since?: string;
  grep?: string;
  limitBytes?: number;
  container?: string;
}

export function buildLogs(service: ServiceDescriptor, form: EnvForm, f: LogsFlags = {}): string {
  const tail = clampInt(f.tail ?? 200, 1, 100_000);
  const limitBytes = clampInt(f.limitBytes ?? 200_000, 1, 5_000_000);

  let cmd: string;
  if (form === "k8s") {
    let base: string;
    if (service.logs?.k8s) {
      base = service.logs.k8s
        .replaceAll("{{tail}}", String(tail))
        .replaceAll("{{since}}", f.since ?? "1h");
    } else {
      const ns = service.locate?.k8s?.namespace;
      const sel = service.locate?.k8s?.selector;
      if (!ns || !sel) {
        throw new CommandError(
          `service "${service.name}": k8s logs need logs.k8s or locate.k8s.{namespace,selector}`,
        );
      }
      base =
        `kubectl -n ${shellQuote(ns)} logs -l ${shellQuote(sel)} --tail=${tail}` +
        (f.since ? ` --since=${shellQuote(f.since)}` : "") +
        (f.container ? ` -c ${shellQuote(f.container)}` : "");
    }
    cmd = f.grep ? `${base} | grep -- ${shellQuote(f.grep)}` : base;
  } else {
    const path = service.logs?.file;
    if (!path) throw new CommandError(`service "${service.name}": proprietary logs need logs.file`);
    cmd = f.grep
      ? `grep -n -- ${shellQuote(f.grep)} ${shellQuote(path)} | tail -n ${tail}`
      : `tail -n ${tail} ${shellQuote(path)}`;
  }
  return `${cmd} | head -c ${limitBytes}`;
}

export function buildState(service: ServiceDescriptor, form: EnvForm): string {
  if (form === "k8s") {
    const ns = service.locate?.k8s?.namespace;
    const sel = service.locate?.k8s?.selector;
    if (!ns || !sel) {
      throw new CommandError(
        `service "${service.name}": k8s state needs locate.k8s.{namespace,selector}`,
      );
    }
    return `kubectl -n ${shellQuote(ns)} get pods -l ${shellQuote(sel)} -o wide`;
  }
  if (service.locate?.pid) return `${service.locate.pid} | head -n 50`;
  return `ps -ef | grep -- ${shellQuote(service.name)} | grep -v grep`;
}

/**
 * Passive one-shot diagnostic snapshot (design.md §7 "被动快照", read-only): a
 * thread dump / py-spy dump / proc status of the live process. The pid is
 * resolved on the REMOTE via locate.pid (a `$(...)` here is fine — it runs on
 * the env shell, not in opencode's bash gate).
 */
export function buildSnapshot(service: ServiceDescriptor): string {
  const pidCmd = service.locate?.pid;
  if (!pidCmd) throw new CommandError(`service "${service.name}": snapshot needs locate.pid`);
  const pid = `$(${pidCmd} | head -n 1)`;
  switch (service.runtime) {
    case "jvm":
      return `jstack ${pid}`;
    case "python":
      return `py-spy dump --pid ${pid}`;
    case "go":
      return `cat /proc/${pid}/status`; // passive; full goroutine dump needs observe/dlv (Phase 2)
  }
}
