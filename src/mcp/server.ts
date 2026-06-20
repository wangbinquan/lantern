#!/usr/bin/env bun
/**
 * Lantern stdio MCP server (RFC-0005). opencode spawns this via
 * `mcp.servers.lantern = {type:"local", command:["bun", "<repo>/src/mcp/server.ts"]}`
 * and talks MCP over stdio. Tools: `env_list` + `exec`. NOTHING is written to
 * stdout except MCP protocol frames (logs go to stderr).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SessionPool } from "../daemon/pool";
import { spawnPty } from "../pty";
import { KeychainSecretStore, keychainAvailable, Registry } from "../registry";
import { VERSION } from "../version";
import { envListTool, execTool, type McpDeps } from "./tools";

const localShell = process.env.LANTERN_LOCAL_SHELL === "1";
const dbPath = process.env.LANTERN_HOME
  ? join(process.env.LANTERN_HOME, "registry.db")
  : join(homedir(), ".lantern", "registry.db");
const useKeychain = !localShell && keychainAvailable();

const registry = new Registry(dbPath, useKeychain ? new KeychainSecretStore() : undefined);
const pool = localShell
  ? new SessionPool(registry, () => () => spawnPty(["bash", "--norc", "--noprofile"]))
  : new SessionPool(registry);
const deps: McpDeps = { registry, pool };

const server = new McpServer({ name: "lantern", version: VERSION });

server.registerTool(
  "env_list",
  { description: "List the configured isolated environments (ids + labels).", inputSchema: {} },
  () => ({ content: [{ type: "text", text: JSON.stringify(envListTool(deps), null, 2) }] }),
);

server.registerTool(
  "exec",
  {
    description:
      "Run a shell command on an isolated environment's persistent SSH session " +
      "(bastion login → su → ssh internal → su). Returns {stdout, exitCode}. " +
      "Passwords are injected at the PTY and never returned.",
    inputSchema: {
      env: z.string().describe("environment id (from env_list)"),
      command: z.string().describe("shell command to run on the environment"),
      timeoutMs: z.number().int().positive().optional().describe("per-command timeout in ms"),
    },
  },
  async (args) => {
    const r = await execTool(deps, args);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

process.stderr.write(
  `lantern MCP server (${VERSION}) — db ${dbPath}, secrets ${useKeychain ? "keychain" : "sqlite"}${localShell ? ", LOCAL-SHELL" : ""}\n`,
);
await server.connect(new StdioServerTransport());

const shutdown = (): void => {
  void pool.releaseAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
