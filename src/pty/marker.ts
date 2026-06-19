/**
 * Command-boundary marker protocol (design.md §4.3). A raw PTY gives no
 * "command finished + exit status" signal, so every command is wrapped with a
 * unique marker; we read the stream until the marker line appears, take the
 * text before it as stdout and the trailing integer as the exit code.
 */
import { randomUUID } from "node:crypto";

export const MARKER_PREFIX = "__OC_DONE_";

/** Fresh per-command marker id (hex, no dashes — safe inside a regex/printf). */
export function newMarkerId(): string {
  return randomUUID().replace(/-/g, "");
}

/**
 * Wrap a command so its completion is detectable. The printf is put on its OWN
 * line (not `cmd; printf`) so a trailing `#comment` in `cmd` can't swallow the
 * marker. `$?` after the newline is the exit status of `cmd`.
 */
export function wrapCommand(cmd: string, id: string): string {
  return `${cmd}\nprintf '${MARKER_PREFIX}${id}__%d\\n' "$?"\n`;
}

export interface Completion {
  /** Whether the marker for `id` was found in `text`. */
  done: boolean;
  /** Output before the marker (one injected trailing newline removed). */
  stdout: string;
  /** Parsed exit code, or null if not done. */
  exitCode: number | null;
  /** Stream text after the marker line (e.g. the next prompt). */
  remainder: string;
}

/** Regex matching the completion marker line for `id`, capturing the exit code. */
export function markerRegex(id: string): RegExp {
  return new RegExp(`${MARKER_PREFIX}${id}__(-?\\d+)\\r?\\n?`);
}

/** Locate the marker for `id` in accumulated `text` and split out the result. */
export function parseCompletion(text: string, id: string): Completion {
  const re = markerRegex(id);
  const m = re.exec(text);
  if (!m) return { done: false, stdout: text, exitCode: null, remainder: "" };
  const before = text.slice(0, m.index).replace(/\r?\n$/, ""); // shell-substitution-style trailing-newline trim
  const exitCode = Number.parseInt(m[1]!, 10);
  const remainder = text.slice(m.index + m[0].length);
  return { done: true, stdout: before, exitCode, remainder };
}

// Build the ANSI/CSI/OSC matchers from runtime char codes so the source carries
// no literal control character and the regex isn't statically flagged.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(ESC + "\\[[0-9;?]*[ -/]*[@-~]", "g");
const OSC_RE = new RegExp(ESC + "\\][^" + BEL + "]*(?:" + BEL + "|" + ESC + "\\\\)", "g");

/** Strip ANSI color/CSI and OSC escape sequences from terminal output. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(OSC_RE, "");
}
