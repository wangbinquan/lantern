/**
 * zod validation for the environment descriptor (design.md §3.1). The plain TS
 * interfaces in src/types.ts stay the source of truth used across the codebase;
 * this schema validates untrusted input (registry rows, config files). A
 * compile-time assertion in tests guards the two against drift.
 */
import { z } from "zod";

// A safe username / host (no shell metacharacters) — defense-in-depth alongside
// shell-quoting in SessionManager (Codex H2).
const USERNAME = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "invalid username");
const HOSTNAME = z.string().regex(/^[A-Za-z0-9_.:-]+$/, "invalid host");

export const SuStepSchema = z.object({
  type: z.literal("su"),
  user: USERNAME,
  secretRef: z.string().min(1),
  promptRe: z.string().optional(),
});

export const HopSchema = z.object({
  to: HOSTNAME,
  viaUser: USERNAME,
  viaSecretRef: z.string().min(1),
  sshSecretRef: z.string().min(1),
  escalate: z.array(SuStepSchema).optional(),
  promptRe: z.string().optional(),
});

export const BastionAuthSchema = z.object({
  type: z.enum(["password", "key"]),
  secretRef: z.string().optional(),
  keyPath: z.string().optional(),
});

export const BastionSchema = z.object({
  host: HOSTNAME,
  port: z.number().int().positive().optional(),
  loginUser: USERNAME,
  auth: BastionAuthSchema,
  promptRe: z.string().optional(),
  hostKeySha256: z.string().optional(),
  insecureHostKey: z.boolean().optional(),
});

export const SessionPolicySchema = z.object({
  ttlSec: z.number().nonnegative().optional(),
  idleSec: z.number().nonnegative().optional(),
});

export const RepoRefSchema = z.object({
  local: z.string().optional(),
  git: z.string().optional(),
  ref: z.string().optional(),
});

export const SwapRecipeSchema = z.object({
  mode: z.enum(["auto", "ci", "manual"]),
  buildCmd: z.string().optional(),
  artifact: z.string().optional(),
  putMethod: z.enum(["scp", "base64"]).optional(),
  remotePath: z.string().optional(),
  restartCmd: z.string().optional(),
  healthCmd: z.string().optional(),
  rollback: z.boolean().optional(),
});

export const ServiceLocateSchema = z.object({
  k8s: z.object({ namespace: z.string().optional(), selector: z.string().optional() }).optional(),
  pid: z.string().optional(),
});

export const ServiceLogsSchema = z.object({
  k8s: z.string().optional(),
  file: z.string().optional(),
});

export const ServiceDescriptorSchema = z.object({
  name: z.string().min(1),
  runtime: z.enum(["jvm", "go", "python"]),
  locate: ServiceLocateSchema.optional(),
  logs: ServiceLogsSchema.optional(),
  repo: RepoRefSchema.optional(),
  diag: z.object({ arthasJar: z.string().optional() }).optional(),
  swap: SwapRecipeSchema.optional(),
});

export const EnvDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  form: z.enum(["k8s", "proprietary"]),
  bastion: BastionSchema,
  escalate: z.array(SuStepSchema).optional(),
  hops: z.array(HopSchema).optional(),
  shellInit: z.string().optional(),
  promptSyncTimeoutMs: z.number().optional(),
  session: SessionPolicySchema.optional(),
  services: z.array(ServiceDescriptorSchema).optional(),
});

/** Type inferred from the schema (must stay assignable to types.ts EnvDescriptor). */
export type ParsedEnvDescriptor = z.infer<typeof EnvDescriptorSchema>;
