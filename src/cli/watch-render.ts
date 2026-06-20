/**
 * Pure renderer for `lantern watch` (RFC-0001 §3): a WatchEvent → one transcript
 * line (or several, for multi-line stdout). Colour only when asked (TTY and not
 * NO_COLOR — decided by the caller). Kept pure so it is unit-tested directly.
 */
import type { WatchEvent } from "../daemon";

export interface RenderOpts {
  color?: boolean;
  /** When false, stdout events render empty (commands/steps only). */
  showOutput?: boolean;
}

const ESC = String.fromCharCode(27);
const codes = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
};

function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${codes.reset}` : s;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function renderWatchEvent(e: WatchEvent, opts: RenderOpts = {}): string {
  const color = opts.color ?? false;
  const showOutput = opts.showOutput ?? true;
  const head = `${clock(e.ts)} ${e.env}`;
  switch (e.kind) {
    case "connect":
      return paint(`● ${e.env}  connected  ${e.chain.join(" → ")}`, codes.green, color);
    case "step":
      return paint(`         ${e.env}  ↳ ${e.text}`, codes.dim, color);
    case "command":
      return `${head} ${e.method}  ${paint("$", codes.cyan, color)} ${e.command}`;
    case "stdout": {
      if (!showOutput) return "";
      const body = e.text.replace(/\n+$/, "");
      if (body.length === 0) return "";
      return body
        .split("\n")
        .map((l) => paint(`         │ ${l}`, codes.dim, color))
        .join("\n");
    }
    case "exit": {
      const ok = e.exitCode === 0;
      const mark = paint(ok ? "✓" : "✗", ok ? codes.green : codes.red, color);
      const trunc = e.truncated ? " (truncated)" : "";
      return `${head} ${e.method}  ${mark} exit ${e.exitCode ?? "?"} (${e.bytes} B)${trunc}`;
    }
    case "denied":
      return `${head} ${e.method}  ${paint(`✗ refused: ${e.reason}`, codes.red, color)}`;
    case "error":
      return `${head}  ${paint(`⚠ ${e.text}`, codes.yellow, color)}`;
    case "meta":
      return paint(`${head}  · ${e.text}`, codes.dim, color);
  }
}
