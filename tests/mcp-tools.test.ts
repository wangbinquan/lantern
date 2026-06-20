import { describe, expect, test } from "bun:test";
import { SessionPool } from "../src/session";
import { envListTool, execTool, type ExecLogEntry, type McpDeps } from "../src/mcp/tools";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);
const IS_WIN = process.platform === "win32"; // tests that actually connect spawn bash

function setup(): { deps: McpDeps; registry: Registry; pool: SessionPool } {
  const registry = new Registry(":memory:");
  const env: EnvDescriptor = {
    id: "e",
    bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
    roles: { default: {} },
  };
  registry.upsertEnv(env);
  const pool = new SessionPool(registry, localFactory);
  return { deps: { registry, pool }, registry, pool };
}

describe("MCP tools (RFC-0005)", () => {
  test.skipIf(IS_WIN)("exec runs a command on the env session", async () => {
    const { deps, pool, registry } = setup();
    try {
      const r = await execTool(deps, { env: "e", command: "echo mcp-works" });
      expect(r.stdout).toBe("mcp-works");
      expect(r.exitCode).toBe(0);
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test.skipIf(IS_WIN)(
    "exec returns the remote exit code (non-zero is a normal result)",
    async () => {
      const { deps, pool, registry } = setup();
      try {
        const r = await execTool(deps, { env: "e", command: "false" }); // exit 1, doesn't kill the shell
        expect(r.exitCode).toBe(1);
      } finally {
        await pool.releaseAll();
        registry.close();
      }
    },
  );

  test("exec refuses a catastrophic command", async () => {
    const { deps, pool, registry } = setup();
    try {
      await expect(execTool(deps, { env: "e", command: "rm -rf /tmp/x" })).rejects.toThrow(
        /catastrophic/,
      );
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("exec rejects an unknown environment", async () => {
    const { deps, pool, registry } = setup();
    try {
      await expect(execTool(deps, { env: "nope", command: "echo x" })).rejects.toThrow(
        /unknown environment/,
      );
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("SessionPool evicts the LRU session past maxSessions (Codex M)", () => {
    const registry = new Registry(":memory:");
    registry.upsertEnv({
      id: "e",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      roles: { a: {}, b: {}, c: {} },
    });
    const pool = new SessionPool(registry, localFactory, {}, 2); // cap of 2
    try {
      pool.get("e", "a"); // sessions are created lazily (no connect), so this is cheap
      pool.get("e", "b");
      pool.get("e", "c"); // 3rd distinct key → evict the LRU ("a")
      expect(pool.has("e", "a")).toBe(false);
      expect(pool.has("e", "b")).toBe(true);
      expect(pool.has("e", "c")).toBe(true);
    } finally {
      registry.close();
    }
  });

  test("env_list returns configured env ids", () => {
    const { deps, registry } = setup();
    try {
      const list = envListTool(deps).environments;
      expect(list.length).toBe(1);
      expect(list[0]?.id).toBe("e");
    } finally {
      registry.close();
    }
  });

  test.skipIf(IS_WIN)("exec emits a spectator log entry (command + exit + stdout)", async () => {
    const { deps, pool, registry } = setup();
    const seen: ExecLogEntry[] = [];
    deps.onExec = (e) => seen.push(e);
    try {
      await execTool(deps, { env: "e", command: "echo spectate" });
      expect(seen.length).toBe(1);
      expect(seen[0]?.command).toBe("echo spectate");
      expect(seen[0]?.exitCode).toBe(0);
      expect(seen[0]?.stdout).toBe("spectate");
      expect(seen[0]?.refused).toBeUndefined();
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("a refused command is logged as refused, not run", async () => {
    const { deps, pool, registry } = setup();
    const seen: ExecLogEntry[] = [];
    deps.onExec = (e) => seen.push(e);
    try {
      await expect(execTool(deps, { env: "e", command: "rm -rf /" })).rejects.toThrow();
      expect(seen.length).toBe(1);
      expect(seen[0]?.refused).toContain("catastrophic");
      expect(seen[0]?.exitCode).toBeNull();
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

  test("a session failure is still logged (issued but errored — Codex M3)", async () => {
    const registry = new Registry(":memory:");
    registry.upsertEnv({
      id: "e",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      roles: { default: {} },
    });
    const seen: ExecLogEntry[] = [];
    const deps: McpDeps = {
      registry,
      pool: {
        get: () => ({ run: () => Promise.reject(new Error("session timeout")) }),
      } as unknown as SessionPool,
      onExec: (e) => seen.push(e),
    };
    try {
      await expect(execTool(deps, { env: "e", command: "echo hi" })).rejects.toThrow(
        /session timeout/,
      );
      expect(seen.length).toBe(1);
      expect(seen[0]?.error).toContain("session timeout");
      expect(seen[0]?.exitCode).toBeNull();
      expect(seen[0]?.refused).toBeUndefined();
    } finally {
      registry.close();
    }
  });

  test("a pre-flight failure (unknown role) is NOT logged as an exec error (Codex L)", async () => {
    const registry = new Registry(":memory:");
    registry.upsertEnv({
      id: "e",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      roles: { a: {}, b: {} },
    });
    const seen: ExecLogEntry[] = [];
    const pool = new SessionPool(registry, () => () => spawnPty(["bash", "--norc", "--noprofile"]));
    try {
      // unknown role throws during chain resolution, before any command runs
      await expect(
        execTool(
          { registry, pool, onExec: (e) => seen.push(e) },
          {
            env: "e",
            role: "ghost",
            command: "echo hi",
          },
        ),
      ).rejects.toThrow(/no role/);
      expect(seen).toHaveLength(0); // not a command execution → nothing mirrored
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });
});
