/**
 * `lantern` CLI argument parsing (pure, unit-tested). Maps subcommands + flags
 * to an RPC request. The CLI is what opencode's bash tool invokes; flags are
 * structured so the bash string stays metachar-free (e.g. complex grep patterns
 * go via --grep-b64).
 */
import type { RpcMethod } from "../daemon";

export type ParsedCli =
  | { kind: "rpc"; method: RpcMethod; params: Record<string, unknown> }
  | { kind: "init"; id: string; opts: { insecureHostKey?: boolean; noUse?: boolean } }
  | { kind: "help" }
  | { kind: "error"; message: string };

interface ParsedFlags {
  flags: Record<string, string>;
  after: string[];
  /** Stray positional tokens (before `--`) — rejected to catch typos (Codex L3). */
  positional: string[];
}

function parseFlags(tokens: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const after: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--") {
      after.push(...tokens.slice(i + 1));
      break;
    }
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(t);
    }
  }
  return { flags, after, positional };
}

const err = (message: string): ParsedCli => ({ kind: "error", message });

export function parseCli(argv: string[]): ParsedCli {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return { kind: "help" };

  if (cmd === "ping") return { kind: "rpc", method: "ping", params: {} };

  if (cmd === "env") {
    const sub = rest[0];
    if (sub === "list") return { kind: "rpc", method: "env.list", params: {} };
    if (sub === "add") return { kind: "rpc", method: "env.add", params: {} }; // reads JSON from stdin
    if (sub === "current") return { kind: "rpc", method: "env.current", params: {} };
    if (sub === "use") {
      const id = rest[1];
      if (!id) return err("usage: lantern env use <id>");
      return { kind: "rpc", method: "env.use", params: { id } };
    }
    if (sub === "init") {
      const id = rest[1];
      if (!id) return err("usage: lantern env init <id> [--insecure-host-key] [--no-use]");
      const { flags, positional } = parseFlags(rest.slice(2));
      if (positional.length > 0) return err(`unexpected argument(s): ${positional.join(" ")}`);
      return {
        kind: "init",
        id,
        opts: {
          insecureHostKey: flags["insecure-host-key"] === "true",
          noUse: flags["no-use"] === "true",
        },
      };
    }
    return err(`unknown 'env' subcommand: ${sub ?? "(none)"}`);
  }

  if (cmd === "watch") {
    const { flags, positional } = parseFlags(rest);
    if (positional.length > 0) return err(`unexpected argument(s): ${positional.join(" ")}`);
    const params: Record<string, unknown> = {};
    if (flags.env) params.env = flags.env;
    if (flags["no-output"]) params.noOutput = true;
    return { kind: "rpc", method: "watch", params };
  }

  if (cmd === "put" || cmd === "restart" || cmd === "swap") {
    const { flags, positional } = parseFlags(rest);
    if (positional.length > 0) return err(`unexpected argument(s): ${positional.join(" ")}`);
    const params: Record<string, unknown> = {};
    if (flags.env) params.envId = flags.env;
    if (flags.service) params.service = flags.service;
    if (flags.timeout) params.timeoutMs = Number(flags.timeout);
    if (flags["chunk-size"]) params.chunkSize = Number(flags["chunk-size"]);
    if (!params.service) return err(`usage: lantern ${cmd} --service <name> [--env <id>]`);
    if (cmd === "put" || cmd === "swap") {
      if (!flags.file) {
        return err(`usage: lantern ${cmd} --service <name> --file <local-artifact> [--env <id>]`);
      }
      params.file = flags.file;
    }
    if (cmd === "swap") {
      if (flags["dry-run"]) params.dryRun = true;
      if (flags["no-rollback"]) params.rollback = false;
    }
    return { kind: "rpc", method: cmd, params };
  }

  if (cmd === "logs" || cmd === "state" || cmd === "snapshot" || cmd === "exec") {
    const { flags, after, positional } = parseFlags(rest);
    if (positional.length > 0) return err(`unexpected argument(s): ${positional.join(" ")}`);
    const params: Record<string, unknown> = {};
    if (flags.env) params.envId = flags.env;
    if (flags.service) params.service = flags.service;
    if (flags.timeout) params.timeoutMs = Number(flags.timeout);

    if (cmd === "logs") {
      if (flags.grep) params.grep = flags.grep;
      if (flags["grep-b64"])
        params.grep = Buffer.from(flags["grep-b64"], "base64").toString("utf8");
      if (flags.tail) params.tail = Number(flags.tail);
      if (flags.since) params.since = flags.since;
      if (flags["limit-bytes"]) params.limitBytes = Number(flags["limit-bytes"]);
      if (flags.container) params.container = flags.container;
      if (!params.service)
        return err("usage: lantern logs --service <name> [--env <id>] [--grep G] [--tail N]");
    }

    if (cmd === "state" || cmd === "snapshot") {
      if (!params.service) return err(`usage: lantern ${cmd} --service <name> [--env <id>]`);
    }

    if (cmd === "exec") {
      const command = flags.command ?? (after.length > 0 ? after.join(" ") : undefined);
      if (!command)
        return err("usage: lantern exec [--env <id>] (--command '<cmd>' | -- <cmd> ...)");
      params.command = command;
    }

    return { kind: "rpc", method: cmd, params };
  }

  return err(`unknown command: ${cmd}`);
}

export const HELP = `lantern — operate an isolated environment through lanternd

Usage:
  lantern ping
  lantern env list
  lantern env init <id> [--insecure-host-key] [--no-use]   # 交互式接环境向导
  lantern env use <id>
  lantern env current
  lantern logs   --service <name> [--env <id>] [--grep G | --grep-b64 B64] [--tail N] [--since 5m] [--limit-bytes N] [--container C]
  lantern state  --service <name> [--env <id>]
  lantern exec   [--env <id>] (--command '<cmd>' | -- <cmd> ...)
  lantern watch  [--env <id>] [--no-output]   # read-only live mirror of env activity
  lantern put     --service <name> --file <local> [--env <id>] [--chunk-size N]
  lantern restart --service <name> [--env <id>]
  lantern swap    --service <name> --file <local> [--dry-run] [--no-rollback] [--env <id>]

Read subcommands (env list/current, logs, state) are read-only by construction.
put/restart/swap are MUTATING (each requires confirmation); swap = backup→upload→restart→health→rollback.
exec is classified by lanternd; catastrophic commands are refused.
Socket: $LANTERN_SOCK or ~/.lantern/lanternd.sock`;
