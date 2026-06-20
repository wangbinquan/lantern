#!/usr/bin/env bun
/**
 * Lantern env-admin CLI (RFC-0005). Out-of-band environment setup — secrets are
 * entered here (hidden) and go straight to the OS keychain, never through the
 * model. The MCP server (src/mcp/server.ts) reads these environments and exposes
 * `env_list` + `exec` to opencode.
 */
import { registryDbPath } from "../paths";
import { Registry } from "../registry";
import { runEnvInitCli, runNodeAddCli, runRoleAddCli } from "./env-init";
import { runMonitor } from "./monitor";

const HELP = `lantern — env-admin for the Lantern MCP server

  lantern env init <id> [--insecure-host-key] [--no-use]   # interactive: add an environment (creds → keychain)
  lantern env node add <env> <node>                        # add one reachable internal node
  lantern env role add <env> <role>                        # add one per-operation identity (node + su user)
  lantern env list
  lantern env use <id>
  lantern env current
  lantern env rm <id>
  lantern monitor                                          # read-only spectator: live mirror of executed commands

Registry: ~/.lantern/registry.db (or $LANTERN_HOME); secrets: OS keychain.
The MCP server reads these and gives opencode the env_list + exec tools.`;

function openRegistry(): Registry {
  return new Registry(registryDbPath()); // Registry picks the secret backend by platform
}

const [cmd, sub, arg, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
if (cmd === "monitor") {
  await runMonitor(); // read-only spectator; runs until Ctrl-C
  process.exit(0);
}
if (cmd !== "env") {
  process.stderr.write(
    `lantern: unknown command "${cmd}" (try: lantern env … | lantern monitor)\n`,
  );
  process.exit(2);
}

if (sub === "init") {
  if (!arg) {
    process.stderr.write("usage: lantern env init <id> [--insecure-host-key] [--no-use]\n");
    process.exit(2);
  }
  await runEnvInitCli(arg, {
    insecureHostKey: rest.includes("--insecure-host-key"),
    noUse: rest.includes("--no-use"),
  });
  process.exit(0);
}
// incremental, interactive: `env role add <env> <role>` / `env node add <env> <node>`
if ((sub === "role" || sub === "node") && arg === "add") {
  try {
    if (sub === "role") await runRoleAddCli(rest[0]!, rest[1]!);
    else await runNodeAddCli(rest[0]!, rest[1]!);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`lantern: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

const reg = openRegistry();
try {
  if (sub === "list") {
    process.stdout.write(JSON.stringify(reg.listEnvs(), null, 2) + "\n");
  } else if (sub === "current") {
    process.stdout.write(JSON.stringify({ current: reg.getCurrent() }, null, 2) + "\n");
  } else if (sub === "use") {
    if (!arg) throw new Error("usage: lantern env use <id>");
    reg.setCurrent(arg);
    process.stdout.write(`current = ${arg}\n`);
  } else if (sub === "rm") {
    if (!arg) throw new Error("usage: lantern env rm <id>");
    process.stdout.write(reg.removeEnv(arg) ? `removed ${arg}\n` : `no such env "${arg}"\n`);
  } else {
    process.stderr.write(`lantern env: unknown subcommand "${sub ?? ""}"\n`);
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`lantern: ${(e as Error).message}\n`);
  process.exit(1);
} finally {
  reg.close();
}
