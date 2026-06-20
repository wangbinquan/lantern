/**
 * Session pool (design.md §4.4): one SessionManager per env.id, single-owner.
 * The factory is injectable so tests use spawnPty + fixtures while production
 * uses the ssh2 bastion factory.
 */
import type { Registry } from "../registry";
import {
  makeBastionFactory,
  SessionManager,
  type SessionEvent,
  type SessionOptions,
  type TransportFactory,
} from "../ssh";
import type { EnvDescriptor } from "../types";
import { connectionChain, type EventBus } from "./watch";

export type FactoryMaker = (env: EnvDescriptor) => TransportFactory;

export class SessionPool {
  private readonly sessions = new Map<string, SessionManager>();
  private readonly makeFactory: FactoryMaker;

  constructor(
    private readonly registry: Registry,
    makeFactory?: FactoryMaker,
    private readonly sessionOpts: Partial<SessionOptions> = {},
    private readonly bus?: EventBus,
  ) {
    this.makeFactory =
      makeFactory ?? ((env) => makeBastionFactory(env, this.registry.resolveSecret));
  }

  /** Map a SessionManager event onto the watch bus, tagged with envId (RFC-0001 §4.4). */
  private forward(env: string, chain: string[], e: SessionEvent): void {
    const bus = this.bus;
    if (!bus) return;
    const ts = Date.now();
    switch (e.kind) {
      case "ready":
        bus.publish({ ts, env, kind: "connect", chain });
        break;
      case "stdout":
        bus.publish({ ts, env, kind: "stdout", text: e.text });
        break;
      case "step":
        bus.publish({ ts, env, kind: "step", text: e.text });
        break;
      case "error":
        bus.publish({ ts, env, kind: "error", text: e.text });
        break;
      case "write":
        // raw command writes are covered by dispatch's "command"; surface only
        // the (already-redacted) password sends so the operator sees them.
        if (e.text === "***") bus.publish({ ts, env, kind: "step", text: "sent password ***" });
        break;
    }
  }

  get(envId: string): SessionManager {
    const existing = this.sessions.get(envId);
    if (existing) return existing;
    const env = this.registry.getEnv(envId);
    if (!env) throw new Error(`unknown environment "${envId}"`);
    const opts: SessionOptions = {
      resolveSecret: this.registry.resolveSecret,
      ...this.sessionOpts,
    };
    const chain = connectionChain(env);
    const userOnEvent = opts.onEvent;
    opts.onEvent = (e) => {
      userOnEvent?.(e);
      this.forward(envId, chain, e);
    };
    const session = new SessionManager(this.makeFactory(env), env, opts);
    this.sessions.set(envId, session);
    return session;
  }

  run(envId: string, command: string, timeoutMs?: number) {
    return this.get(envId).run(command, { timeoutMs });
  }

  has(envId: string): boolean {
    return this.sessions.has(envId);
  }

  async release(envId: string): Promise<void> {
    const s = this.sessions.get(envId);
    if (s) {
      await s.release();
      this.sessions.delete(envId);
    }
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.release()));
    this.sessions.clear();
  }
}
