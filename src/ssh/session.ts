/**
 * SessionManager (design.md §4). Owns ONE long-lived PTY for an environment and
 * drives, data-driven from the descriptor, the human sequence
 *   login → su → (su jump → ssh internal → su) → …
 * then serializes marker-wrapped commands over it. Passwords are written
 * straight to the PTY and redacted in every emitted/returned text.
 *
 * Transport-agnostic: it (re)connects through a `transportFactory` — production
 * supplies an ssh2 channel adapter (slice 5); tests supply `spawnPty` over a
 * local bash + fake su/ssh fixtures, which exercises the exact same orchestration.
 */
import { Expecter } from "../pty/expect";
import {
  markerRegex,
  newMarkerId,
  parseCompletion,
  stripAnsi,
  stripMarkers,
  wrapCommand,
} from "../pty/marker";
import type { PtyTransport } from "../pty/transport";
import type { ChainStep, EnvDescriptor, SecretResolver } from "../types";
import { shellQuote } from "../util/shell";

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionEvent {
  kind: "step" | "write" | "stdout" | "error" | "ready";
  /** Already redacted — safe to display/log. */
  text: string;
}

export interface RunResult {
  stdout: string;
  exitCode: number | null;
  /** True if stdout was capped at maxStdoutBytes (Codex M5). */
  truncated?: boolean;
}

export interface SessionOptions {
  resolveSecret: SecretResolver;
  /** Command to confirm the active user after an su (default `id -un`). */
  whoamiCmd?: string;
  /** Password-prompt matcher (default `/[Pp]assword:/`). */
  passwordPrompt?: RegExp;
  syncTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Hard cap on captured stdout per command (default 1 MB; Codex M5). */
  maxStdoutBytes?: number;
  onEvent?: (e: SessionEvent) => void;
}

export type TransportFactory = () => Promise<PtyTransport> | PtyTransport;

export class SessionManager {
  private transport?: PtyTransport;
  private readonly exp = new Expecter();
  private readonly secrets = new Set<string>();
  private connected = false;
  private connecting?: Promise<void>;
  private connectedAt = 0;
  private lastActivity = 0;
  /** Serializes public run() calls (one command on the PTY at a time). */
  private tail: Promise<unknown> = Promise.resolve();
  /** Number of times the transport was (re)created — for tests/diagnostics. */
  factoryCalls = 0;

  constructor(
    private readonly factory: TransportFactory,
    private readonly descriptor: EnvDescriptor,
    private readonly opts: SessionOptions,
    /** Resolved su/ssh steps to run after the bastion login (RFC-0007 resolveChain). */
    private readonly chain: ChainStep[] = [],
  ) {}

  private get whoamiCmd(): string {
    return this.opts.whoamiCmd ?? "id -un";
  }
  private get passwordPrompt(): RegExp {
    return this.opts.passwordPrompt ?? /[Pp]assword:/;
  }
  private get syncTimeoutMs(): number {
    return this.opts.syncTimeoutMs ?? this.descriptor.promptSyncTimeoutMs ?? 15_000;
  }
  private get commandTimeoutMs(): number {
    return this.opts.commandTimeoutMs ?? 30_000;
  }
  private get maxStdoutBytes(): number {
    return this.opts.maxStdoutBytes ?? 1_000_000;
  }

  /** Establish the session (idempotent; concurrent calls share one attempt). */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.establish().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  /**
   * Run a command, (re)connecting first if needed. The freshness check runs
   * INSIDE the queue so it can't race a concurrent run (Codex H6); on a
   * timeout/marker-loss the dirty PTY is dropped so the next run reconnects.
   */
  async run(cmd: string, runOpts: { timeoutMs?: number } = {}): Promise<RunResult> {
    return this.enqueue(async () => {
      await this.ensureFresh();
      try {
        return await this.rawRun(cmd, runOpts.timeoutMs ?? this.commandTimeoutMs);
      } catch (e) {
        await this.release(); // timeout/marker-loss left the PTY dirty — drop it
        throw e;
      }
    });
  }

  /** Whoami on the current (deepest) shell — handy for diagnostics. */
  async whoami(): Promise<string> {
    return (await this.run(this.whoamiCmd)).stdout.trim();
  }

  /** Tear down the PTY. */
  async release(): Promise<void> {
    this.connected = false;
    try {
      this.transport?.close();
    } catch {
      // already closed
    }
    this.transport = undefined;
    this.exp.reset();
  }

  // ---- internals ----

