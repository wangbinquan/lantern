/**
 * Pure assembler for `lantern env init` (RFC-0002 §4.1). Turns the operator's
 * answers (which carry PLAINTEXT passwords) into an EnvDescriptor + a secrets map
 * keyed by generated secretRefs. The descriptor holds only refs; the plaintext
 * lives in `secrets` and is delivered to lanternd via the env.add RPC (→ keychain).
 *
 * Pure + schema-validated so it is fully unit-tested; the interactive shell
 * (env-init.ts) only collects answers and ships the plan.
 */
import { EnvDescriptorSchema } from "../registry";
import type { Bastion, BastionAuth, EnvDescriptor, Hop, SuStep } from "../types";

export interface SuAnswer {
  user: string;
  password: string;
}

export type AuthAnswer =
  | { kind: "password"; password: string }
  | { kind: "key"; keyPath: string; passphrase?: string };

export interface BastionAnswer {
  host: string;
  port?: number;
  loginUser: string;
  auth: AuthAnswer;
  hostKeySha256?: string;
  insecureHostKey?: boolean;
}

export interface HopAnswer {
  to: string;
  viaUser: string;
  viaPassword: string;
  sshPassword: string;
  escalate?: SuAnswer[];
}

export interface EnvInitAnswers {
  id: string;
  label?: string;
  bastion: BastionAnswer;
  /** su chain on the bastion (after login). */
  escalate?: SuAnswer[];
  hops?: HopAnswer[];
}

export interface EnvInitPlan {
  env: EnvDescriptor;
  secrets: Record<string, string>;
}

/**
 * Assemble a validated descriptor + secrets map from wizard answers. Throws (with
 * the schema's message) if any field is invalid — e.g. a username/host carrying
 * shell metacharacters (Codex H2). secretRef scheme is documented in RFC-0002.
 */
export function buildEnvInitPlan(a: EnvInitAnswers): EnvInitPlan {
  const secrets: Record<string, string> = {};
  const ref = (name: string, value: string): string => {
    const r = `${a.id}/${name}`;
    secrets[r] = value;
    return r;
  };

  let auth: BastionAuth;
  if (a.bastion.auth.kind === "password") {
    auth = { type: "password", secretRef: ref("bastion", a.bastion.auth.password) };
  } else {
    auth = { type: "key", keyPath: a.bastion.auth.keyPath };
    if (a.bastion.auth.passphrase) {
      auth.secretRef = ref("bastion-key", a.bastion.auth.passphrase);
    }
  }

  const bastion: Bastion = { host: a.bastion.host, loginUser: a.bastion.loginUser, auth };
  if (a.bastion.port !== undefined) bastion.port = a.bastion.port;
  if (a.bastion.hostKeySha256) bastion.hostKeySha256 = a.bastion.hostKeySha256;
  if (a.bastion.insecureHostKey) bastion.insecureHostKey = true;

  const escalate: SuStep[] = (a.escalate ?? []).map((s, i) => ({
    type: "su",
    user: s.user,
    secretRef: ref(`bastion-su${i}`, s.password),
  }));

  const hops: Hop[] = (a.hops ?? []).map((h, j) => {
    const hop: Hop = {
      to: h.to,
      viaUser: h.viaUser,
      viaSecretRef: ref(`hop${j}-via`, h.viaPassword),
      sshSecretRef: ref(`hop${j}-ssh`, h.sshPassword),
    };
    if (h.escalate && h.escalate.length > 0) {
      hop.escalate = h.escalate.map((s, i) => ({
        type: "su",
        user: s.user,
        secretRef: ref(`hop${j}-su${i}`, s.password),
      }));
    }
    return hop;
  });

  const env: EnvDescriptor = { id: a.id, bastion };
  if (a.label) env.label = a.label;
  if (escalate.length > 0) env.escalate = escalate;
  if (hops.length > 0) env.hops = hops;

  // Single source of truth for validation (id/host/user regexes live in the schema).
  const validated = EnvDescriptorSchema.parse(env) as EnvDescriptor;
  return { env: validated, secrets };
}
