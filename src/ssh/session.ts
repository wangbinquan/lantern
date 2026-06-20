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
import { markerRegex, newMarkerId, parseCompletion, stripAnsi, wrapCommand } from "../pty/marker";
import type { PtyTransport } from "../pty/transport";
import type { EnvDescriptor, SecretResolver, SuStep, Hop } from "../types";
import { shellQuote } from "../util/shell";

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionEvent {
  kind: "step" | "write" | "stdout" | "error";
  /** Already redacted — safe to display/log. */
  text: string;
}

export interface RunResult {
  stdout: string;
  exitCode: number | null;
}

export interface SessionOptions {
  resolveSecret: SecretResolver;
  /** Command to confirm the active user after an su (default `id -un`). */
  whoamiCmd?: string;
  /** Password-prompt matcher (default `/[Pp]assword:/`). */
  passwordPrompt?: RegExp;
  syncTimeoutMs?: number;
  commandTimeoutMs?: number;
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

  /** Run a command, (re)connecting first if needed. Serialized per session. */
  async run(cmd: string, runOpts: { timeoutMs?: number } = {}): Promise<RunResult> {
    await this.ensureFresh();
    return this.enqueue(() => this.rawRun(cmd, runOpts.timeoutMs ?? this.commandTimeoutMs));
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
    this.exp.reset();
    t.onData((chunk) => {
      this.exp.feed(chunk);
      this.lastActivity = Date.now();
      this.emit("stdout", this.redact(stripAnsi(chunk)));
    });

    if (this.descriptor.shellInit) this.writeRaw(this.descriptor.shellInit + "\n");
    // initial responsiveness sync (marker round-trip past any banner/MOTD)
    await this.rawRun("true", this.syncTimeoutMs);

    for (const step of this.descriptor.escalate ?? []) await this.suStep(step);
    for (const hop of this.descriptor.hops ?? []) await this.doHop(hop);

    this.connected = true;
    this.connectedAt = Date.now();
    this.lastActivity = Date.now();
  }

  private async suStep(step: SuStep): Promise<void> {
    this.emit("step", `escalate: su - ${step.user}`);
    this.writeRaw(`su - ${shellQuote(step.user)}\n`);
    const re = step.promptRe ? new RegExp(step.promptRe) : this.passwordPrompt;
    await this.exp.expect(re, this.syncTimeoutMs);
    await this.sendSecret(step.secretRef);
    const who = (await this.rawRun(this.whoamiCmd, this.syncTimeoutMs)).stdout.trim();
    if (who !== step.user) {
      throw new SessionError(`su to "${step.user}" failed (whoami="${who}")`);
    }
  }

  private async doHop(hop: Hop): Promise<void> {
    // 1) become the jump user on the current host
    await this.suStep({
      type: "su",
      user: hop.viaUser,
      secretRef: hop.viaSecretRef,
      promptRe: hop.promptRe,
    });
    // 2) ssh into the internal node
    this.emit("step", `hop: ssh ${hop.to}`);
    this.writeRaw(`ssh ${shellQuote(hop.to)}\n`);
    const re = hop.promptRe ? new RegExp(hop.promptRe) : this.passwordPrompt;
    await this.exp.expect(re, this.syncTimeoutMs);
    await this.sendSecret(hop.sshSecretRef);
    await this.rawRun("true", this.syncTimeoutMs); // confirm responsive on the node
    // 3) escalate on the node
    for (const step of hop.escalate ?? []) await this.suStep(step);
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
    return {
      stdout: this.redact(stripAnsi(completion.stdout)),
      exitCode: completion.exitCode,
    };
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
