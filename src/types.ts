/**
 * Environment descriptor types (design.md §3.1). Stored in the registry
 * (bun:sqlite @ ~/.lantern, outside the opencode workspace). Passwords are held
 * as `secretRef` labels; real values are resolved by lanternd at send-time and
 * never enter model-visible text.
 */

export type Runtime = "jvm" | "go" | "python";
export type EnvForm = "k8s" | "proprietary";

/** A single `su - <user>` escalation step. */
export interface SuStep {
  type: "su";
  user: string;
  secretRef: string;
  /** Optional override for the password prompt to expect (regex source). */
  promptRe?: string;
}

/** A hop to an internal node: su to a jump user, ssh to the IP, then escalate. */
export interface Hop {
  to: string;
  viaUser: string;
  viaSecretRef: string;
  sshSecretRef: string;
  /** Escalation steps to run after landing on the internal node. */
  escalate?: SuStep[];
  promptRe?: string;
}

export interface BastionAuth {
  type: "password" | "key";
  secretRef?: string;
  keyPath?: string;
}

export interface Bastion {
  host: string;
  port?: number;
  loginUser: string;
  auth: BastionAuth;
  promptRe?: string;
}

export interface SessionPolicy {
  /** Max session age before a lazy reconnect (seconds). 0/undefined = no TTL. */
  ttlSec?: number;
  /** Idle time before a lazy reconnect (seconds). 0/undefined = no idle cap. */
  idleSec?: number;
}

export interface RepoRef {
  local?: string;
  git?: string;
  ref?: string;
}

export interface SwapRecipe {
  mode: "auto" | "ci" | "manual";
  buildCmd?: string;
  artifact?: string;
  putMethod?: "scp" | "base64";
  remotePath?: string;
  restartCmd?: string;
  healthCmd?: string;
  rollback?: boolean;
}

export interface ServiceLocate {
  k8s?: { namespace?: string; selector?: string };
  pid?: string;
}

export interface ServiceLogs {
  k8s?: string;
  file?: string;
}

export interface ServiceDescriptor {
  name: string;
  runtime: Runtime;
  locate?: ServiceLocate;
  logs?: ServiceLogs;
  repo?: RepoRef;
  diag?: { arthasJar?: string };
  swap?: SwapRecipe;
}

export interface EnvDescriptor {
  id: string;
  label?: string;
  form: EnvForm;
  bastion: Bastion;
  escalate?: SuStep[];
  hops?: Hop[];
  shellInit?: string;
  promptSyncTimeoutMs?: number;
  session?: SessionPolicy;
  services?: ServiceDescriptor[];
}

/** Resolves a `secretRef` to its plaintext value (registry / keychain / vault). */
export type SecretResolver = (ref: string) => string | Promise<string>;
