# RFC-0007: Per-operation roles (multi-identity environments)

- **Status**: Accepted (2026-06-20)
- **Author**: Lantern

## 1. Why

A real isolated env has **many users per machine**, chosen by **operation**: one user
restarts services, another transfers files, another runs diagnostics — and they may
live on **different machines** (some on the bastion, some on an internal node). The
current descriptor models a single fixed chain ending at **one** identity, so every
`exec` runs as the same user. That can't express "pick the user for this operation."

## 2. Model: skeleton + roles

Identity becomes a **function of the operation**, named a **role**. The connection is
a skeleton (shared login + how to reach each node); a role picks **where to land + as
whom**. The skill that performs an operation passes the role name; only Lantern holds
the role's su password (keychain) and injects it at the PTY.

```jsonc
{
  "id": "prod-a",
  "bastion": { "host": "1.2.3.4", "port": 22, "loginUser": "low",
               "auth": { "type": "password", "secretRef": "prod-a/bastion" },
               "hostKeySha256": "…" },
  "nodes": {                                  // how to reach each machine (defined ONCE)
    "app1": {
      "via": [{ "type":"su", "user":"jump", "secretRef":"prod-a/app1-via" }], // su on bastion to an ssh-capable user
      "to":  "10.0.0.12",
      "sshSecretRef": "prod-a/app1-ssh"
    }
  },
  "roles": {                                  // identities chosen per operation
    "filexfer": { "at": "bastion", "su": [{ "type":"su", "user":"deployuser", "secretRef":"prod-a/role-filexfer" }] },
    "restart":  { "at": "app1",    "su": [{ "type":"su", "user":"svcuser",    "secretRef":"prod-a/role-restart"  }] },
    "diagnose": { "at": "app1",    "su": [{ "type":"su", "user":"appuser",    "secretRef":"prod-a/role-diagnose" }] }
  }
}
```

- `filexfer`: login → su `deployuser` on the bastion (stays on the bastion).
- `restart`/`diagnose`: login → su `jump` → ssh app1 → su the role user (on the node).
- The shared prefix (login + su jump + ssh app1) is written **once** in `nodes.app1`;
  each role's full chain is resolved from skeleton + role.

## 3. Mechanics

- **`resolveChain(env, role) → ChainStep[]`** (pure): flattens skeleton + role into a
  linear list of `{kind:"su"|"ssh", …}` steps. This is the only place that knows about
  nodes/roles; the session engine just executes a flat chain.
- **SessionManager** executes an injected `ChainStep[]` after the bastion login
  (factory) — su/ssh steps with PTY password injection + `whoami` verification, as
  today. It no longer reads `escalate`/`hops`.
- **SessionPool keys on `(env, role)`** — one persistent session per identity, reused
  across same-role operations; a different role switches to its own session.
- **MCP `exec(env, command, role?)`**: the skill passes `role`. If omitted and the env
  has exactly one role, it's used; with several, `role` is required. `env_list` returns
  each env's role names so a skill/operator can discover them.

## 4. Security (unchanged invariants)

Every role's su password is a `secretRef` → OS keychain; injected by the server at the
PTY at the matching prompt; never in the descriptor, never in the model context. The
skill only names a role; it never sees or supplies a password.

## 5. Migration

No production data yet, so this replaces `escalate`/`hops` outright. A former
single-identity env maps to one role (e.g. `default`): its bastion su chain → `role.su`
(at the bastion) or, if it hopped, a `node` + a role `at` that node.

## 6. v1 scope / non-goals

- ~~**One level of nodes** (bastion → internal). Internal→internal chaining (`nodes[].from`)
  is a later extension; not built now.~~ **Done:** `nodes[].from` names a parent node;
  `resolveChain` recurses parent-first (with cycle detection), so `bastion → gateway →
  app → …` chains work. The wizard's "从哪台到达?" prompt picks the parent.
- Roles are named by the **skill** (operation-driven); operators don't memorize them.
- No prefix-sharing optimization at runtime (each role establishes its own chain). A
  session-tree that shares the live prefix is a possible later optimization, not v1.

## 7. Slices (CI green each)

1. This RFC.
2. Types + schema (`nodes`/`roles`/`ChainStep`) + `resolveChain` + registry tests.
3. SessionManager runs an injected chain (extract `sshStep`); session tests.
4. SessionPool keys `(env, role)`; MCP `exec` role param + `env_list` roles; tests.
5. `env init` wizard (bastion → nodes → roles) + plan; docs.
