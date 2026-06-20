/**
 * Pure assembler for `lantern env init` (RFC-0007). Turns the operator's answers
 * (which carry PLAINTEXT passwords) into an EnvDescriptor (skeleton + roles) + a
 * secrets map keyed by generated secretRefs. The descriptor holds only refs; the
 * plaintext lives in `secrets` and goes to the keychain.
 *
 * Pure + schema-validated so it is fully unit-tested; the interactive shell
 * (env-init.ts) only collects answers and ships the plan.
 */
import { EnvDescriptorSchema } from "../registry";
import type { Bastion, BastionAuth, EnvDescriptor, NodeReach, Role, SuStep } from "../types";

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

/** A reachable internal node: su chain on the bastion + ssh in. */
export interface NodeAnswer {
  name: string;
  via?: SuAnswer[];
  to: string;
  sshPassword: string;
}

/** A per-operation identity: where to land (`at`) + su chain to the role user. */
export interface RoleAnswer {
  name: string;
  at?: string; // node name, or undefined / "bastion" = stay on the bastion
  su?: SuAnswer[];
}

export interface EnvInitAnswers {
  id: string;
  label?: string;
  bastion: BastionAnswer;
  nodes?: NodeAnswer[];
  roles: RoleAnswer[];
}

export interface EnvInitPlan {
  env: EnvDescriptor;
  secrets: Record<string, string>;
}

/**
 * Assemble a validated descriptor + secrets map from wizard answers. Throws (with
 * the schema's message) if any field is invalid — e.g. a username/host carrying
 * shell metacharacters (Codex H2).
 */
export function buildEnvInitPlan(a: EnvInitAnswers): EnvInitPlan {
  const secrets: Record<string, string> = {};
  const ref = (name: string, value: string): string => {
    const r = `${a.id}/${name}`;
    secrets[r] = value;
    return r;
  };
  const suChain = (steps: SuAnswer[], prefix: string): SuStep[] =>
    steps.map((s, i) => ({
      type: "su",
      user: s.user,
      secretRef: ref(`${prefix}${i}`, s.password),
    }));

  let auth: BastionAuth;
  if (a.bastion.auth.kind === "password") {
    auth = { type: "password", secretRef: ref("bastion", a.bastion.auth.password) };
  } else {
    auth = { type: "key", keyPath: a.bastion.auth.keyPath };
    if (a.bastion.auth.passphrase) auth.secretRef = ref("bastion-key", a.bastion.auth.passphrase);
  }

  const bastion: Bastion = { host: a.bastion.host, loginUser: a.bastion.loginUser, auth };
  if (a.bastion.port !== undefined) bastion.port = a.bastion.port;
  if (a.bastion.hostKeySha256) bastion.hostKeySha256 = a.bastion.hostKeySha256;
  if (a.bastion.insecureHostKey) bastion.insecureHostKey = true;

  const nodes: Record<string, NodeReach> = {};
  for (const n of a.nodes ?? []) {
    const node: NodeReach = { to: n.to, sshSecretRef: ref(`node-${n.name}-ssh`, n.sshPassword) };
    if (n.via && n.via.length > 0) node.via = suChain(n.via, `node-${n.name}-via`);
    nodes[n.name] = node;
  }

  const roles: Record<string, Role> = {};
  for (const r of a.roles) {
    const role: Role = {};
    if (r.at) role.at = r.at;
    if (r.su && r.su.length > 0) role.su = suChain(r.su, `role-${r.name}-su`);
    roles[r.name] = role;
  }

  const env: EnvDescriptor = { id: a.id, bastion, roles };
  if (a.label) env.label = a.label;
  if (Object.keys(nodes).length > 0) env.nodes = nodes;

  // Single source of truth for validation (id/host/user regexes + ≥1 role live in the schema).
  const validated = EnvDescriptorSchema.parse(env) as EnvDescriptor;
  return { env: validated, secrets };
}
