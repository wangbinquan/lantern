/**
 * `lantern env init` wizard (RFC-0002 §4.3/§4.4). `runEnvInit` is the flow with
 * injected deps (asker / host-key fetch / RPC send / log) so it is testable
 * without a TTY or daemon; `runEnvInitCli` is the thin production wiring.
 */
import { registryDbPath } from "../paths";
import { KeychainSecretStore, keychainAvailable, Registry } from "../registry";
import type { EnvDescriptor } from "../types";
import {
  buildEnvInitPlan,
  buildNodePlan,
  buildRolePlan,
  type AuthAnswer,
  type EnvInitAnswers,
  type NodeAnswer,
  type RoleAnswer,
  type SuAnswer,
} from "./env-init-plan";
import { fetchHostKeyFingerprint, type HostKeyResult } from "./host-key";
import { ask, type Asker, confirm, makeTtyAsker, v } from "./prompt";

export interface EnvInitOpts {
  insecureHostKey?: boolean;
  noUse?: boolean;
}

export interface EnvInitDeps {
  asker: Asker;
  fetchFingerprint: (host: string, port: number) => HostKeyResult | null;
  /** Persist the assembled env / select it. Production writes the registry directly. */
  send: (
    method: "env.add" | "env.use",
    params: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
  log: (msg: string) => void;
}

function oneOf(vals: string[]): (s: string) => string | null {
  return (s) => (vals.includes(s) ? null : `请输入 ${vals.join("/")} 之一`);
}

/** Collect a `su` chain (empty username stops). */
async function collectSuChain(asker: Asker, firstQuestion: string): Promise<SuAnswer[]> {
  const chain: SuAnswer[] = [];
  for (;;) {
    const q = chain.length === 0 ? `${firstQuestion} (空=不提权)` : "继续 su 到谁? (空=停止)";
    const user = await ask(asker, q, {
      validate: (s) => (s === "" || v.username(s) === null ? null : "invalid username"),
    });
    if (!user) break;
    const password = await ask(asker, `  ${user} 的密码`, { secret: true, validate: v.nonEmpty });
    chain.push({ user, password });
  }
  return chain;
}

/** Prompt for one node's reach (from bastion or another node → su → ssh in). Name is given. */
export async function promptNode(
  asker: Asker,
  name: string,
  nodeNames: string[] = [],
): Promise<NodeAnswer> {
  // which machine do we ssh FROM? bastion, or an already-defined node (multi-hop).
  const fromOpts = ["bastion", ...nodeNames];
  const from =
    fromOpts.length > 1
      ? await ask(asker, `  从哪台到达? [${fromOpts.join("/")}]`, {
          default: "bastion",
          validate: oneOf(fromOpts),
        })
      : "bastion";
  const via = await collectSuChain(asker, `  在 ${from} 上 su 到谁(为了能 ssh 它)?`);
  const to = await ask(asker, "  节点地址 (固定 IP,或 ${target} = 运行时传入)", {
    validate: (s) => (/^[A-Za-z0-9_.:${}-]+$/.test(s) ? null : "invalid host / ${target}"),
  });
  const sshPassword = await ask(asker, "  ssh 该节点的密码", {
    secret: true,
    validate: v.nonEmpty,
  });
  const ans: NodeAnswer = { name, via: via.length ? via : undefined, to, sshPassword };
  if (from !== "bastion") ans.from = from;
  if (to.includes("${target}")) {
    const pat = await ask(asker, "  允许的 target 正则 (可空,如 10\\.0\\.0\\..*)");
    if (pat) ans.toPattern = pat;
  }
  return ans;
}

/** Prompt for one role (where to land + su chain). Name is given; `at` ∈ bastion|nodeNames. */
export async function promptRole(
  asker: Asker,
  name: string,
  nodeNames: string[],
): Promise<RoleAnswer> {
  const at = await ask(asker, `  在哪台机? [${["bastion", ...nodeNames].join("/")}]`, {
    default: "bastion",
    validate: oneOf(["bastion", ...nodeNames]),
  });
  const su = await collectSuChain(asker, `  在 ${at} 上 su 成谁?`);
  return { name, at: at === "bastion" ? undefined : at, su: su.length ? su : undefined };
}

export async function runEnvInit(id: string, opts: EnvInitOpts, deps: EnvInitDeps): Promise<void> {
  const { asker, log } = deps;

  const label = await ask(asker, "环境标签 (可空)");

  // ---- bastion ----
  const host = await ask(asker, "堡垒地址", { validate: v.host });
  const port = Number(await ask(asker, "堡垒端口", { default: "22", validate: v.port }));
  const loginUser = await ask(asker, "登录用户", { validate: v.username });
  const authKind = await ask(asker, "认证方式 [password/key]", {
    default: "password",
    validate: oneOf(["password", "key"]),
  });
  let auth: AuthAnswer;
  if (authKind === "key") {
    const keyPath = await ask(asker, "私钥路径", { validate: v.nonEmpty });
    const passphrase = await ask(asker, "私钥口令 (可空)", { secret: true });
    auth = { kind: "key", keyPath, passphrase: passphrase || undefined };
  } else {
    auth = {
      kind: "password",
      password: await ask(asker, "登录密码", { secret: true, validate: v.nonEmpty }),
    };
  }

  // ---- host key (TOFU) ----
  let hostKeySha256: string | undefined;
  let insecureHostKey: boolean | undefined;
  if (opts.insecureHostKey) {
    insecureHostKey = true;
    log("⚠ 跳过 host key 校验 (--insecure-host-key)");
  } else {
    log(`正在获取 ${host} 的 host key 指纹…`);
    const fp = deps.fetchFingerprint(host, port);
    if (fp) {
      log(`  ${fp.keyType}  ${fp.display}`);
      if (await confirm(asker, "  信任并 pin 这个 host key?", true)) hostKeySha256 = fp.hex;
    } else {
      log("  ✗ 无法自动获取(ssh-keyscan 不可用或主机无响应)");
    }
    if (!hostKeySha256) {
      const manual = await ask(asker, "  手动粘贴 SHA256 指纹 (留空进入 insecure 确认)");
      if (manual) {
        hostKeySha256 = manual;
      } else if (await confirm(asker, "  ⚠ 不校验 host key 有 MITM 风险,确认 insecure?", false)) {
        // require an explicit yes — never go insecure on a blank Enter (Codex H-1)
        insecureHostKey = true;
      } else {
        throw new Error(
          "host key not pinned — re-run with the fingerprint, or pass --insecure-host-key",
        );
      }
    }
  }

  // ---- nodes (how to reach each internal machine; shared by roles) ----
  const nodes: NodeAnswer[] = [];
  if (await confirm(asker, "要配置内网节点吗?", false)) {
    do {
      const name = await ask(asker, "  节点名 (如 app1)", { validate: v.username });
      nodes.push(
        await promptNode(
          asker,
          name,
          nodes.map((n) => n.name),
        ),
      );
    } while (await confirm(asker, "再配一个节点?", false));
  }

  // ---- roles (per-operation identities; at least one) ----
  const nodeNames = nodes.map((n) => n.name);
  const roles: RoleAnswer[] = [];
  do {
    const name = await ask(asker, "角色名 (如 restart / filexfer)", { validate: v.username });
    roles.push(await promptRole(asker, name, nodeNames));
  } while (await confirm(asker, "再加一个角色?", false));

  // ---- assemble + deliver (connection + roles only — business is each skill's job) ----
  const answers: EnvInitAnswers = {
    id,
    label: label || undefined,
    bastion: { host, port, loginUser, auth, hostKeySha256, insecureHostKey },
    nodes: nodes.length ? nodes : undefined,
    roles,
  };
  const plan = buildEnvInitPlan(answers);

  const added = await deps.send("env.add", { env: plan.env, secrets: plan.secrets });
  if (!added.ok) throw new Error(`env.add failed: ${added.error}`);
  if (!opts.noUse) {
    const used = await deps.send("env.use", { id });
    if (!used.ok) throw new Error(`env.use failed: ${used.error}`);
  }

  log(
    `✔ 已保存环境 "${id}"(密钥已入钥匙串,${hostKeySha256 ? "host key 已 pin" : "未校验 host key"})` +
      `${opts.noUse ? "" : ",已设为当前环境"}。`,
  );
  log(`  环境已就绪。opencode 经 MCP 的 exec 工具即可在 "${id}" 上执行命令。`);
}

function openInitRegistry(): Registry {
  const useKeychain = process.env.LANTERN_LOCAL_SHELL !== "1" && keychainAvailable();
  return new Registry(registryDbPath(), useKeychain ? new KeychainSecretStore() : undefined);
}

/** Production wiring: real TTY asker + ssh-keyscan, writing the registry directly (no daemon). */
export async function runEnvInitCli(id: string, opts: EnvInitOpts): Promise<void> {
  const registry = openInitRegistry();
  const tty = makeTtyAsker();
  try {
    await runEnvInit(id, opts, {
      asker: tty.ask,
      fetchFingerprint: (h, p) => fetchHostKeyFingerprint(h, p),
      send: (method, params) => {
        if (method === "env.add") {
          registry.upsertEnv(params.env as EnvDescriptor);
          const secrets = params.secrets as Record<string, string> | undefined;
          if (secrets)
            for (const [ref, val] of Object.entries(secrets)) registry.setSecret(ref, val);
        } else {
          registry.setCurrent(params.id as string);
        }
        return Promise.resolve({ ok: true });
      },
      log: (m) => process.stderr.write(m + "\n"),
    });
  } finally {
    tty.close();
    registry.close();
  }
}

/** `lantern env role add <env> <role>` — add one identity to an existing env (RFC-0007). */
export async function runRoleAddCli(envId: string, name: string): Promise<void> {
  if (!envId || !name) throw new Error("usage: lantern env role add <env> <role>");
  const registry = openInitRegistry();
  const tty = makeTtyAsker();
  try {
    const env = registry.getEnv(envId);
    if (!env) throw new Error(`unknown environment "${envId}"`);
    if (env.roles[name]) throw new Error(`role "${name}" already exists in "${envId}"`);
    const answer = await promptRole(tty.ask, name, Object.keys(env.nodes ?? {}));
    const { role, secrets } = buildRolePlan(envId, answer);
    env.roles[name] = role;
    registry.upsertEnv(env); // re-validates the whole descriptor (e.g. role.at names a node)
    for (const [ref, val] of Object.entries(secrets)) registry.setSecret(ref, val);
    process.stderr.write(
      `✔ 角色 "${name}" 已加入 "${envId}"。exec(env="${envId}", role="${name}", …) 即可用。\n`,
    );
  } finally {
    tty.close();
    registry.close();
  }
}

/** `lantern env node add <env> <node>` — add one reachable node (RFC-0007). */
export async function runNodeAddCli(envId: string, name: string): Promise<void> {
  if (!envId || !name) throw new Error("usage: lantern env node add <env> <node>");
  const registry = openInitRegistry();
  const tty = makeTtyAsker();
  try {
    const env = registry.getEnv(envId);
    if (!env) throw new Error(`unknown environment "${envId}"`);
    if (env.nodes?.[name]) throw new Error(`node "${name}" already exists in "${envId}"`);
    const answer = await promptNode(tty.ask, name, Object.keys(env.nodes ?? {}));
    const { node, secrets } = buildNodePlan(envId, answer);
    env.nodes = { ...env.nodes, [name]: node };
    registry.upsertEnv(env);
    for (const [ref, val] of Object.entries(secrets)) registry.setSecret(ref, val);
    process.stderr.write(`✔ 节点 "${name}" 已加入 "${envId}"。现在角色可设 at="${name}"。\n`);
  } finally {
    tty.close();
    registry.close();
  }
}
