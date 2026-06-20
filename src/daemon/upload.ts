/**
 * base64-over-PTY upload codec (RFC-0003 §4.3). scp/sftp can't traverse the
 * multi-hop/su PTY, so a local artifact is base64-encoded and streamed through
 * the session in chunks, decoded remotely, and sha256-verified.
 *
 * `planUpload` is PURE (produces the ordered remote command strings) so it is
 * fully unit-tested; `readArtifact` is the only local I/O. The chunk is single-
 * quoted — the base64 alphabet [A-Za-z0-9+/=] carries no shell metacharacters.
 */
import { createHash } from "node:crypto";
import { shellQuote } from "../util/shell";

export interface Artifact {
  bytes: number;
  base64: string;
  /** hex SHA-256 of the artifact. */
  sha256: string;
}

/** Read a local artifact: size, base64, and sha256 (lanternd runs on the operator box). */
export async function readArtifact(path: string): Promise<Artifact> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`artifact not found: ${path}`);
  const buf = Buffer.from(await file.arrayBuffer());
  return {
    bytes: buf.length,
    base64: buf.toString("base64"),
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

export interface PlanUploadOpts {
  base64: string;
  remotePath: string;
  tmpPath: string;
  /** base64 chars per chunk (default 16384). */
  chunkSize?: number;
}

export interface UploadPlan {
  chunkCount: number;
  /** Truncate the temp file, then append each base64 chunk. No stdout expected. */
  appendCommands: string[];
  /** Decode the temp file into remotePath (GNU/BSD portable). */
  decodeCommand: string;
  /** Its stdout's first hex token is the remote sha256, to compare with the local one. */
  checksumCommand: string;
  /** Remove the temp file. */
  cleanupCommand: string;
}

/** Build the ordered remote command sequence to upload + decode + checksum. */
export function planUpload(opts: PlanUploadOpts): UploadPlan {
  const chunkSize = opts.chunkSize ?? 16384;
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  const tmp = shellQuote(opts.tmpPath);
  const out = shellQuote(opts.remotePath);

  const appendCommands: string[] = [`: > ${tmp}`];
  let chunkCount = 0;
  for (let i = 0; i < opts.base64.length; i += chunkSize) {
    appendCommands.push(`printf %s '${opts.base64.slice(i, i + chunkSize)}' >> ${tmp}`);
    chunkCount += 1;
  }

  return {
    chunkCount,
    appendCommands,
    decodeCommand: `{ base64 -d ${tmp} > ${out} 2>/dev/null || base64 -D ${tmp} > ${out} ; }`,
    checksumCommand: `{ sha256sum ${out} 2>/dev/null || shasum -a 256 ${out} ; }`,
    cleanupCommand: `rm -f ${tmp}`,
  };
}

/** Parse the leading hex digest from `sha256sum`/`shasum` output. */
export function parseChecksum(stdout: string): string | null {
  const m = /\b[0-9a-f]{64}\b/.exec(stdout.trim().toLowerCase());
  return m ? m[0] : null;
}
