/**
 * lanternd unix-socket server: NDJSON request/response framing around dispatch().
 * Local socket only (~/.lantern/lanternd.sock) — nothing listens on the network,
 * honoring the env's no-extra-port constraint (the socket is on the operator box).
 *
 * The `watch` method (RFC-0001) is special: instead of one response, the daemon
 * keeps the connection open, replays the bus ring buffer, and streams every
 * WatchEvent as a `{ watch: <event> }` frame until the client disconnects.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { RpcResponse } from "./protocol";
import type { WatchEvent } from "./watch";

interface Writable {
  write(data: string): number;
}

export class Daemon {
  private listener?: { stop: (closeActive?: boolean) => void };
  private socketPath?: string;
  private readonly watchers = new Map<object, () => void>();

  constructor(
    private readonly deps: DispatchDeps,
    private readonly opts: { token?: string } = {},
  ) {}

  listen(socketPath: string): void {
    const dir = dirname(socketPath);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700); // owner-only (Codex C2)
    if (existsSync(socketPath)) rmSync(socketPath); // clear a stale socket
    this.socketPath = socketPath;
    const deps = this.deps;
    const token = this.opts.token;
    const bus = this.deps.bus;
    const watchers = this.watchers;
    const buffers = new WeakMap<object, string>();

    const writeFrame = (socket: Writable, obj: unknown): void => {
      socket.write(JSON.stringify(obj) + "\n");
    };

    const startWatch = (
      socket: Writable,
      req: { id?: number; token?: string; params?: Record<string, unknown> },
    ): void => {
      if (token !== undefined && req.token !== token) {
        writeFrame(socket, {
          id: req.id ?? 0,
          ok: false,
          error: "unauthorized: invalid or missing token",
        });
        return;
      }
      if (!bus) {
        writeFrame(socket, {
          id: req.id ?? 0,
          ok: false,
          error: "watch unavailable (no event bus)",
        });
        return;
      }
      const envFilter = typeof req.params?.env === "string" ? req.params.env : undefined;
      // ack first, then bus.subscribe replays the ring buffer, then live events.
      writeFrame(socket, { id: req.id ?? 0, ok: true, result: { watching: envFilter ?? "*" } });
      watchers.get(socket)?.(); // replace any prior watcher on this socket
      const unsub = bus.subscribe((e: WatchEvent) => {
        if (envFilter && e.env !== envFilter) return;
        try {
          writeFrame(socket, { watch: e });
        } catch {
          // socket gone — stop streaming to it
          unsub();
          watchers.delete(socket);
        }
      });
      watchers.set(socket, unsub);
    };

    const drop = (socket: object): void => {
      watchers.get(socket)?.();
      watchers.delete(socket);
    };

    this.listener = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, chunk: Buffer) {
          const text = (buffers.get(socket) ?? "") + chunk.toString("utf8");
          const lines = text.split("\n");
          buffers.set(socket, lines.pop() ?? ""); // keep the partial last line
          for (const line of lines) {
            if (line.trim().length === 0) continue;
            let peeked:
              | { method?: string; id?: number; token?: string; params?: Record<string, unknown> }
              | undefined;
            try {
              peeked = JSON.parse(line);
            } catch {
              peeked = undefined;
            }
            if (peeked?.method === "watch") {
              startWatch(socket, peeked);
              continue;
            }
            void respond(deps, line, token).then((resp) => writeFrame(socket, resp));
          }
        },
        close(socket) {
          drop(socket);
        },
        error(socket) {
          drop(socket);
        },
      },
    });
    chmodSync(socketPath, 0o600); // socket owner-only (Codex C2)
  }

  stop(): void {
    for (const unsub of this.watchers.values()) unsub();
    this.watchers.clear();
    this.listener?.stop(true);
    this.listener = undefined;
    if (this.socketPath && existsSync(this.socketPath)) rmSync(this.socketPath);
  }
}

async function respond(deps: DispatchDeps, line: string, token?: string): Promise<RpcResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { id: 0, ok: false, error: `bad request JSON: ${(e as Error).message}` };
  }
  const req = parsed as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    token?: string;
  };
  if (typeof req.method !== "string") {
    return { id: req.id ?? 0, ok: false, error: "missing request method" };
  }
  // Capability-token check (Codex C2): when the daemon was started with a token,
  // every request must present it. Constant-ish comparison; tokens are 256-bit.
  if (token !== undefined && req.token !== token) {
    return { id: req.id ?? 0, ok: false, error: "unauthorized: invalid or missing token" };
  }
  // dispatch validates the method name itself.
  return dispatch(deps, {
    id: req.id ?? 0,
    method: req.method as never,
    params: req.params,
  });
}
