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

/** A reachable internal node: su chain + ssh in, from the bastion or another node. */
export interface NodeAnswer {
  name: string;
  from?: string;
  via?: SuAnswer[];
  to: string;
  sshPassword: string;
  toPattern?: string;
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
/** Registers a secretRef → value and returns the ref. */
type Ref = (name: string, value: string) => string;

function refInto(envId: string, secrets: Record<string, string>): Ref {
  return (name, value) => {
    const r = `${envId}/${name}`;
    secrets[r] = value;
    return r;
  };
}

function suChainWith(steps: SuAnswer[], prefix: string, ref: Ref): SuStep[] {
  return steps.map((s, i) => ({
    type: "su",
    user: s.user,
    secretRef: ref(`${prefix}${i}`, s.password),
  }));
}

/** Build one role's descriptor entry, registering its su passwords via `ref`. */
export function buildRole(a: RoleAnswer, ref: Ref): Role {
  const role: Role = {};
  if (a.at) role.at = a.at;
  if (a.su && a.su.length > 0) role.su = suChainWith(a.su, `role-${a.name}-su`, ref);
  return role;
}

/** Build one node's reach descriptor, registering its via + ssh passwords via `ref`. */
export function buildNode(a: NodeAnswer, ref: Ref): NodeReach {
  const node: NodeReach = { to: a.to, sshSecretRef: ref(`node-${a.name}-ssh`, a.sshPassword) };
  if (a.from) node.from = a.from;
  if (a.via && a.via.length > 0) node.via = suChainWith(a.via, `node-${a.name}-via`, ref);
  if (a.toPattern) node.toPattern = a.toPattern;
  return node;
}

/** Incremental: a single role + its secrets, for `lantern env role add`. */
export function buildRolePlan(
  envId: string,
  a: RoleAnswer,
): { role: Role; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  return { role: buildRole(a, refInto(envId, secrets)), secrets };
}

/** Incremental: a single node + its secrets, for `lantern env node add`. */
export function buildNodePlan(
  envId: string,
  a: NodeAnswer,
): { node: NodeReach; secrets: Record<string, string> } {
  const secrets: Record<string, string> = {};
  return { node: buildNode(a, refInto(envId, secrets)), secrets };
}

export function buildEnvInitPlan(a: EnvInitAnswers): EnvInitPlan {
  const secrets: Record<string, string> = {};
  const ref = refInto(a.id, secrets);

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
  for (const n of a.nodes ?? []) nodes[n.name] = buildNode(n, ref);

  const roles: Record<string, Role> = {};
  for (const r of a.roles) roles[r.name] = buildRole(r, ref);

  const env: EnvDescriptor = { id: a.id, bastion, roles };
  if (a.label) env.label = a.label;
  if (Object.keys(nodes).length > 0) env.nodes = nodes;

  // Single source of truth for validation (id/host/user regexes + ≥1 role live in the schema).
  const validated = EnvDescriptorSchema.parse(env) as EnvDescriptor;
  return { env: validated, secrets };
}
