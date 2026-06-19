/**
 * Faithful local mirror of opencode v2's permission evaluation, used to VALIDATE
 * our `.opencode/opencode.json` ruleset offline (and by a future `lantern doctor`).
 * It is NOT used at runtime by opencode — opencode evaluates its own rules.
 *
 * Semantics (design.md §2.1 / §6, verified against packages/core/src/permission.ts
 * on the pinned 1.17.8 source — re-verify on your build, Phase 0):
 *   - rules are {action, resource, effect: allow|ask|deny}, glob-matched
 *   - DENY WINS: any matching deny rule ⇒ deny
 *   - otherwise the LAST matching allow/ask rule wins (findLast)
 *   - no match ⇒ ask (fail-safe)
 */
import { readFileSync } from "node:fs";

export type Effect = "allow" | "ask" | "deny";

export interface PermRule {
  action: string;
  resource: string;
  effect: Effect;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

function ruleMatches(rule: PermRule, action: string, resource: string): boolean {
  return globToRegExp(rule.action).test(action) && globToRegExp(rule.resource).test(resource);
}

export function evaluatePermission(rules: PermRule[], action: string, resource: string): Effect {
  const matches = rules.filter((r) => ruleMatches(r, action, resource));
  if (matches.some((r) => r.effect === "deny")) return "deny"; // deny wins
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    if (m.effect !== "deny") return m.effect; // findLast among allow/ask
  }
  return "ask"; // fail-safe default
}

export function loadPermissions(jsonPath: string): PermRule[] {
  const cfg = JSON.parse(readFileSync(jsonPath, "utf8")) as { permissions?: PermRule[] };
  return cfg.permissions ?? [];
}
