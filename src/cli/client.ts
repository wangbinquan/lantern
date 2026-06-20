/**
 * Minimal NDJSON RPC client over the lanternd unix socket. One request, one
 * response, then close — matching how opencode's bash invokes `lantern` per
 * command.
 */
import type { RpcRequest, RpcResponse, WatchEvent } from "../daemon";

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

/** A frame on the watch stream: the initial ack, or a `{ watch: <event> }` push. */
export interface WatchFrame {
  id?: number;
  ok?: boolean;
  error?: string;
  result?: { watching?: string };
  watch?: WatchEvent;
}

export interface WatchHandle {
  close(): void;
}

/**
 * Open a long-lived watch stream (RFC-0001). Connects, sends the watch request,
 * and invokes `onFrame` for each NDJSON frame until closed. Resolves once the
 * request is sent; the returned handle detaches without affecting the daemon.
 */
export async function watchStream(
  socketPath: string,
  req: { params?: Record<string, unknown>; token?: string },
  onFrame: (frame: WatchFrame) => void,
): Promise<WatchHandle> {
  let buf = "";
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, chunk: Buffer) {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim().length === 0) continue;
          try {
            onFrame(JSON.parse(line) as WatchFrame);
          } catch {
            // skip a malformed frame rather than tear down the stream
          }
        }
      },
    },
  });
  socket.write(JSON.stringify({ id: 1, method: "watch", ...req }) + "\n");
  return { close: () => socket.end() };
}
