/**
 * swap / put / restart orchestration (RFC-0003 §4.4). The executor runs the
 * upload plan over the session and verifies the sha256; put adds a backup;
 * swap (slice 3) chains put → restart → health → rollback. All steps run through
 * a `SwapRun` (the pool's per-env runner), injectable for tests.
 */
import { classifyCommand } from "../classify";
import type { RunResult } from "../ssh";
import type { ServiceDescriptor } from "../types";
import { shellQuote } from "../util/shell";
import { type Artifact, parseChecksum, planUpload } from "./upload";

export type SwapRun = (command: string) => Promise<RunResult>;

export function uploadTmpPath(service: ServiceDescriptor): string {
  const safe = service.name.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `/tmp/lantern-upload-${safe}.b64`;
}

export function backupPath(remotePath: string): string {
  return `${remotePath}.lantern.bak`;
}

/**
 * Stream the artifact through the PTY, decode + verify sha256 in a STAGING file,
 * then atomically `mv` it into place (Codex H-3). remotePath is never touched
 * until the checksum is verified, so a failed/corrupt upload leaves it intact.
 * Returns the verified hex.
 */
export async function uploadArtifact(
  run: SwapRun,
  artifact: Artifact,
  remotePath: string,
  opts: { tmpPath: string; chunkSize?: number },
): Promise<string> {
  const staging = `${remotePath}.lantern.new`;
  const stagingQ = shellQuote(staging);
  const discardStaging = async (): Promise<void> => {
    try {
      await run(`rm -f ${stagingQ}`);
    } catch {
      // best-effort
    }
  };

  const plan = planUpload({
    base64: artifact.base64,
    remotePath: staging, // decode into staging, NOT the live path
    tmpPath: opts.tmpPath,
    chunkSize: opts.chunkSize,
  });
  for (const cmd of plan.appendCommands) {
    const r = await run(cmd);
    if (r.exitCode !== 0) {
      await discardStaging();
      throw new Error(`upload failed writing chunks (exit ${r.exitCode})`);
    }
  }
  const dec = await run(plan.decodeCommand);
  if (dec.exitCode !== 0) {
    await discardStaging();
    throw new Error(`remote base64 decode failed (exit ${dec.exitCode})`);
  }
  const sum = await run(plan.checksumCommand);
  await run(plan.cleanupCommand); // remove the base64 temp
  const remoteSha = parseChecksum(sum.stdout);
  if (!remoteSha || remoteSha !== artifact.sha256) {
    await discardStaging(); // live remotePath untouched
    if (!remoteSha) throw new Error("could not read remote checksum after upload");
    throw new Error(
      `upload checksum mismatch (local ${artifact.sha256.slice(0, 12)}… remote ${remoteSha.slice(0, 12)}…)`,
    );
  }
  // verified → atomically move into place
  const mv = await run(`mv ${stagingQ} ${shellQuote(remotePath)}`);
  if (mv.exitCode !== 0) {
    await discardStaging();
    throw new Error(`failed to move staged artifact into place (exit ${mv.exitCode})`);
  }
  return remoteSha;
}

/** Back up remotePath → `.lantern.bak` if it exists. Returns whether a backup was made. */
export async function backupIfExists(run: SwapRun, remotePath: string): Promise<boolean> {
  const rp = shellQuote(remotePath);
  const bak = shellQuote(backupPath(remotePath));
  const r = await run(`if [ -f ${rp} ]; then cp ${rp} ${bak} && echo __LANTERN_BACKED_UP__; fi`);
  return r.stdout.includes("__LANTERN_BACKED_UP__");
}

export interface PutResult {
  remotePath: string;
  sha256: string;
  backedUp: boolean;
}

/** Back up + upload a built artifact to the service's swap.remotePath. */
export async function doPut(
  run: SwapRun,
  service: ServiceDescriptor,
  artifact: Artifact,
  chunkSize?: number,
): Promise<PutResult> {
  const remotePath = service.swap?.remotePath;
  if (!remotePath) throw new Error(`service "${service.name}" has no swap.remotePath`);
  const backedUp = await backupIfExists(run, remotePath);
  const sha256 = await uploadArtifact(run, artifact, remotePath, {
    tmpPath: uploadTmpPath(service),
    chunkSize,
  });
  return { remotePath, sha256, backedUp };
}

/** Run the service's swap.restartCmd. */
export async function doRestart(run: SwapRun, service: ServiceDescriptor): Promise<RunResult> {
  const cmd = service.swap?.restartCmd;
  if (!cmd) throw new Error(`service "${service.name}" has no swap.restartCmd`);
  return run(cmd);
}

