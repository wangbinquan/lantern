#!/usr/bin/env bun
/**
 * Lantern env-admin CLI (RFC-0005). Out-of-band environment setup — secrets are
 * entered here (hidden) and go straight to the OS keychain, never through the
 * model. The MCP server (src/mcp/server.ts) reads these environments and exposes
 * `env_list` + `exec` to opencode.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { KeychainSecretStore, keychainAvailable, Registry } from "../registry";
import { runEnvInitCli } from "./env-init";

const HELP = `lantern — env-admin for the Lantern MCP server

  lantern env init <id> [--insecure-host-key] [--no-use]   # interactive: add an environment (creds → keychain)
  lantern env list
  lantern env use <id>
  lantern env current
  lantern env rm <id>

Registry: ~/.lantern/registry.db (or $LANTERN_HOME); secrets: OS keychain.
The MCP server reads these and gives opencode the env_list + exec tools.`;

function registryDbPath(): string {
  return process.env.LANTERN_HOME
    ? join(process.env.LANTERN_HOME, "registry.db")
    : join(homedir(), ".lantern", "registry.db");
}

function openRegistry(): Registry {
  const useKeychain = process.env.LANTERN_LOCAL_SHELL !== "1" && keychainAvailable();
  return new Registry(registryDbPath(), useKeychain ? new KeychainSecretStore() : undefined);
}

const [cmd, sub, arg, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
if (cmd !== "env") {
  process.stderr.write(`lantern: unknown command "${cmd}" (try: lantern env …)\n`);
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
