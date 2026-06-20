/**
 * resolveChain (RFC-0007 + RFC-0008): flatten an environment + role (+ optional
 * runtime target) into the linear su/ssh step list the session engine executes.
 * The ONLY place that understands the nodes/roles skeleton + `${target}` templating;
 * SessionManager just runs the returned ChainStep[].
 */
import type { ChainStep, EnvDescriptor, NodeReach } from "../types";

const HOST = /^[A-Za-z0-9_.:-]+$/; // a runtime target must be a bare host (no shell metachars)

function suSteps(steps: { user: string; secretRef: string; promptRe?: string }[]): ChainStep[] {
  return steps.map((s) => ({
    kind: "su",
    user: s.user,
    secretRef: s.secretRef,
    promptRe: s.promptRe,
  }));
}

/** Resolve a node's ssh address, substituting `${target}` (RFC-0008) when templated. */
function resolveTo(
  node: NodeReach,
  target: string | undefined,
  roleName: string,
): { to: string; consumed: boolean } {
  if (!node.to.includes("${target}")) return { to: node.to, consumed: false };
  if (!target) throw new Error(`role "${roleName}" needs a target (node address is dynamic)`);
  if (!HOST.test(target)) throw new Error(`invalid target "${target}" (host characters only)`);
  if (node.toPattern && !new RegExp(node.toPattern).test(target)) {
    throw new Error(`target "${target}" is not allowed by toPattern /${node.toPattern}/`);
  }
  return { to: node.to.replaceAll("${target}", target), consumed: true };
}

/** Steps to reach a node from the bastion, recursing through `from` (multi-hop, RFC-0007 §6). */
function nodeChain(
  env: EnvDescriptor,
  nodeName: string,
  target: string | undefined,
  roleName: string,
  seen: Set<string>,
): { steps: ChainStep[]; consumed: boolean } {
  if (seen.has(nodeName)) throw new Error(`node cycle via "${nodeName}"`);
  seen.add(nodeName);
  const node = env.nodes?.[nodeName];
  if (!node) throw new Error(`unknown node "${nodeName}" (referenced by role "${roleName}")`);
  const steps: ChainStep[] = [];
  let consumed = false;
  if (node.from) {
    const parent = nodeChain(env, node.from, target, roleName, seen);
    steps.push(...parent.steps);
    consumed = parent.consumed;
  }
  steps.push(...suSteps(node.via ?? [])); // su on the parent (bastion or `from` node)
  const to = resolveTo(node, target, roleName);
  consumed = consumed || to.consumed;
  steps.push({ kind: "ssh", to: to.to, secretRef: node.sshSecretRef, promptRe: node.promptRe });
  return { steps, consumed };
}

/** The su/ssh chain (after the bastion login) that lands on the role's identity. */
export function resolveChain(env: EnvDescriptor, roleName: string, target?: string): ChainStep[] {
  const role = env.roles[roleName];
  if (!role) {
    throw new Error(
      `env "${env.id}" has no role "${roleName}" (roles: ${Object.keys(env.roles).join(", ")})`,
    );
  }
  const steps: ChainStep[] = [];
  let consumedTarget = false;
  if (role.at && role.at !== "bastion") {
    const reached = nodeChain(env, role.at, target, roleName, new Set());
    steps.push(...reached.steps);
    consumedTarget = reached.consumed;
  }
  steps.push(...suSteps(role.su ?? []));
  if (target && !consumedTarget) throw new Error(`role "${roleName}" takes no target`);
  return steps;
}

/** Pick the role to run: explicit name, else the sole role, else require a choice. */
export function resolveRole(env: EnvDescriptor, role?: string): string {
  if (role) return role;
  const names = Object.keys(env.roles);
  if (names.length === 1) return names[0]!;
  throw new Error(`env "${env.id}" has ${names.length} roles (${names.join(", ")}); pass a role`);
}
