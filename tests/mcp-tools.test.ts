import { describe, expect, test } from "bun:test";
import { SessionPool } from "../src/session";
import { envListTool, execTool, type McpDeps } from "../src/mcp/tools";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);

function setup(): { deps: McpDeps; registry: Registry; pool: SessionPool } {
  const registry = new Registry(":memory:");
  const env: EnvDescriptor = {
    id: "e",
    form: "proprietary",
    bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
  };
  registry.upsertEnv(env);
  const pool = new SessionPool(registry, localFactory);
  return { deps: { registry, pool }, registry, pool };
}

describe("MCP tools (RFC-0005)", () => {
  test("exec runs a command on the env session", async () => {
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

  test("exec returns the remote exit code (non-zero is a normal result)", async () => {
    const { deps, pool, registry } = setup();
    try {
      const r = await execTool(deps, { env: "e", command: "false" }); // exit 1, doesn't kill the shell
      expect(r.exitCode).toBe(1);
    } finally {
      await pool.releaseAll();
      registry.close();
    }
  });

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
});
