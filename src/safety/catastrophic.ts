/**
 * Slim catastrophic-command backstop (RFC-0005). Lantern is a connect+exec MCP
 * server; tool-call confirmation is the MCP client's job, but the server still
 * refuses a few clearly-destructive commands as a last line of defense. This is
 * the ONLY remnant of the old read/mutate classifier.
 */

const CATASTROPHIC: { re: RegExp; reason: string }[] = [
  { re: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format (mkfs)" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd)/i, reason: "dd to a raw block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "host power state change" },
  { re: /\binit\s+[06]\b/i, reason: "init runlevel change" },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "redirect to a raw block device" },
  { re: /\bchmod\s+-R\s+0*0{3}\s+\//i, reason: "chmod -R 000 /" },
];

/** `rm` carrying BOTH a recursive and a force flag, in any short/long/split form. */
function hasCatastrophicRm(cmd: string): boolean {
  const re = /\brm\b([^;&|]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const args = m[1]!;
    const recursive = /(^|\s)-[a-zA-Z]*[rR]|(^|\s)--recursive\b/.test(args);
    const force = /(^|\s)-[a-zA-Z]*f|(^|\s)--force\b/.test(args);
    if (recursive && force) return true;
  }
  return false;
}

/** Reason string if the command is catastrophic (→ refuse), else null. */
export function catastrophicReason(command: string): string | null {
  const cmd = command.trim();
  if (hasCatastrophicRm(cmd)) return "rm -rf (recursive+force)";
  for (const c of CATASTROPHIC) {
    if (c.re.test(cmd)) return c.reason;
  }
  return null;
}
