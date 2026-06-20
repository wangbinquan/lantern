/**
 * Host-key fingerprint fetch for `lantern env init` (RFC-0002 §4.2). Runs
 * `ssh-keyscan` against the bastion and computes the SHA-256 of the key blob.
 *
 * IMPORTANT encoding note: connectSsh2 verifies with ssh2's `hostHash:"sha256"`,
 * which yields a HEX digest of the raw key. `ssh-keygen -l` shows base64. So we
 * compute the hash ourselves from the key blob and PIN the hex (matches the
 * verifier); we also surface the familiar `SHA256:<base64>` for the operator.
 */
import { createHash } from "node:crypto";

export interface RunResult {
  stdout: string;
  success: boolean;
}
export type Runner = (cmd: string[]) => RunResult;

const defaultRunner: Runner = (cmd) => {
  const r = Bun.spawnSync(cmd);
  return { stdout: r.stdout.toString(), success: r.success };
};

export interface HostKeyResult {
  /** Hex SHA-256 of the key — matches ssh2's hostHash:"sha256"; PIN this. */
  hex: string;
  /** Operator-facing `SHA256:<base64>` (what `ssh`/`ssh-keygen` display). */
  display: string;
  keyType: string;
}

/** First non-comment `<host> <type> <base64>` line. */
function firstKeyLine(out: string): string | undefined {
  return out
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && l.split(/\s+/).length >= 3);
}

/**
 * Fetch + fingerprint the bastion host key. Prefers ed25519 (ssh2's default
 * negotiation) and falls back to whatever the server offers. Returns null if
 * ssh-keyscan is unavailable or the host presents nothing. `run` is injectable.
 */
export function fetchHostKeyFingerprint(
  host: string,
  port = 22,
  run: Runner = defaultRunner,
): HostKeyResult | null {
  const base = ["ssh-keyscan", "-T", "5", "-p", String(port)];
  const ed = run([...base, "-t", "ed25519", host]);
  const out = ed.success && firstKeyLine(ed.stdout) ? ed.stdout : run([...base, host]).stdout;

  const line = firstKeyLine(out);
  if (!line) return null;
  const [, keyType, blob] = line.split(/\s+/);
  if (!blob) return null;

  const decoded = Buffer.from(blob, "base64");
  if (decoded.length === 0) return null;
  const raw = createHash("sha256").update(decoded).digest();
  return {
    hex: raw.toString("hex"),
    display: `SHA256:${raw.toString("base64").replace(/=+$/, "")}`,
    keyType: keyType ?? "?",
  };
}
