/**
 * lanternd unix-socket server: NDJSON request/response framing around dispatch().
 * Local socket only (~/.lantern/lanternd.sock) — nothing listens on the network,
 * honoring the env's no-extra-port constraint (the socket is on the operator box).
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { dispatch, type DispatchDeps } from "./dispatch";
import type { RpcResponse } from "./protocol";

export class Daemon {
  private listener?: { stop: (closeActive?: boolean) => void };
  private socketPath?: string;

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
    const buffers = new WeakMap<object, string>();

    this.listener = Bun.listen({
      unix: socketPath,
      socket: {
        data(socket, chunk: Buffer) {
          const text = (buffers.get(socket) ?? "") + chunk.toString("utf8");
          const lines = text.split("\n");
          buffers.set(socket, lines.pop() ?? ""); // keep the partial last line
          for (const line of lines) {
            if (line.trim().length === 0) continue;
            void respond(deps, line, token).then((resp) =>
              socket.write(JSON.stringify(resp) + "\n"),
            );
          }
        },
      },
    });
    chmodSync(socketPath, 0o600); // socket owner-only (Codex C2)
  }

  stop(): void {
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
