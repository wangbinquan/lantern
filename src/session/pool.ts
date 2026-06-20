/**
 * Session pool: one persistent SessionManager per env.id, single-owner. The
 * factory is injectable so tests use spawnPty + fixtures while production uses
 * the ssh2 bastion factory. Backs the MCP `exec` tool (RFC-0005).
 */
import type { Registry } from "../registry";
import {
  makeBastionFactory,
  SessionManager,
  type SessionOptions,
  type TransportFactory,
} from "../ssh";
import type { EnvDescriptor } from "../types";

export type FactoryMaker = (env: EnvDescriptor) => TransportFactory;

export class SessionPool {
  private readonly sessions = new Map<string, SessionManager>();
  private readonly makeFactory: FactoryMaker;

  constructor(
    private readonly registry: Registry,
    makeFactory?: FactoryMaker,
    private readonly sessionOpts: Partial<SessionOptions> = {},
  ) {
    this.makeFactory =
      makeFactory ?? ((env) => makeBastionFactory(env, this.registry.resolveSecret));
  }

  get(envId: string): SessionManager {
    const existing = this.sessions.get(envId);
    if (existing) return existing;
    const env = this.registry.getEnv(envId);
    if (!env) throw new Error(`unknown environment "${envId}"`);
    const session = new SessionManager(this.makeFactory(env), env, {
      resolveSecret: this.registry.resolveSecret,
      ...this.sessionOpts,
    });
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
