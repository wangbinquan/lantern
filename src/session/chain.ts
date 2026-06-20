/**
 * resolveChain (RFC-0007): flatten an environment + role into the linear su/ssh
 * step list the session engine executes. This is the ONLY place that understands
 * the nodes/roles skeleton; SessionManager just runs the returned ChainStep[].
 */
import type { ChainStep, EnvDescriptor } from "../types";

function suSteps(steps: { user: string; secretRef: string; promptRe?: string }[]): ChainStep[] {
  return steps.map((s) => ({
    kind: "su",
    user: s.user,
    secretRef: s.secretRef,
    promptRe: s.promptRe,
  }));
}

/** The su/ssh chain (after the bastion login) that lands on the role's identity. */
export function resolveChain(env: EnvDescriptor, roleName: string): ChainStep[] {
  const role = env.roles[roleName];
  if (!role) {
    throw new Error(
      `env "${env.id}" has no role "${roleName}" (roles: ${Object.keys(env.roles).join(", ")})`,
    );
  }
  const steps: ChainStep[] = [];
  if (role.at && role.at !== "bastion") {
    const node = env.nodes?.[role.at];
    if (!node) throw new Error(`role "${roleName}" targets unknown node "${role.at}"`);
    steps.push(...suSteps(node.via ?? []));
    steps.push({ kind: "ssh", to: node.to, secretRef: node.sshSecretRef, promptRe: node.promptRe });
  }
  steps.push(...suSteps(role.su ?? []));
  return steps;
}

/** Pick the role to run: explicit name, else the sole role, else require a choice. */
export function resolveRole(env: EnvDescriptor, role?: string): string {
  if (role) return role;
  const names = Object.keys(env.roles);
  if (names.length === 1) return names[0]!;
  throw new Error(`env "${env.id}" has ${names.length} roles (${names.join(", ")}); pass a role`);
}
