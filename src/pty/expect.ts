/**
 * Expect FSM (design.md §4.2). Accumulates bytes from a PTY stream and resolves
 * when an expected pattern (a prompt, a marker) appears. Transport-agnostic:
 * the caller `feed()`s chunks as they arrive (SessionManager wires this to the
 * real ssh2 channel / spawned shell). One outstanding `expect()` at a time —
 * commands on a single PTY are serialized.
 */

export interface ExpectMatch {
  /** Stream text before the match (the command's output / banner). */
  before: string;
  /** The matched text. */
  match: string;
}

export class ExpectTimeoutError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly timeoutMs: number,
    public readonly pending: string,
  ) {
    super(`expect(${pattern}) timed out after ${timeoutMs}ms`);
    this.name = "ExpectTimeoutError";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Expecter {
  private buf = "";
  private pending?: {
    re: RegExp;
    resolve: (m: ExpectMatch) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  /** Feed a chunk of stream data; resolves a waiting expect() if it now matches. */
  feed(chunk: string): void {
    this.buf += chunk;
    this.tryResolve();
  }

  /**
   * Wait until `pattern` appears. On match, the buffer is consumed through the
   * end of the match (so the next expect() starts after it). Rejects on timeout.
   */
  expect(pattern: RegExp | string, timeoutMs = 15_000): Promise<ExpectMatch> {
    if (this.pending) {
      return Promise.reject(new Error("Expecter is busy: concurrent expect() not allowed"));
    }
    const re = typeof pattern === "string" ? new RegExp(escapeRegExp(pattern)) : pattern;
    return new Promise<ExpectMatch>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.buf;
        this.pending = undefined;
        reject(new ExpectTimeoutError(re.source, timeoutMs, pending));
      }, timeoutMs);
      this.pending = { re, resolve, reject, timer };
      this.tryResolve();
    });
  }

  private tryResolve(): void {
    if (!this.pending) return;
    const m = this.pending.re.exec(this.buf);
    if (!m) return;
    const before = this.buf.slice(0, m.index);
    const match = m[0];
    this.buf = this.buf.slice(m.index + match.length);
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = undefined;
    resolve({ before, match });
  }

  /** Unconsumed buffer (diagnostics). */
  peek(): string {
    return this.buf;
  }

  /** Drop any buffered data (e.g. after re-syncing the prompt past a su/ssh). */
  reset(): void {
    this.buf = "";
  }
}
