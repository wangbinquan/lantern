import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../src/cli/client";
import { Daemon, EventBus, SessionPool, type WatchEvent } from "../src/daemon";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);
const TOKEN = "tok-123";

interface Frame {
  id?: number;
  ok?: boolean;
  error?: string;
  result?: unknown;
  watch?: WatchEvent;
}

function envDesc(): EnvDescriptor {
  return {
    id: "e",
    form: "proprietary",
    bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
    services: [{ name: "sys", runtime: "jvm", locate: { pid: "echo 4242" } }],
  };
}

async function watchClient(socketPath: string, req: object) {
  const frames: Frame[] = [];
  let buf = "";
  const conn = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk: Buffer) {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) frames.push(JSON.parse(line) as Frame);
        }
      },
    },
  });
  conn.write(JSON.stringify(req) + "\n");
  return { frames, close: () => conn.end() };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  for (let i = 0; i < ms / 10; i++) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error("timeout waiting for watch condition");
}

describe("watch streaming RPC (RFC-0001 slice 3)", () => {
  test("acks, then streams bus events to a watch client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-watch-"));
    const socketPath = join(dir, "d.sock");
    const registry = new Registry(":memory:");
    registry.upsertEnv(envDesc());
    const bus = new EventBus();
    const pool = new SessionPool(registry, localFactory, {}, bus);
    const daemon = new Daemon({ registry, pool, bus }, { token: TOKEN });
    daemon.listen(socketPath);

    const w = await watchClient(socketPath, { id: 1, method: "watch", token: TOKEN, params: {} });
    try {
      await waitFor(() => w.frames.length >= 1);
      expect(w.frames[0]).toMatchObject({ id: 1, ok: true, result: { watching: "*" } });

      // trigger activity on a separate connection
      await rpc(socketPath, {
        id: 2,
        method: "state",
        params: { service: "sys", envId: "e" },
        token: TOKEN,
      });

      await waitFor(() => w.frames.some((f) => f.watch?.kind === "command"));
      const events = w.frames.flatMap((f) => (f.watch ? [f.watch] : []));
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("command");
      expect(kinds).toContain("exit");
      const cmd = events.find((e) => e.kind === "command");
      expect(cmd?.kind === "command" && cmd.command).toContain("echo 4242");
    } finally {
      w.close();
      daemon.stop();
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a watch with a wrong token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-watch2-"));
    const socketPath = join(dir, "d.sock");
    const registry = new Registry(":memory:");
    const bus = new EventBus();
    const pool = new SessionPool(registry, localFactory, {}, bus);
    const daemon = new Daemon({ registry, pool, bus }, { token: TOKEN });
    daemon.listen(socketPath);

    const w = await watchClient(socketPath, { id: 9, method: "watch", token: "wrong", params: {} });
    try {
      await waitFor(() => w.frames.length >= 1);
      expect(w.frames[0]?.ok).toBe(false);
      expect(w.frames[0]?.error).toContain("unauthorized");
    } finally {
      w.close();
      daemon.stop();
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
