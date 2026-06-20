# RFC-0002: `lantern env init` — 交互式接环境向导

- **Status**: Superseded by RFC-0005 — feature removed (was a business command; now an opencode skill over the `exec` tool)
- **Date**: 2026-06-20
- **Author**: Lantern
- **Relates**: `design.md` §3.1(环境描述符)、RFC-0001、C1(钥匙串)、H1(host-key pin)

## 1. Summary

新增 `lantern env init <id>`:操作员**交互式向导**,问几个问题就把一个环境接上——
多跳/su 链 + 服务。密码**隐藏输入**、直接进 OS 钥匙串(经现有 `env.add` RPC);堡垒
host key 用 `ssh-keyscan` 拉取、操作员确认后 **pin**(TOFU);全程**不把任何密钥写进
描述符文件**。取代手写 JSON。**纯客户端特性,不改 daemon 协议**。

## 2. Motivation

手写环境描述符 JSON 是接环境的最大摩擦(用户反馈"太复杂")。日常定位本就是一句自然
语言;接环境也该只是答几个问题。`env add`(stdin JSON)保留给脚本化;`env init` 是人用的路径。

## 3. Guide-level(UX)

```
$ lantern env init prod-a
环境标签 (可空): A区-订单
形态 [proprietary/k8s] (proprietary):
堡垒地址: 10.1.2.3
堡垒端口 (22):
登录用户: ops
认证方式 [password/key] (password):
登录密码: ****                         # 隐藏输入 → 钥匙串,不落文件
正在获取 10.1.2.3 的 host key 指纹…
  SHA256:Hh3a…9Qk   信任并 pin? [y/N] y
登录后 su 到谁? (空=不提权) approot
  approot 的密码: ****
继续 su 到谁? (空=停止)
要跳内网吗? [y/N] y
  内网地址: 192.168.10.5
  跳板用户 (在堡垒上 su 到): jump   其密码: ****
  ssh 内网的密码: ****
  内网上 su 到谁? (空=不提权) appadmin   其密码: ****
  再跳一个内网节点? [y/N] n
添加服务? [y/N] y
  服务名: order-svc   运行时 [jvm/go/python] (jvm):
  PID 定位命令: pgrep -f order-svc.jar
  日志文件: /app/order/logs/app.log
  再加一个服务? [y/N] n
✔ 已保存环境 "prod-a"(密钥已入钥匙串,host key 已 pin)。已设为当前环境。
  试试:  lantern logs --service order-svc --grep ERROR     # 另开 `lantern watch` 看实时
```

Flags:`--insecure-host-key`(跳过 TOFU)、`--no-use`(接好后不设为当前)。

## 4. Reference-level

### 4.1 纯装配器(核心,可测)

```ts
buildEnvInitPlan(answers: EnvInitAnswers): { env: EnvDescriptor; secrets: Record<string, string> }
```

`EnvInitAnswers` 携带**明文密码字段**;装配器为每个密码生成 secretRef、把密码塞进 `secrets`
map、组装出通过 `EnvDescriptorSchema` 的 descriptor。secretRef 命名方案:

| 密钥 | ref |
|---|---|
| 堡垒登录密码 | `<id>/bastion` |
| 堡垒密钥口令 | `<id>/bastion-key` |
| 堡垒第 i 个 su | `<id>/bastion-su<i>` |
| hop j 的跳板(su)密码 | `<id>/hop<j>-via` |
| hop j 的 ssh 密码 | `<id>/hop<j>-ssh` |
| hop j 第 i 个 su | `<id>/hop<j>-su<i>` |

不变量(测试断言):`EnvDescriptorSchema.parse(plan.env)` 必过;`Object.keys(secrets)` 恰好等于
descriptor 里出现的所有 `secretRef` 集合。id/host/user 用 schema 同款正则校验,非法即抛
(交互层捕获后重问)。

### 4.2 host key(TOFU)

```ts
fetchHostKeyFingerprint(host: string, port: number, run?): string | null
```

