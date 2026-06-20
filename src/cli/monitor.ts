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
  const who = e.role
    ? `${CYAN}${e.env}${RESET} ${DIM}(${e.role})${RESET}`
    : `${CYAN}${e.env}${RESET}`;
  const head = `${DIM}${time}${RESET} ${who}`;
  if (e.refused) {
    return `${head} ${YELLOW}⛔ ${e.command}${RESET}\n    refused: ${e.refused}`;
  }
  if (e.error) {
    return `${head} ${RED}✗ ${e.command}${RESET}\n    error: ${e.error}`;
  }
  const body = (e.stdout ?? "")
    .replace(/\n+$/, "")
    .split("\n")
    .filter((_, i, a) => !(a.length === 1 && a[0] === ""))
    .map((l) => `    ${l}`)
    .join("\n");
  const more =
    e.stdoutBytes > Buffer.byteLength(e.stdout ?? "")
      ? `  ${DIM}…(${e.stdoutBytes} B)${RESET}`
      : "";
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

/**
 * Read bytes [offset, EOF) without slurping the whole file each poll. If the file
 * shrank (truncated/rotated), re-read from the start and flag `reset` so the caller
 * drops any stale partial line.
 */
export function nextRead(
  path: string,
  offset: number,
): { chunk: string; next: number; reset: boolean } {
  const size = statSync(path).size;
  const reset = size < offset;
  const from = reset ? 0 : offset;
  if (size === from) return { chunk: "", next: size, reset };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return { chunk: buf.toString("utf8"), next: size, reset };
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
    const { chunk, next } = nextRead(path, 0);
    const lines = chunk.split("\n").filter(Boolean);
    for (const l of lines.slice(-5)) emit(l);
    offset = next;
  }
  for (;;) {
    await sleep(250);
    if (!existsSync(path)) continue;
    const { chunk, next, reset } = nextRead(path, offset);
    offset = next;
    if (reset) buffered = ""; // file rotated — drop the stale partial line
    if (!chunk) continue;
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? ""; // keep a trailing partial line for the next poll
    for (const l of parts) if (l) emit(l);
  }
}
