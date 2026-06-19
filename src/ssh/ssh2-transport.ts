/**
 * Real ssh2 transport (design.md §4.1). Connects to the bastion as the low-priv
 * user and opens ONE `conn.shell({pty:true})` channel, exposed as a PtyTransport
 * for the SessionManager to drive su/hops over. (su needs a real PTY — this is
 * the production path; tests use spawnPty over local bash.)
 *
 * connectSsh2 needs a live sshd so it is covered by the guarded e2e (slice 9),
 * not unit CI. The *wiring* — building the connect config from a descriptor and
 * resolving the bastion secret — is pure and unit-tested below the fold.
 */
import { Client, type ConnectConfig, type PseudoTtyOptions } from "ssh2";
import type { PtyTransport } from "../pty/transport";
import type { EnvDescriptor, SecretResolver } from "../types";

export interface Ssh2Config {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  readyTimeoutMs?: number;
}

// Wide PTY + dumb term + ECHO off keep the stream clean: no line-wrap newlines,
// minimal escape codes, and our typed commands/passwords are not echoed back.
const PTY: PseudoTtyOptions = {
  term: "dumb",
  cols: 1000,
  rows: 1000,
  modes: { ECHO: 0 },
};

export function connectSsh2(cfg: Ssh2Config): Promise<PtyTransport> {
  return new Promise<PtyTransport>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const sinks: ((c: string) => void)[] = [];
    let early = "";
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => {
      resolveExit = r;
    });

    const emit = (s: string) => {
      if (sinks.length === 0) {
        early += s;
        return;
      }
      for (const sink of sinks) sink(s);
    };

    conn.on("ready", () => {
      conn.shell(PTY, (err, channel) => {
        if (err) {
          settled = true;
          conn.end();
          reject(err);
          return;
        }
        channel.on("data", (d: Buffer) => emit(d.toString("utf8")));
        channel.stderr.on("data", (d: Buffer) => emit(d.toString("utf8")));
        channel.on("close", () => conn.end());
        settled = true;
        resolve({
          write: (data: string) => {
            channel.write(data);
          },
          onData: (cb: (chunk: string) => void) => {
            const first = sinks.length === 0;
            sinks.push(cb);
            if (first && early.length > 0) {
              const pending = early;
              early = "";
              cb(pending);
            }
          },
          close: () => {
            try {
              channel.end();
            } catch {
              // already closed
            }
            conn.end();
          },
          exited,
        });
      });
    });
    conn.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    conn.on("close", () => resolveExit(0));

    const connectCfg: ConnectConfig = {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      password: cfg.password,
      privateKey: cfg.privateKey,
      passphrase: cfg.passphrase,
      readyTimeout: cfg.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
    };
    conn.connect(connectCfg);
  });
}

export type ConnectFn = (cfg: Ssh2Config) => Promise<PtyTransport>;

/**
 * Build a SessionManager transportFactory that opens a fresh bastion shell.
 * `connect` is injectable for tests. Handles password and key auth.
 */
export function makeBastionFactory(
  env: EnvDescriptor,
  resolveSecret: SecretResolver,
  connect: ConnectFn = connectSsh2,
): () => Promise<PtyTransport> {
  return async () => {
    const { bastion } = env;
    const cfg: Ssh2Config = {
      host: bastion.host,
      port: bastion.port ?? 22,
      username: bastion.loginUser,
    };
    if (bastion.auth.type === "password") {
      if (!bastion.auth.secretRef) {
        throw new Error(`env "${env.id}": bastion password auth needs auth.secretRef`);
      }
      cfg.password = await Promise.resolve(resolveSecret(bastion.auth.secretRef));
    } else {
      if (!bastion.auth.keyPath) {
        throw new Error(`env "${env.id}": bastion key auth needs auth.keyPath`);
      }
      cfg.privateKey = await Bun.file(bastion.auth.keyPath).text();
      if (bastion.auth.secretRef) {
        cfg.passphrase = await Promise.resolve(resolveSecret(bastion.auth.secretRef));
      }
    }
    return connect(cfg);
  };
}
