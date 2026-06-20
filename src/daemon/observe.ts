/**
 * Read-only intrusive diagnostics via Arthas batch mode (RFC-0004). `buildObserve`
 * is PURE and read-only-by-construction: only read-only Arthas verbs, a FIXED
 * watch expression (no arbitrary OGNL → no `{@System@exit(0)}` side effects),
 * regex-validated class/method, bounded `-n`. Runs portless (`--batch-mode`) and
 * detaches the agent (`; stop`) after the bounded observation.
 */
import type { ServiceDescriptor } from "../types";
import { shellQuote } from "../util/shell";

export type ObserveOp = "watch" | "trace" | "stack" | "tt";
export const OBSERVE_OPS: ObserveOp[] = ["watch", "trace", "stack", "tt"];

export interface ObserveOpts {
  op: ObserveOp;
  className: string;
  method: string;
  count?: number;
  /** Optional remote wall-clock bound: wrap with `timeout <N>` so a watch on an
   *  uncalled method self-terminates instead of hanging (RFC-0004 §6). */
  maxSeconds?: number;
}

export class ObserveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObserveError";
  }
}

// class/method carry no shell metacharacters (shellQuote of the whole arthasCmd
// is the real defense; these regexes are the sanity gate). Arthas accepts `.`,
// `$` (inner classes), `*` (wildcards), `<init>`/`<clinit>`.
const CLASS_RE = /^[A-Za-z0-9_$.*]+$/;
const METHOD_RE = /^[A-Za-z0-9_$<>*]+$/;
const WATCH_EXPR = "{params,returnObj,throwExp}";

function clampCount(n: number | undefined): number {
  const t = Math.trunc(n ?? 10);
  return Number.isFinite(t) ? Math.max(1, Math.min(1000, t)) : 10;
}

/** Build a read-only Arthas batch command observing a method. pid must be numeric. */
export function buildObserve(service: ServiceDescriptor, opts: ObserveOpts, pid: string): string {
  if (!/^\d+$/.test(pid)) throw new ObserveError(`observe: invalid pid "${pid}"`);
  if (!OBSERVE_OPS.includes(opts.op)) throw new ObserveError(`observe: unknown op "${opts.op}"`);
  if (!CLASS_RE.test(opts.className)) {
    throw new ObserveError(`observe: invalid class "${opts.className}"`);
  }
  if (!METHOD_RE.test(opts.method)) {
    throw new ObserveError(`observe: invalid method "${opts.method}"`);
  }
  const jar = service.diag?.arthasJar;
  if (!jar) {
    throw new ObserveError(
      `service "${service.name}" has no diag.arthasJar (JVM observe needs Arthas)`,
    );
  }
  const n = clampCount(opts.count);
  const cls = opts.className; // regex-validated, metachar-free
  const m = opts.method;

  let arthasCmd: string;
  switch (opts.op) {
    case "watch":
      arthasCmd = `watch ${cls} ${m} '${WATCH_EXPR}' -n ${n}`;
      break;
    case "trace":
      arthasCmd = `trace ${cls} ${m} -n ${n}`;
      break;
    case "stack":
      arthasCmd = `stack ${cls} ${m} -n ${n}`;
      break;
    case "tt":
      arthasCmd = `tt -t ${cls} ${m} -n ${n}`;
      break;
  }
  arthasCmd += " ; stop"; // detach the agent after the bounded observation

  const cmd = `java -jar ${shellQuote(jar)} ${pid} --batch-mode -c ${shellQuote(arthasCmd)}`;
  const max = opts.maxSeconds;
  // opt-in remote wall-clock bound; `timeout` is on the Linux env (not assumed on macOS tests)
  return max !== undefined && Number.isFinite(max) && max > 0
    ? `timeout ${Math.trunc(max)} ${cmd}`
    : cmd;
}

/** Detach the Arthas agent from a JVM (cleanup for a stuck/abandoned observe). */
export function buildObserveStop(service: ServiceDescriptor, pid: string): string {
  if (!/^\d+$/.test(pid)) throw new ObserveError(`observe: invalid pid "${pid}"`);
  const jar = service.diag?.arthasJar;
  if (!jar) {
    throw new ObserveError(
      `service "${service.name}" has no diag.arthasJar (JVM observe needs Arthas)`,
    );
  }
  return `java -jar ${shellQuote(jar)} ${pid} --batch-mode -c stop`;
}
