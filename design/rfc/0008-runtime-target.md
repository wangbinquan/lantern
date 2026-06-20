# RFC-0008: Runtime target (dynamic worker nodes)

- **Status**: Accepted (2026-06-20)
- **Author**: Lantern
- **Builds on**: RFC-0007 (roles)

## 1. Why

In a k8s (or any fleet) environment the worker nodes are **dynamic** — their IPs come
from `kubectl get node -o wide`, not from static config. You want to configure only
the master, let a **skill** discover the worker IPs, and ssh into a chosen worker to
run node-level shell commands (disk, kubelet, /var/log).

RFC-0007 nodes are static (one descriptor entry per machine). That can't express "ssh
to whichever worker the skill just discovered". This RFC adds a **runtime target**:
one node *template* (uniform worker ssh credential) whose address is supplied per
`exec`.

## 2. Model

A node's `to` may contain the placeholder `${target}`; such a node is a **template**.
A role landing on it requires a `target` at exec time, substituted into `to`.

```jsonc
"nodes": {
  "worker": {
    "via": [{ "type":"su", "user":"kube", "secretRef":"prod/worker-via" }], // on the master/jump
    "to":  "${target}",                      // ← filled at exec time
    "sshSecretRef": "prod/worker-ssh",        // one credential for all workers
    "toPattern": "10\\.0\\.0\\.[0-9]+"        // optional: bound which targets are allowed
  }
},
"roles": { "worker-shell": { "at": "worker", "su": [{ "type":"su", "user":"root", "secretRef":"prod/worker-root" }] } }
```

Usage (the skill discovers the IP, then):

```
exec(env="prod-a", role="worker-shell", target="10.0.0.5", command="systemctl status kubelet")
  → login → su kube → ssh 10.0.0.5 → su root → run
```

You configure the **master** + **one worker template** (not each worker). The skill
runs `kubectl get node -o wide` on the master role to get IPs and passes one as `target`.

## 3. Mechanics

- **`resolveChain(env, role, target?)`**: when the role's node `to` contains `${target}`,
  substitute `target` and (a) reject a target with shell metacharacters (host regex),
  (b) reject a target that fails the node's `toPattern` (if set), (c) require `target`.
  If `target` is passed but the role's chain has no template, it's an error (catch typos).
- **`SessionPool` keys `(env, role, target)`** — each worker IP is its own persistent
  session, reused across same-target ops.
- **MCP `exec(env, command, role?, target?)`**: the skill passes `target`. `env_list`
  is unchanged (roles are still static; templating is per-node). The spectator log +
  `lantern monitor` show the target (`env (role → 10.0.0.5) $ …`).

## 4. Security

- `target` is validated against the host regex (no `;`/`|`/`$()` …) AND the node's
  `toPattern` (a CIDR-ish allowlist) before it's shell-quoted into `ssh <target>`. So
  the model can only reach addresses the operator pre-bounded, with a credential that
  only works on the fleet. Still confirmed per-exec by the MCP client.
- The worker ssh password / su passwords remain `secretRef` → keychain, injected at the
  PTY, never in the model. `target` is just an address the skill already discovered.

## 5. Non-goals (v1)

- No partial-template arithmetic beyond `${target}` string substitution (one placeholder).
- Lantern does not discover or cache the node list — that's the skill's `kubectl` call.
- No per-target credentials (the template assumes one uniform worker credential). If a
  fleet needs per-host creds, model them as distinct roles/nodes instead.

## 6. Slices

1. This RFC.
2. Types (`NodeReach.toPattern`) + schema; `resolveChain` target substitution+validation;
   `SessionPool` key+target; MCP `exec` target + log/monitor; wizard templated node. +tests.