  private async ensureFresh(): Promise<void> {
    if (!this.connected) {
      await this.connect();
      return;
    }
    const now = Date.now();
    const ttlMs = (this.descriptor.session?.ttlSec ?? 0) * 1000;
    const idleMs = (this.descriptor.session?.idleSec ?? 0) * 1000;
    const stale =
      (ttlMs > 0 && now - this.connectedAt > ttlMs) ||
      (idleMs > 0 && now - this.lastActivity > idleMs);
    if (stale) {
      await this.release();
      await this.connect();
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async establish(): Promise<void> {
    const t = await this.factory();
    this.transport = t;
    this.factoryCalls += 1;
    try {
      this.exp.reset();
      t.onData((chunk) => {
        this.exp.feed(chunk); // the expecter still gets the RAW chunk (markers intact)
        this.lastActivity = Date.now();
        // observers/watch see clean output — strip the internal completion markers
        const visible = stripMarkers(this.redact(stripAnsi(chunk)));
        if (visible.length > 0) this.emit("stdout", visible);
      });

      if (this.descriptor.shellInit) this.writeRaw(this.descriptor.shellInit + "\n");
      // initial responsiveness sync (marker round-trip past any banner/MOTD)
      await this.rawRun("true", this.syncTimeoutMs);

      for (const step of this.chain) {
        if (step.kind === "su") await this.suStep(step);
        else await this.sshStep(step);
      }

      this.connected = true;
      this.connectedAt = Date.now();
      this.lastActivity = Date.now();
      this.emit("ready", ""); // signals the chain is fully established (RFC-0001)
    } catch (e) {
      // a failure mid-setup (sync timeout, su/hop prompt mismatch) leaves a
      // half-open transport — close it so the next connect() can't leak it (Codex H2).
      await this.release();
      throw e;
    }
  }

  private async suStep(step: {
    user: string;
    secretRef: string;
    promptRe?: string;
  }): Promise<void> {
    this.emit("step", `su - ${step.user}`);
    this.writeRaw(`su - ${shellQuote(step.user)}\n`);
    const re = step.promptRe ? new RegExp(step.promptRe) : this.passwordPrompt;
    await this.exp.expect(re, this.syncTimeoutMs);
    await this.sendSecret(step.secretRef);
    const who = (await this.rawRun(this.whoamiCmd, this.syncTimeoutMs)).stdout.trim();
    if (who !== step.user) {
      throw new SessionError(`su to "${step.user}" failed (whoami="${who}")`);
    }
  }

  private async sshStep(step: { to: string; secretRef: string; promptRe?: string }): Promise<void> {
    this.emit("step", `ssh ${step.to}`);
    this.writeRaw(`ssh ${shellQuote(step.to)}\n`);
    const re = step.promptRe ? new RegExp(step.promptRe) : this.passwordPrompt;
    await this.exp.expect(re, this.syncTimeoutMs);
    await this.sendSecret(step.secretRef);
    await this.rawRun("true", this.syncTimeoutMs); // confirm responsive on the node
  }

  private async sendSecret(ref: string): Promise<void> {
    const pw = await Promise.resolve(this.opts.resolveSecret(ref));
    if (pw) this.secrets.add(pw);
    this.writeRaw(pw + "\n");
    this.emit("write", "***");
  }

  private async rawRun(cmd: string, timeoutMs: number): Promise<RunResult> {
    if (!this.transport) throw new SessionError("not connected");
    const id = newMarkerId();
    this.emit("write", this.redact(cmd));
    this.writeRaw(wrapCommand(cmd, id));
    let captured: { before: string; match: string };
    try {
      captured = await this.exp.expect(markerRegex(id), timeoutMs);
    } catch (e) {
      this.emit("error", (e as Error).message);
      throw e;
    }
    // before = command output, match = the marker line; recombine for parsing.
    const completion = parseCompletion(captured.before + captured.match, id);
    this.lastActivity = Date.now();
    let stdout = this.redact(stripAnsi(completion.stdout));
    let truncated = false;
    if (stdout.length > this.maxStdoutBytes) {
      const dropped = stdout.length - this.maxStdoutBytes;
      stdout = stdout.slice(0, this.maxStdoutBytes) + `\n[... truncated ${dropped} bytes]`;
      truncated = true;
    }
    return { stdout, exitCode: completion.exitCode, truncated };
  }

  private writeRaw(data: string): void {
    this.transport?.write(data);
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.secrets) if (s) out = out.split(s).join("***");
    return out;
  }

  private emit(kind: SessionEvent["kind"], text: string): void {
    this.opts.onEvent?.({ kind, text });
  }
}
