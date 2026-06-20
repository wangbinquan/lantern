/**
 * `lantern env init` wizard (RFC-0002 §4.3/§4.4). `runEnvInit` is the flow with
 * injected deps (asker / host-key fetch / RPC send / log) so it is testable
 * without a TTY or daemon; `runEnvInitCli` is the thin production wiring.
 */
import { defaultSocketPath, type RpcMethod } from "../daemon";
import type { Runtime } from "../types";
import { rpc } from "./client";
import {
  buildEnvInitPlan,
  type AuthAnswer,
  type EnvInitAnswers,
  type HopAnswer,
  type ServiceAnswer,
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
  send: (
    method: Extract<RpcMethod, "env.add" | "env.use">,
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

export async function runEnvInit(id: string, opts: EnvInitOpts, deps: EnvInitDeps): Promise<void> {
  const { asker, log } = deps;

  const label = await ask(asker, "环境标签 (可空)");
  const form = (await ask(asker, "形态 [proprietary/k8s]", {
    default: "proprietary",
    validate: oneOf(["proprietary", "k8s"]),
  })) as "proprietary" | "k8s";

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
      const manual = await ask(asker, "  手动粘贴 SHA256 指纹 (留空=不校验/insecure)");
      if (manual) hostKeySha256 = manual;
      else insecureHostKey = true;
    }
  }

  const escalate = await collectSuChain(asker, "登录后 su 到谁?");

  // ---- hops ----
  const hops: HopAnswer[] = [];
  if (await confirm(asker, "要跳内网吗?", false)) {
    do {
      const to = await ask(asker, "  内网地址", { validate: v.host });
      const viaUser = await ask(asker, "  跳板用户 (在堡垒上 su 到)", { validate: v.username });
      const viaPassword = await ask(asker, `  ${viaUser} 的密码`, {
        secret: true,
        validate: v.nonEmpty,
      });
      const sshPassword = await ask(asker, "  ssh 内网的密码", {
        secret: true,
        validate: v.nonEmpty,
      });
      const hopEsc = await collectSuChain(asker, "  内网上 su 到谁?");
      hops.push({
        to,
        viaUser,
        viaPassword,
        sshPassword,
        escalate: hopEsc.length ? hopEsc : undefined,
      });
    } while (await confirm(asker, "再跳一个内网节点?", false));
  }

  // ---- services ----
  const services: ServiceAnswer[] = [];
  while (await confirm(asker, "添加服务?", services.length === 0)) {
    const name = await ask(asker, "  服务名", { validate: v.nonEmpty });
    const runtime = (await ask(asker, "  运行时 [jvm/go/python]", {
      default: "jvm",
      validate: oneOf(["jvm", "go", "python"]),
    })) as Runtime;
    const svc: ServiceAnswer = { name, runtime };
    if (form === "k8s") {
      const namespace = await ask(asker, "  k8s namespace", { validate: v.nonEmpty });
      const selector = await ask(asker, "  k8s selector (如 app=order)", { validate: v.nonEmpty });
      svc.locate = { k8s: { namespace, selector } };
      const tmpl = await ask(asker, "  日志命令模板 (可空,默认 kubectl logs)");
      if (tmpl) svc.logs = { k8s: tmpl };
    } else {
      svc.locate = {
        pid: await ask(asker, "  PID 定位命令 (如 pgrep -f x.jar)", { validate: v.nonEmpty }),
      };
      const logFile = await ask(asker, "  日志文件路径 (可空)");
      if (logFile) svc.logs = { file: logFile };
    }
    services.push(svc);
  }

  // ---- assemble + deliver ----
  const answers: EnvInitAnswers = {
    id,
    form,
    label: label || undefined,
    bastion: { host, port, loginUser, auth, hostKeySha256, insecureHostKey },
    escalate: escalate.length ? escalate : undefined,
    hops: hops.length ? hops : undefined,
    services: services.length ? services : undefined,
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
  const firstSvc = services[0]?.name;
  if (firstSvc) {
    log(`  试试:lantern logs --service ${firstSvc} --grep ERROR   (另开 \`lantern watch\` 看实时)`);
  }
}

/** Production wiring: real TTY asker + ssh-keyscan + RPC. */
export async function runEnvInitCli(
  id: string,
  opts: EnvInitOpts,
  token: string | undefined,
): Promise<void> {
  const tty = makeTtyAsker();
  try {
    await runEnvInit(id, opts, {
      asker: tty.ask,
      fetchFingerprint: (h, p) => fetchHostKeyFingerprint(h, p),
      send: async (method, params) => {
        const resp = await rpc(defaultSocketPath(), { id: 1, method, params, token }, 120_000);
        return resp.ok ? { ok: true } : { ok: false, error: resp.error };
      },
      log: (m) => process.stderr.write(m + "\n"),
    });
  } finally {
    tty.close();
  }
}
