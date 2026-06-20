import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../src/cli/client";
import { Daemon, SessionPool } from "../src/daemon";
import { Registry } from "../src/registry";

describe("socket capability token (Codex C2)", () => {
  test("daemon rejects missing/wrong tokens and accepts the right one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-tok-"));
    const socketPath = join(dir, "d.sock");
    const registry = new Registry(":memory:");
    // ping never touches the pool, so the factory must never run.
    const pool = new SessionPool(registry, () => () => {
      throw new Error("session factory must not be called");
    });
    const daemon = new Daemon({ registry, pool }, { token: "s3cr3t-token" });
    daemon.listen(socketPath);

    try {
      const noTok = await rpc(socketPath, { id: 1, method: "ping" });
      expect(noTok.ok).toBe(false);
      if (!noTok.ok) expect(noTok.error).toContain("unauthorized");

      const wrong = await rpc(socketPath, { id: 2, method: "ping", token: "nope" });
      expect(wrong.ok).toBe(false);

      const right = await rpc(socketPath, { id: 3, method: "ping", token: "s3cr3t-token" });
      expect(right.ok).toBe(true);
    } finally {
      daemon.stop();
      await pool.releaseAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
