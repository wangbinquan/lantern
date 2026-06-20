#!/usr/bin/env bun
/**
 * lantern CLI — parse argv, RPC to lanternd, print the result, exit with the
 * remote command's exit code. This is what opencode's bash tool invokes.
 */
import { readFileSync } from "node:fs";
import { defaultSocketPath, defaultTokenPath, type RunResultPayload } from "../daemon";
import { HELP, parseCli } from "./args";
import { rpc } from "./client";

const parsed = parseCli(process.argv.slice(2));
if (parsed.kind === "help") {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
if (parsed.kind === "error") {
  process.stderr.write(`lantern: ${parsed.message}\n`);
  process.exit(2);
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

let token: string | undefined;
try {
  token = readFileSync(defaultTokenPath(), "utf8").trim() || undefined;
} catch {
  token = undefined; // daemon may be running without a token
}

const resp = await rpc(defaultSocketPath(), { id: 1, method: parsed.method, params, token });
if (!resp.ok) {
  process.stderr.write(`lantern: ${resp.error}\n`);
  process.exit(1);
}

if (parsed.method === "ping") {
  process.stdout.write("pong\n");
} else if (parsed.method.startsWith("env.")) {
  process.stdout.write(JSON.stringify(resp.result, null, 2) + "\n");
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
