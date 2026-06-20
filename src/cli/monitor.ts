/**
 * `lantern monitor` — read-only spectator window (RFC-0006). Tails the MCP
 * server's append-only exec log and pretty-prints each executed/refused command,
 * so you can watch the environment in a second terminal while you converse +
 * approve in opencode. No connection to the server; just follows the file.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { execLogPath } from "../paths";
import type { ExecLogEntry } from "../mcp/tools";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Format one log entry as a spectator line (pure — unit-tested). */
export function formatExecLine(e: ExecLogEntry): string {
  const time = new Date(e.ts).toTimeString().slice(0, 8);
  const head = `${DIM}${time}${RESET} ${CYAN}${e.env}${RESET}`;
  if (e.refused) {
    return `${head} ${YELLOW}⛔ ${e.command}${RESET}\n    refused: ${e.refused}`;
  }
  const body = (e.stdout ?? "")
    .replace(/\n+$/, "")
    .split("\n")
    .filter((_, i, a) => !(a.length === 1 && a[0] === ""))
    .map((l) => `    ${l}`)
    .join("\n");
  const more =
    e.stdoutBytes > (e.stdout?.length ?? 0) ? `  ${DIM}…(${e.stdoutBytes} B)${RESET}` : "";
  const status =
    e.exitCode === 0 ? `${GREEN}→ exit 0${RESET}` : `${RED}→ exit ${e.exitCode}${RESET}`;
  return `${head} $ ${e.command}\n${body ? body + "\n" : ""}    ${status}${more}`;
}

function emit(line: string): void {
  let e: ExecLogEntry;
  try {
    e = JSON.parse(line) as ExecLogEntry;
  } catch {
    return; // skip a partial/garbled line
  }
  process.stdout.write(formatExecLine(e) + "\n");
}

/** Read bytes [offset, EOF) without slurping the whole file each poll. */
function readFrom(path: string, offset: number): { chunk: string; next: number } {
  const size = statSync(path).size;
  if (size < offset) return { chunk: "", next: size }; // truncated/rotated → reset
  if (size === offset) return { chunk: "", next: offset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return { chunk: buf.toString("utf8"), next: size };
  } finally {
    closeSync(fd);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runMonitor(): Promise<void> {
  const path = execLogPath();
  process.stderr.write(
    `${DIM}lantern monitor — ${path}\n  read-only spectator; Ctrl-C to leave${RESET}\n\n`,
  );
  let buffered = "";
  // start just before EOF but replay the last few lines for context
  let offset = 0;
  if (existsSync(path)) {
    const { chunk, next } = readFrom(path, 0);
    const lines = chunk.split("\n").filter(Boolean);
    for (const l of lines.slice(-5)) emit(l);
    offset = next;
  }
  for (;;) {
    await sleep(250);
    if (!existsSync(path)) continue;
    const { chunk, next } = readFrom(path, offset);
    offset = next;
    if (!chunk) continue;
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? ""; // keep a trailing partial line for the next poll
    for (const l of parts) if (l) emit(l);
  }
}
