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

/** How to get a shell on a named internal node (RFC-0007): su on the bastion to an
 *  ssh-capable user, then ssh in. Shared by every role that lands on this node. */
export interface NodeReach {
  /** su chain on the bastion to become a user that can ssh to `to`. */
  via?: SuStep[];
  to: string;
  sshSecretRef: string;
  promptRe?: string;
}

/** A per-operation identity (RFC-0007): land on `at` (a node, or the bastion) and su
 *  to the role's user. The skill names the role; the su password stays in the keychain. */
export interface Role {
  /** Node name from `EnvDescriptor.nodes`, or undefined = stay on the bastion. */
  at?: string;
  /** su chain at `at` to reach the role's identity. */
  su?: SuStep[];
}

/** A flattened connection step (resolveChain output) the session engine executes. */
export type ChainStep =
  | { kind: "su"; user: string; secretRef: string; promptRe?: string }
  | { kind: "ssh"; to: string; secretRef: string; promptRe?: string };

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
  /** Named internal nodes reachable from the bastion (defined once, shared by roles). */
  nodes?: Record<string, NodeReach>;
  /** Per-operation identities; at least one. The skill picks which by name. */
  roles: Record<string, Role>;
  shellInit?: string;
  promptSyncTimeoutMs?: number;
  session?: SessionPolicy;
}

/** Resolves a `secretRef` to its plaintext value (registry / keychain / vault). */
export type SecretResolver = (ref: string) => string | Promise<string>;
