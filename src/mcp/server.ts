#!/usr/bin/env bun
/**
 * Lantern stdio MCP server (RFC-0005). opencode spawns this via
 * `mcp.servers.lantern = {type:"local", command:["bun", "<repo>/src/mcp/server.ts"]}`
 * and talks MCP over stdio. Tools: `env_list` + `exec`. NOTHING is written to
 * stdout except MCP protocol frames (logs go to stderr).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import { execLogPath, registryDbPath } from "../paths";
import { SessionPool } from "../session";
import { spawnPty } from "../pty";
import { Registry } from "../registry";
import { VERSION } from "../version";
import { envListTool, execTool, type McpDeps } from "./tools";

const localShell = process.env.LANTERN_LOCAL_SHELL === "1";
const dbPath = registryDbPath();

const registry = new Registry(dbPath); // picks keychain / secret-service / DPAPI / sqlite by platform
const pool = localShell
  ? new SessionPool(registry, () => () => spawnPty(["bash", "--norc", "--noprofile"]))
  : new SessionPool(registry);
const deps: McpDeps = {
  registry,
  pool,
  // append-only spectator log; `lantern monitor` tails it (best-effort — never break exec)
  onExec: (e) => {
    try {
      appendFileSync(execLogPath(), JSON.stringify(e) + "\n");
    } catch {
      /* spectator log is non-critical */
    }
  },
};

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
      "Run a shell command on an isolated environment as a chosen role/identity " +
      "(bastion login → node → su to the role's user). Returns {stdout, exitCode}. " +
      "Passwords are injected at the PTY and never returned.",
    inputSchema: {
      env: z.string().describe("environment id (from env_list)"),
      command: z.string().describe("shell command to run on the environment"),
      role: z
        .string()
        .optional()
        .describe("identity to run as (from env_list.roles); omit if the env has one role"),
      target: z
        .string()
        .optional()
        .describe("ssh target for a role whose node is templated (e.g. a discovered worker IP)"),
      timeoutMs: z.number().int().positive().optional().describe("per-command timeout in ms"),
    },
  },
  async (args) => {
    const r = await execTool(deps, args);
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

process.stderr.write(
  `lantern MCP server (${VERSION}) — db ${dbPath}, secrets: ${registry.secretBackend}${localShell ? " [LOCAL-SHELL]" : ""}\n`,
);
await server.connect(new StdioServerTransport());

const shutdown = (): void => {
  void pool.releaseAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