`ssh-keyscan -p <port> <host>` 管道 `ssh-keygen -lf -` → 取 `SHA256:…` 段。`run` 注入(默认
`Bun.spawnSync`)以便测试。向导展示指纹 → 操作员 `y/N` → pin 进 `bastion.hostKeySha256`;
拉取失败或拒绝 → 让操作员手动粘贴指纹,或 `--insecure-host-key`(显式)。

### 4.3 交互层(薄)

`prompt(q,{default?,validate?})` / `promptSecret(q)`(raw mode 关回显、读到回车) /
`confirm(q)`。问句一律走 **stderr**(stdout 留空)。流程:基本信息 → 堡垒(host/port/user/
auth/hostkey)→ 堡垒 su 链(循环)→ hop(循环,每个含 via/ssh/su 链)→ 服务(循环)→
复述确认 → `env.add` → 可选 `env.use`。

### 4.4 交付

复用现有 **`env.add` RPC**(`{env, secrets}` → lanternd → 钥匙串/C1)。**不新增 daemon 方法**。
随后可选 `env.use <id>`。argparse 增 `{ kind: "init"; id; opts }`,`lantern.ts` 特例化运行向导。

## 5. Security considerations

- 密码隐藏输入、**绝不回显**、**绝不写进描述符文件**;仅经 0600 + 令牌 socket 送达 lanternd
  → 钥匙串(C1)。向导进程自身不持久化任何明文。
- host key 由操作员**确认后**才 pin(TOFU,非静默信任);`--insecure-host-key` 必须显式给。
- descriptor 落库由 lanternd 负责,只含 `secretRef`(引用名),不含值。

## 6. Drawbacks / Alternatives

- 配置文件模板(否决:仍是手编辑 + 易把密码写进文件)。
- 全屏 TUI 表单(v1 过度;先做线性问答)。

## 7. Testing

- 装配器单测:堡垒-only、堡垒+su 链、+hop+su 链、+多服务、k8s 形态;secretRef 命名 + 唯一性;
  非法 id/host/user 抛错;`EnvDescriptorSchema.parse(plan.env)` 通过;`secrets` 键集 == 描述符
  secretRef 集。
- 指纹解析单测:注入假 `ssh-keyscan`/`ssh-keygen` 输出 → 解析 SHA256;失败/无输出 → null。
- 交互层薄,以脚本化 smoke 验证(非 TTY 时降级或提示)。

## 8. Implementation slices(小步提交,每步过 CI)

1. `buildEnvInitPlan` + `EnvInitAnswers` 类型 + 单测。
2. `fetchHostKeyFingerprint`(ssh-keyscan,注入 run)+ 单测。
3. `prompt`/`promptSecret`/`confirm` TTY 助手(隐藏输入)。
4. `lantern env init` 流程 + argparse(`kind:"init"`)+ HELP + 交付(env.add/env.use)接线。
5. 文档(README/AGENTS、RFC→Implemented)+ 脚本化 smoke。

## 9. Unresolved questions(已定稿)

- 多 hop 深度:实现为循环(0..N),大多数 0–1。
- k8s 服务问句:proprietary 问 pid/log;k8s 问 namespace/selector/logs 模板。均已实现。
- 对已存在的 env 重跑 `init`:当前直接覆盖(`env.add` upsert);覆盖前确认留后续。

## 10. Implementation notes

- **指纹编码**:`ssh-keyscan`/`ssh-keygen -l` 给的是 `SHA256:<base64>`,而 ssh2 的
  `hostHash:"sha256"` 给 **hex**。自动路径直接 pin hex;`normalizeFingerprint` 增强为可把
  base64 转 hex,故操作员**手动粘贴熟悉的 `SHA256:base64`** 也能与 hex 验证器匹配。已加测试。
- **pipe 安全的 asker**:Bun readline 在紧凑 `question()` 循环 + 管道输入下会丢行;非 TTY 时
  改为一次性读完 stdin、按行分发(`makePipedAsker`),交互 TTY 仍用 readline + 隐藏回显。
- **零 daemon 改动**:向导仅复用 `env.add`/`env.use` RPC;密钥经令牌+0600 socket 进钥匙串(C1)。
