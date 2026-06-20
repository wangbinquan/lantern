/**
 * Environment CONNECTION descriptor (RFC-0005). Stored in the registry
 * (bun:sqlite @ ~/.lantern, outside the opencode workspace). Describes ONLY how to
 * reach the env over the multi-hop/su chain — no service/logs/swap config (that's
 * each team's skill). Passwords are held as `secretRef` labels; real values are
 * resolved by the MCP server at connect-time and never enter model-visible text.
 */

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
  /** Pinned SHA-256 host-key fingerprint (hex; `SHA256:`/colons tolerated). */
  hostKeySha256?: string;
  /** Opt-in to skip host-key verification (INSECURE — dev only). */
  insecureHostKey?: boolean;
}

export interface SessionPolicy {
  /** Max session age before a lazy reconnect (seconds). 0/undefined = no TTL. */
  ttlSec?: number;
  /** Idle time before a lazy reconnect (seconds). 0/undefined = no idle cap. */
  idleSec?: number;
}

export interface EnvDescriptor {
  id: string;
  label?: string;
  bastion: Bastion;
  escalate?: SuStep[];
  hops?: Hop[];
  shellInit?: string;
  promptSyncTimeoutMs?: number;
  session?: SessionPolicy;
}

/** Resolves a `secretRef` to its plaintext value (registry / keychain / vault). */
export type SecretResolver = (ref: string) => string | Promise<string>;
