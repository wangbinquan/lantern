/**
 * Minimal NDJSON RPC client over the lanternd unix socket. One request, one
 * response, then close — matching how opencode's bash invokes `lantern` per
 * command.
 */
import type { RpcRequest, RpcResponse } from "../daemon";

export function rpc(socketPath: string, req: RpcRequest, timeoutMs = 60_000): Promise<RpcResponse> {
  return new Promise<RpcResponse>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`rpc timeout after ${timeoutMs}ms`))),
      timeoutMs,
    );

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(req) + "\n");
        },
        data(socket, chunk: Buffer) {
          buf += chunk.toString("utf8");
          const idx = buf.indexOf("\n");
          if (idx < 0) return;
          const line = buf.slice(0, idx);
          finish(() => {
            socket.end();
            try {
              resolve(JSON.parse(line) as RpcResponse);
            } catch (e) {
              reject(e as Error);
            }
          });
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
        close() {
          finish(() => reject(new Error("connection closed before a response")));
        },
      },
    }).catch((e: unknown) => finish(() => reject(e as Error)));
  });
}
