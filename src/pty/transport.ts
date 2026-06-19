/**
 * PTY transport abstraction. SessionManager (slice 4) drives commands over a
 * `PtyTransport`; production uses the ssh2 channel adapter (slice 5), tests and
 * the local-shell path use `spawnPty` (a piped child process). The transport
 * only moves bytes; the marker/expect protocol lives above it.
 */

export interface PtyTransport {
  /** Write raw data to the PTY/stdin. */
  write(data: string): void;
  /** Register a sink for decoded stream data (stdout+stderr). */
  onData(cb: (chunk: string) => void): void;
  /** Tear down the transport. */
  close(): void;
  /** Resolves with the exit code when the underlying process/channel ends. */
  readonly exited: Promise<number>;
}

/**
 * Spawn a local process under pipes and expose it as a PtyTransport. Not a real
 * TTY (so it can't answer a real `su` prompt) — used for tests and for driving
 * a local shell / fake multi-hop-su fixtures where prompts read from stdin.
 */
export function spawnPty(
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): PtyTransport {
  const proc = Bun.spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd,
    env: opts?.env,
  });

  const sinks: ((c: string) => void)[] = [];
  let early = "";
  const decoder = new TextDecoder();

  const emit = (s: string) => {
    if (sinks.length === 0) {
      early += s;
      return;
    }
    for (const sink of sinks) sink(s);
  };

  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) emit(decoder.decode(chunk, { stream: true }));
  };
  void pump(proc.stdout);
  void pump(proc.stderr);

  return {
    write(data: string) {
      proc.stdin.write(data);
      proc.stdin.flush();
    },
    onData(cb: (chunk: string) => void) {
      const first = sinks.length === 0;
      sinks.push(cb);
      if (first && early.length > 0) {
        const pending = early;
        early = "";
        cb(pending);
      }
    },
    close() {
      try {
        proc.stdin.end();
      } catch {
        // stdin already closed
      }
      proc.kill();
    },
    exited: proc.exited,
  };
}
