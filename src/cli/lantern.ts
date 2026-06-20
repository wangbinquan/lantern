#!/usr/bin/env bun
/**
 * lantern CLI — parse argv, RPC to lanternd, print the result, exit with the
 * remote command's exit code. This is what opencode's bash tool invokes.
 */
import { readFileSync } from "node:fs";
import { defaultSocketPath, defaultTokenPath, type RunResultPayload } from "../daemon";
import { HELP, parseCli } from "./args";
import { rpc, watchStream } from "./client";
import { renderWatchEvent } from "./watch-render";
import { runEnvInitCli } from "./env-init";

const parsed = parseCli(process.argv.slice(2));
if (parsed.kind === "help") {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
if (parsed.kind === "error") {
  process.stderr.write(`lantern: ${parsed.message}\n`);
  process.exit(2);
}

let token: string | undefined;
try {
  token = readFileSync(defaultTokenPath(), "utf8").trim() || undefined;
} catch {
  token = undefined; // daemon may be running without a token
}

if (parsed.kind === "init") {
  // Interactive onboarding wizard (RFC-0002) — collects answers, ships env.add.
  try {
    await runEnvInitCli(parsed.id, parsed.opts, token);
  } catch (e) {
    process.stderr.write(`lantern env init: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

const params = { ...parsed.params };
if (parsed.method === "env.add") {
  // `lantern env add` reads {"env": <descriptor>, "secrets": {ref: value}} from stdin.
  const input = await Bun.stdin.text();
  try {
    Object.assign(params, JSON.parse(input));
  } catch (e) {
    process.stderr.write(
      `lantern: env add expects a JSON object on stdin (${(e as Error).message})\n`,
    );
    process.exit(2);
  }
}

if (parsed.method === "watch") {
  // Long-lived read-only mirror (RFC-0001): stream + render until Ctrl-C.
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const showOutput = params.noOutput !== true;
  const handle = await watchStream(defaultSocketPath(), { params, token }, (frame) => {
    if (frame.ok === false) {
      process.stderr.write(`lantern watch: ${frame.error}\n`);
      process.exit(1);
    }
    if (frame.watch) {
      const line = renderWatchEvent(frame.watch, { color, showOutput });
      if (line) process.stdout.write(line + "\n");
    } else if (frame.result) {
      process.stderr.write(
        `lantern watch: attached (watching ${frame.result.watching ?? "*"}, Ctrl-C to detach)\n`,
      );
    }
  });
  process.on("SIGINT", () => {
    handle.close();
    process.exit(0);
  });
} else {
  const resp = await rpc(defaultSocketPath(), { id: 1, method: parsed.method, params, token });
  if (!resp.ok) {
    process.stderr.write(`lantern: ${resp.error}\n`);
    process.exit(1);
  }

  if (parsed.method === "ping") {
    process.stdout.write("pong\n");
  } else if (
    parsed.method.startsWith("env.") ||
    parsed.method === "put" ||
    parsed.method === "restart" ||
    parsed.method === "swap"
  ) {
    process.stdout.write(JSON.stringify(resp.result, null, 2) + "\n");
    // swap exits non-zero when it didn't end healthy (e.g. rolled back).
    const res = resp.result as { swapped?: boolean };
    process.exit(res.swapped === false ? 1 : 0);
  } else {
    const r = resp.result as RunResultPayload;
    // Surface the EXPANDED remote command so the operator sees what actually ran
    // (read subcommands expand server-side; Codex M3).
    process.stderr.write(
      `[lantern${params.envId ? ` ${String(params.envId)}` : ""}] $ ${r.command}\n`,
    );
    if (r.stdout.length > 0) {
      process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n");
    }
    process.exit(r.exitCode ?? 0);
  }
}