/** Validate the swap recipe; healthCmd (if any) must be read-only. */
function requireSwap(service: ServiceDescriptor): { remotePath: string; restartCmd: string } {
  const swap = service.swap;
  if (!swap?.remotePath) throw new Error(`service "${service.name}" has no swap.remotePath`);
  if (!swap.restartCmd) throw new Error(`service "${service.name}" has no swap.restartCmd`);
  if (swap.healthCmd) {
    const v = classifyCommand(swap.healthCmd);
    if (v.verdict !== "read") {
      throw new Error(`swap.healthCmd must be read-only (${v.verdict}: ${v.reason})`);
    }
  }
  return { remotePath: swap.remotePath, restartCmd: swap.restartCmd };
}

export interface SwapPreview {
  service: string;
  artifactBytes: number;
  sha256: string;
  remotePath: string;
  backupPath: string;
  restartCmd: string;
  healthCmd?: string;
  rollback: boolean;
  chunkCount: number;
}

/** Compute what a swap WOULD do, without touching the env (--dry-run, RFC-0003). */
export function previewSwap(
  service: ServiceDescriptor,
  artifact: Artifact,
  opts: { rollback?: boolean; chunkSize?: number } = {},
): SwapPreview {
  const { remotePath, restartCmd } = requireSwap(service);
  const plan = planUpload({
    base64: artifact.base64,
    remotePath,
    tmpPath: uploadTmpPath(service),
    chunkSize: opts.chunkSize,
  });
  return {
    service: service.name,
    artifactBytes: artifact.bytes,
    sha256: artifact.sha256,
    remotePath,
    backupPath: backupPath(remotePath),
    restartCmd,
    healthCmd: service.swap?.healthCmd,
    rollback: opts.rollback ?? service.swap?.rollback ?? true,
    chunkCount: plan.chunkCount,
  };
}

export interface SwapResult {
  service: string;
  remotePath: string;
  sha256: string;
  backedUp: boolean;
  /** True only if restartCmd exited 0 (Codex H-4). */
  restarted: boolean;
  /** Exit code of healthCmd, or null if none configured / restart failed. */
  healthExit: number | null;
  /** True if restarted AND healthy (or no healthCmd). */
  swapped: boolean;
  rolledBack: boolean;
  /** Set when a rollback was attempted but its cp/restart failed — bad state. */
  rollbackError?: string;
}

/** The full loop: backup → upload → restart → health → (rollback on failure). */
export async function doSwap(
  run: SwapRun,
  service: ServiceDescriptor,
  artifact: Artifact,
  opts: {
    rollback?: boolean;
    chunkSize?: number;
    onStep?: (label: string, command: string) => void;
  } = {},
): Promise<SwapResult> {
  const { remotePath, restartCmd } = requireSwap(service);
  const rollback = opts.rollback ?? service.swap?.rollback ?? true;
  const step = opts.onStep ?? (() => {});

  // surface the actual mutating commands to the operator/watch (Codex M-1);
  // the per-chunk base64 appends are intentionally summarized to avoid flooding.
  step("backup", `cp ${remotePath} ${backupPath(remotePath)} (if present)`);
  step("upload", `base64 → ${remotePath}.lantern.new → sha256 verify → mv → ${remotePath}`);
  const put = await doPut(run, service, artifact, opts.chunkSize);

  step("restart", restartCmd);
  const restartRes = await doRestart(run, service);
  const restarted = restartRes.exitCode === 0; // H-4: don't assume success

  // a failed restart is itself unhealthy; only health-check if it came up
  let healthExit: number | null = null;
  let healthy = restarted;
  if (restarted && service.swap?.healthCmd) {
    step("health", service.swap.healthCmd);
    const h = await run(service.swap.healthCmd);
    healthExit = h.exitCode;
    healthy = h.exitCode === 0;
  }

  let rolledBack = false;
  let rollbackError: string | undefined;
  if (!healthy && rollback && put.backedUp) {
    const rp = shellQuote(remotePath);
    const bak = shellQuote(backupPath(remotePath));
    step("rollback", `cp ${bak} ${rp}`);
    const cpRes = await run(`cp ${bak} ${rp}`);
    const restartBack = await doRestart(run, service);
    rolledBack = cpRes.exitCode === 0 && restartBack.exitCode === 0;
    if (!rolledBack) {
      rollbackError = `rollback incomplete (cp exit ${cpRes.exitCode}, restart exit ${restartBack.exitCode}) — service "${service.name}" may be in a bad state`;
    }
  }

  return {
    service: service.name,
    remotePath: put.remotePath,
    sha256: put.sha256,
    backedUp: put.backedUp,
    restarted,
    healthExit,
    swapped: healthy,
    rolledBack,
    ...(rollbackError ? { rollbackError } : {}),
  };
}
