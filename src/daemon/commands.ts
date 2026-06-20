/**
 * Read-only-by-construction command builders (design.md §5/§8). lanternd builds
 * the remote command from the service descriptor + structured flags. Data fields
 * (namespace, selector, grep, file path) are shell-quoted; descriptor COMMAND
 * fragments (logs.k8s template, locate.pid) are classifier-validated as
 * read-only (fail-closed), so a hostile/corrupt descriptor cannot turn an
 * auto-approved read into arbitrary remote execution (Codex C3).
 */
import { classifyCommand } from "../classify";
import { shellQuote } from "../util/shell";
import type { EnvForm, ServiceDescriptor } from "../types";

export { shellQuote };

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** Throw unless a descriptor-supplied command fragment classifies as read-only. */
function assertReadOnlyFragment(fragment: string, what: string): void {
  const r = classifyCommand(fragment);
  if (r.verdict !== "read") {
    throw new CommandError(`${what} is not read-only (${r.verdict}: ${r.reason})`);
  }
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
      // operator-supplied command template — must be read-only.
      assertReadOnlyFragment(base, `service "${service.name}" logs.k8s template`);
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
    // grep pattern is DATA (shell-quoted), not a command — safe to append.
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
  if (service.locate?.pid) {
    assertReadOnlyFragment(service.locate.pid, `service "${service.name}" locate.pid`);
    return `${service.locate.pid} | head -n 50`;
  }
  return `ps -ef | grep -- ${shellQuote(service.name)} | grep -v grep`;
}

/** The (classifier-validated read-only) command that resolves a service's PID. */
export function locatePidCommand(service: ServiceDescriptor): string {
  const pidCmd = service.locate?.pid;
  if (!pidCmd) throw new CommandError(`service "${service.name}": needs locate.pid`);
  assertReadOnlyFragment(pidCmd, `service "${service.name}" locate.pid`);
  return pidCmd;
}

/**
 * Passive one-shot diagnostic snapshot (design.md §7, read-only) for an
 * ALREADY-RESOLVED numeric pid (resolved by dispatch in a separate step so no
 * `$(...)` substitution is embedded — Codex C3). pid must be numeric.
 */
export function buildSnapshot(service: ServiceDescriptor, pid: string): string {
  if (!/^\d+$/.test(pid)) throw new CommandError(`snapshot: invalid pid "${pid}"`);
  switch (service.runtime) {
    case "jvm":
      return `jstack ${pid}`;
    case "python":
      return `py-spy dump --pid ${pid}`;
    case "go":
      return `cat /proc/${pid}/status`;
  }
}
