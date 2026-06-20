/**
 * Faithful local mirror of opencode v2's permission evaluation, used to VALIDATE
 * our `.opencode/opencode.json` ruleset offline (and by a future `lantern doctor`).
 * It is NOT used at runtime by opencode — opencode evaluates its own rules.
 *
 * Semantics (verified against packages/core/src/permission.ts:102-110 on the
 * pinned 1.17.8 source — `evaluate()` is `findLast` over the ruleset):
 *   - rules are {action, resource, effect: allow|ask|deny}, glob-matched
 *   - the LAST matching rule wins (findLast); default ask if none match
 *   - opencode's denied() also evaluates findLast over the AGENT rules so a
 *     persisted "always" can't override an agent deny; with no saved rules this
 *     reduces to plain findLast. ORDER MATTERS: our config places deny rules LAST
 *     so they take precedence over the earlier allow/ask rules they overlap.
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
  // Pure findLast — the LAST matching rule wins (opencode permission.ts:106).
  return rules.findLast((r) => ruleMatches(r, action, resource))?.effect ?? "ask";
}

export function loadPermissions(jsonPath: string): PermRule[] {
  const cfg = JSON.parse(readFileSync(jsonPath, "utf8")) as { permissions?: PermRule[] };
  return cfg.permissions ?? [];
}
