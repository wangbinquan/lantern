# Lantern · AI 环境问题定位助手 — 详细设计 (Design)

> 版本: v2 (设计修订版次;基于 anomalyco/opencode **1.17.8** 实测源码;已并入 Codex 评审跟进,见 [review-followups.md](./review-followups.md))
> 日期: 2026-06-19  ·  配套: [proposal.md](./proposal.md) · [plan.md](./plan.md)

---

## 0. 关于 opencode 版本与 v1/v2(地基,先读)

- 本设计针对 **opencode 1.17.8**(组织 `anomalyco/opencode`,即原 SST 团队 2026 年品牌统一后的 opencode 主线;MIT;npm 包 `opencode-ai`;文档 https://opencode.ai)。
- opencode 正从旧实现(v1,`packages/opencode/src`)迁移到**事件溯源的 v2 运行时**(`PermissionV2`/`EventV2`/`SessionV2`,`packages/core/src`)。**`opencode serve` 起的是 v2 API server**,TUI/app/SDK 也都连 v2。
- **关键限制**:v2 运行时**不消费任何外部工具注入**——`.opencode/tool/*.ts` 磁盘工具、插件 hook、MCP **都只在 v1 路径有效**(`packages/core/src/session/runner/llm.ts:57` 把 MCP/plugin tools 列为未完成 TODO)。在 v2 里加"受网关管控的自定义工具"唯一办法是改 core 源码。
- 因为**不改源码**是硬约束,本设计**不给 opencode 加工具/插件/MCP**,而是让 Agent 通过 **opencode 内置 bash 工具**调用外部程序 `lantern`——bash 工具在 v2 本就经权限网关,故"实时可见 + 逐条确认"白捡。

> **断言来源声明(回应评审 #9)**:下文所有关于 1.17.8 v2 行为的论断(bash self-assert、`permissions` 扁平 ruleset、deny 优先、`permission.v2.asked`、reply 端点、TUI/app 审批 UI、v2 不吃磁盘工具/插件/MCP、`always` 持久化精确命令串、saved 规则可清空、serve 支持 password、`external_directory` 默认 ask)**均已对本地 1.17.8 源码 clone 逐条核实并附 file:line**。但"在你实际部署/所用的构建上仍成立"被列为 **Phase 0 的硬性前置条件**(plan.md §1),不是普通里程碑——任一假设不成立,"不改源码"路线即需重估。

---

## 1. 总体架构

**一切"推理、门禁、可见性"跑在本机;只有 `lantern` 发起的 SSH 命令触达隔离环境。** opencode 原封不动。

```
  操作台 (MVP: opencode TUI;Phase2: 原样运行/对接 packages/app, 见 §10)
     │  SSE: GET /api/event(命令流 + permission.v2.asked)
     │  HTTP: POST /api/session/:id/permission/:requestID/reply(once|reject)
     ▼
  opencode serve  (v2 API server, 绑 127.0.0.1 + password, 本机, 源码不改)
   ├─ Agent 工具调用循环(假设→取证→收敛)                      ← 复用
   ├─ v2 PermissionV2 网关(bash 工具 self-assert,允许/询问/拒绝) ← 复用
   ├─ 内置 read/grep/glob(读本地/远端代码做关联)               ← 复用
   └─ 内置 bash 工具 ── 执行 `lantern <subcmd> …`(本机执行)
     │                         │  (本地 unix socket)
     │                         ▼
     │                   lanternd 守护进程(我们写) ── 持有长存多跳/su PTY(带 TTL/锁)
     │                         │  ssh2 conn.shell({pty:true}) 数据驱动脚本:
     │                         │  登录(低权) → su 高权 │ su 跳板用户 → ssh 内网IP → su 高权
     │                         ▼
     │                   隔离环境(堡垒 + 内网节点;form = k8s | proprietary;多语言)
     └─ AGENTS.md/agent 约束    └─ 日志(server-side grep|head)/ 在线诊断(Arthas/dlv/py-spy, CLI/batch)
```

凭据(环境注册表,含明文密码)存于 **opencode 工作区之外**,仅 `lanternd` 读取(§11)。

---

## 2. opencode 复用点(1.17.8 v2 实测 + 接入方式)

### 2.1 内置 bash 工具 = 接入点 + "每条非只读命令需确认"
- bash 工具在 v2 **execute 开头自己 assert**:`packages/core/src/tool/bash.ts:143-150`,`action:"bash"`,`resources:[input.command]`(命令原文),`save:[input.command]`(故 `always` 仅记住**那条精确命令串**,见 §11)。
- 权限引擎 `packages/core/src/permission.ts`:`evaluate()` 有序 `findLast` 匹配(glob 通配),**未命中默认 `ask`**;**`deny` 优先**(先判 `denied()`,任一资源命中 deny 即拒,压过 allow);`assert()` 命中 `ask` 时 publish `permission.v2.asked` 并阻塞在 `Deferred` 上直到 reply。
- 因此:**让 Agent 只通过 bash 调用 `lantern …`,每次调用自动经此网关。**

### 2.2 服务化 + SSE + 现成 UI =(可见性 + 审批 UI,不自建)
- `opencode serve` = v2 API server(`packages/cli/src/commands/handlers/serve.ts`),默认 `127.0.0.1:4096`(占用则随机端口),且**支持 password 鉴权**(`commands.ts:21` Spec "Get or set the server password" → `createRoutes(password)`,`serve.ts:19/37`)。**MVP 即绑 loopback + 启用 password**,避免本机其它进程伪造 reply 绕过人工确认(评审 #6)。
- SSE:`GET /api/event`;事件含 `permission.v2.asked`/`replied`、`session.next.shell.started`(带命令原文)、`session.next.tool.called`。⚠️ 事件按 `location` 过滤,客户端需带 directory。
- 审批回复:`POST /api/session/:sessionID/permission/:requestID/reply`,body `{reply:"once"|"always"|"reject", message?}`。
- 已保存规则可查/清:`GET`/`DELETE /api/permission/saved`(`groups/permission.ts:28/40`)——用于 §11 的 `always` 治理。
- **现成客户端**(按 URL 连同一 v2 server,源码不改):`packages/tui`(bash 审批显示 `$ <command>`,`once/always/reject`,`routes/session/permission.tsx`);`packages/app`(Web,`session-permission-dock.tsx` + `message-timeline.tsx`);`packages/desktop`(Electron,内嵌带 Basic Auth 的 serve)。
- SDK:`@opencode-ai/sdk/v2`,`createOpencodeClient()`;`client.v2.event.subscribe()`、`client.v2.session.permission.reply()`、`client.v2.session.prompt()`。
- **模型/Provider**:opencode `provider` 配为**公司内部 LLM 网关**(OpenAI/Anthropic 兼容端点,`baseURL` + `key`/header),在 `opencode.json` 配置。

### 2.3 不复用的
- ❌ 自定义磁盘工具 / 插件 hook / MCP(只对 v1 有效,v2 serve/TUI 看不到)。SSH 能力放外部 `lantern`,经 bash 接入。
- `console`/`enterprise`/`identity` 是 anomalyco 云产品/资产,本地不适用。

---

## 3. 环境注册表与环境描述符

每次定位**先选一套环境**(`lantern env use <id>`,该操作为 `ask`,见 §6)。注册表存为**本地 SQLite**(位于 `~/.lantern/`,**opencode 工作区之外**),明文密码于研发环境可接受;`lanternd` 读取并在发送时刻注入 PTY、所有输出脱敏为 `***`。

```yaml
env:
  id: "env-A-dev"
  label: "订单域-研发环境A"
  form: "k8s"                 # k8s | proprietary
  bastion: { host: "1.2.3.4", port: 22, loginUser: "low", auth: { type: "password", secretRef: "env-A/low" } }
  escalate:
    - { type: "su", user: "high", secretRef: "env-A/high", promptRe: "[Pp]assword:" }
  hops:
    - to: "10.0.0.12"
      viaUser: "jump"                         # 先 su 到指定跳板用户
      viaSecretRef: "env-A/jump"
      sshSecretRef: "env-A/node12-ssh"
      then: [ { type: "su", user: "high", secretRef: "env-A/high" } ]
  session: { ttlSec: 1800, idleSec: 600 }     # 高权 PTY 生命周期(见 §4.4)
  services:
    - name: "order-svc"
      runtime: "jvm"                          # jvm | go | python
      locate:
        k8s: { namespace: "order", selector: "app=order-svc" }
        pid: "pgrep -f order-svc.jar"
      logs:
        k8s: "kubectl -n order logs -l app=order-svc --tail={{tail}} --since={{since}}"
        file: "/var/log/order/order-svc.log"
      repo: { local: "/Users/.../code/order-svc", git: "ssh://git@.../order-svc.git", ref: "release/3.2" }
      diag: { arthasJar: "/opt/arthas/arthas-boot.jar" }
      swap:
        mode: "auto"                           # auto | ci | manual
        buildCmd: "mvn -q -pl order-svc -am package"
        artifact: "order-svc/target/order-svc.jar"
        putMethod: "base64"                    # base64(默认,主路径)| scp(仅直达跳点可用时, 见 §7)
        remotePath: "/opt/app/order-svc/order-svc.jar"
        restartCmd: "kubectl -n order rollout restart deploy/order-svc"
        healthCmd: "kubectl -n order rollout status deploy/order-svc --timeout=120s"  # 换包后健康检查
        rollback: true                         # 健康检查失败则恢复上一制品并告警(见 §7)
```

---

## 4. lanternd 守护进程(本地,持有 PTY)

> 实现:**TypeScript(Node/Bun)+ `ssh2`**(与 opencode 同生态;`conn.shell({pty:true})` 持有 PTY)。

职责:持有**一条长存 PTY**,数据驱动走完建链,为 `lantern` 子命令提供"在当前 shell 跑一条命令、拿 stdout 与退出码"的可靠原语。本地 unix socket 服务,**不在环境上、不开网络端口**。守护进程化是为了**跨多次 `lantern` 调用复用同一会话**(否则每次 bash 调用都要重走 su/hop 并重输密码)。

### 4.1 为什么必须持久 PTY
`su` 从控制终端读密码——`sshpass`/`ProxyJump -J`/`ssh2.exec()` 都喂不进。唯一可行:`ssh2 conn.shell({pty:true})` 开交互 PTY,按序写 `su - user\n` → 等密码提示 → 写密码 → `ssh 内网IP\n` → …。每次 `su/ssh` 只是再叠一层 shell。

### 4.2 建链算法
`conn.shell({pty:true})` 登录堡垒 → pxssh `sync_original_prompt` 锁定初始提示 → 按 `escalate`/`hops` 写 `su`/`ssh` 并按 `promptRe` 喂密码(脱敏),每步后重同步提示(新 shell 重置 PS1)。

### 4.3 命令边界与退出码
每条命令包裹 `<cmd>; printf '\n__OC_DONE_<uuid>__%d\n' $?\n`,读到唯一标记为止,前为 stdout、后整数为退出码。每命令新 uuid;去 ANSI;`stty -echo`;不信 PS1 正则。

### 4.4 会话生命周期与所有权(评审 #12)
- **TTL + 空闲超时**:每个 env 会话有 `ttlSec`/`idleSec`;到期或空闲自动断开并重置(下次用时重建)。避免残留高权 shell。
- **单拥有者锁**:一个 `env.id` 同时只允许**一个**活动会话(socket 层加锁),防跨任务误操作同一高权 PTY。
- **显式拆链**:`lantern env release` 主动登出并销毁会话;`lanternd` 进程退出兜底清理所有 PTY。
- keepalive + 掉线自动重走全链;命令队列串行化;尊重超时/中断。

### 4.5 对 `lantern` 暴露(本地 socket RPC)
`run(envId, service, op)` —— **注意 `op` 是结构化操作描述,不是自由 shell 串**(§5/§6 by-construction);`connect/ensure/status/release`。`run` 负责标记注入、脱敏、截断、超时。

---

## 5. `lantern` CLI 子命令(opencode 经 bash 调用)

**按可变性 + 侵入性分组**,使 bash `permissions` 模式确定性生效。CLI 用**结构化 flag**,**不透传远端自由 shell**;只读子命令由 `lanternd` 用固定只读模板拼命令(read-only **by construction**)。

| 子命令 | 类别 | 作用 | bash 权限 |
|---|---|---|---|
| `lantern env list` | 控制·只读 | 列出可用环境(不切换) | allow |
| `lantern env use` | 控制·改动 | **切换**目标环境并建链(打错环境后果大) | **ask**(评审 #8) |
| `lantern logs` | 只读(by construction) | 取日志,server-side 过滤+硬上限 | allow |
| `lantern state` | 只读(by construction) | 状态(k8s get/describe/top;专有只读 verb) | allow |
| `lantern snapshot` | 只读·被动一次性(by construction) | jstack / Arthas `jad`·`sc` / py-spy dump 等**不暂停、不长跑**的快照 | allow |
| `lantern observe` | 改动·侵入式 | Arthas `watch/trace/tt`、`dlv attach`、`bpftrace` 等**可加负载/暂停/需高权** | **ask**(评审 #5) |
| `lantern exec` | 改动·自由文本 | 其它远端命令(唯一接受自由 `--cmd` 的入口) | **ask** |
| `lantern redefine` | 改动 | Arthas 单类热替换 | **ask** |
| `lantern put` / `swap` / `restart` | 改动 | 传包 / 换包 / 重启 | **ask** |

要点:
- **只读子命令 read-only by construction**:`logs/state/snapshot` 只接受结构化 flag,`lanternd` 据固定模板生成已知只读命令,**不存在"读子命令里混入改动"的可能**——从根上消除"二层判定为改动却无法回弹审批 UI"的死区(评审 #4)。`lanternd` 二层对这些子命令 **fail-closed**:任何越出模板的请求直接拒绝,提示改用 `ask` 的 `exec`。
- **自由文本只走 `lantern exec --cmd`**,且为 `ask`——人在审批框必看其原文。
- 复杂 grep 正则(可能含 `|`)走 `--grep`/`--grep-b64`(编码)等结构化 flag,由 `lanternd` 服务端执行,**使 bash 串里不出现 shell 元字符**(配合 §6/§8,化解评审 #2/#10)。
- 子命令把**目标环境/节点 + 将执行的远端命令原文**回显到 CLI 输出,使 bash 审批框看到确切动作。

---

## 6. 门禁:真正边界 vs 纵深防御(均不改 opencode 源码)

> **重要更正(评审 #2/#4/#10)**:bash 网关匹配的是**命令原文字符串**,用 deny-glob 枚举 shell 元字符**只能算纵深防御,不是真正边界**——`<(...)` 等构造层出不穷。真正的安全靠下面三条:

**真正边界:**
1. **凭据隔离**:只有 `lanternd` 持有凭据、可达环境;opencode/bash 即便被绕,也碰不到环境(碰到的只是本机)。凭据存工作区外(§11)。
2. **只读子命令 by construction**:自动放行的 `logs/state/snapshot/env list` 不接受自由 shell,`lanternd` 只发已知只读命令。
3. **自由文本必经人审**:唯一自由入口 `lantern exec --cmd` 是 `ask`,人看原文后才执行;`observe`/`redefine`/`put`/`swap`/`restart`/`env use` 同为 `ask`。

**第 1 层闸门 = opencode `permissions` 配置**(`.opencode/opencode.json`,利用 deny 优先 + findLast):

```jsonc
{
  "permissions": [
    { "action": "*",    "resource": "*", "effect": "ask"   },
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "grep", "resource": "*", "effect": "allow" },
    { "action": "glob", "resource": "*", "effect": "allow" },
    { "action": "list", "resource": "*", "effect": "allow" },

    // 外部目录默认 ask;凭据目录显式 deny;代码仓库按需 allow(见 §11)
    { "action": "external_directory", "resource": "*",              "effect": "ask"   },
    { "action": "external_directory", "resource": "<HOME>/.lantern/*", "effect": "deny" },

    { "action": "bash", "resource": "*",                  "effect": "ask"   },
    { "action": "bash", "resource": "lantern env list*",  "effect": "allow" },
    { "action": "bash", "resource": "lantern logs *",     "effect": "allow" },
    { "action": "bash", "resource": "lantern state *",    "effect": "allow" },
    { "action": "bash", "resource": "lantern snapshot *", "effect": "allow" },
    // env use / observe / exec / redefine / put / swap / restart 落入上面的 bash:* => ask

    // 含管道/重定向 => 降级为 ask(置于 allow 之后,findLast 生效;合法复杂过滤用结构化/编码 flag 规避)
    { "action": "bash", "resource": "*|*", "effect": "ask" },
    { "action": "bash", "resource": "*>*", "effect": "ask" },

    // deny-wins 硬拒(纵深防御):命令串联/替换/进程替换/提权/灾难。deny 先判,压过一切 allow。
    { "action": "bash", "resource": "*;*",     "effect": "deny" },
    { "action": "bash", "resource": "*&*",     "effect": "deny" },
    { "action": "bash", "resource": "*`*",     "effect": "deny" },
    { "action": "bash", "resource": "*$(*",    "effect": "deny" },
    { "action": "bash", "resource": "*${*",    "effect": "deny" },
    { "action": "bash", "resource": "*<(*",    "effect": "deny" },
    { "action": "bash", "resource": "*>(*",    "effect": "deny" },
    { "action": "bash", "resource": "*rm -rf*","effect": "deny" },
    { "action": "bash", "resource": "*sudo*",  "effect": "deny" },
    { "action": "bash", "resource": "ssh *",   "effect": "deny" },

    { "action": "edit", "resource": "*", "effect": "ask" },
    { "action": "write","resource": "*", "effect": "ask" }
  ]
}
```
> 说明:`*` glob = `.*`。`lantern logs *` 本会把 `lantern logs x && rm` 也匹配为 allow,但 `&&` 命中 `*&*`→deny、deny 先判,故被拒;含管道/重定向者命中 `*|*`/`*>*`→ask(后于 allow,findLast 生效),落人审。**这些 glob 规则是纵深防御,真正边界是上面三条。** 📝 Phase 0 做绕过测试(plan §1)。

**第 2 层 = `lanternd` 内部分类(纵深防御)**:对 `exec --cmd` 的自由文本再做读/改分类(移植 Claude Code 思路:只读白名单 + kubectl/专有 verb 表 + 灾难拒绝);对只读子命令 fail-closed(越出模板即拒)。专有 CLI 只读 verb 白名单由平台/运维维护,默认未识别即按改动处理。

---

## 7. 在线诊断分层(取代大部分重打包换包)

据 `service.runtime` 选探针(服务部署为**节点裸进程**,探针直接对节点上的 PID `attach`,**无需 `kubectl exec`**)。**全部走 CLI/batch,不开端口/起 server**。

- **被动快照(`lantern snapshot`,allow)**:JVM `jstack`、Arthas `jad`/`sc`/`ognl` 只读、py-spy `dump`——一次性、不暂停、不长跑。
- **侵入式观测(`lantern observe`,ask)**:Arthas `watch/trace/tt/stack -n <N> 超时`(**必带 `-n`+超时**,**禁 `tunnel-server`**)、`dlv attach` 断点、`bpftrace` uprobe(需 root)。这些可加负载/暂停/侵入运行实例,**逐条确认**(评审 #5)。
- **热替换单类(`lantern redefine`,ask)**:Arthas `redefine`(仅方法体)。
- **重打包换包(兜底,ask)**:加日志(可审阅 diff)→ 本地构建(UT 门禁)→ `lantern put` → `lantern swap/restart` → **健康检查 `healthCmd`** → 通过则拉新日志回 RCA;**失败则按 `rollback` 恢复上一制品并告警**(评审 #11)。

**制品传输(评审 #7)**:嵌套 su/多跳下 `scp` 通常**无法**复用 PTY 内 su 权限,故 **`putMethod` 默认 `base64`-over-PTY**(`base64` 编码 → `tee` 落盘 → `base64 -d`,两端 `sha256`,`gzip`+分块);`scp` 仅在存在直达跳点时作为优化。优先 `redefine` 单类而非传整包。

---

## 8. 日志与输出治理(防上下文淹没)

**服务端过滤在 `lanternd` 内做**,使 bash 串不出现管道/重定向:`logs` 接 `--grep`/`--grep-b64`/`--tail`/`--since`/`--limit-bytes`,`lanternd` 在节点上拼 `grep -n … | head -N`、`tail -n N`、`sed`、`zgrep`(这些 shell 操作发生在**远端**、在 `lanternd` 构造的命令里,不出现在本机 bash 串中)。`lanternd.run` 统一字节/行硬截断并标 `truncated`;崩溃用 `kubectl logs -p`。这样既满足服务端过滤,又不与 §6 的元字符规则冲突(评审 #10)。

---

## 9. 代码关联(本地 / 远端)

本地优先(`repo.local` → opencode 原生 `read/grep/glob`);无本地时按 `repo.git`+`ref` 浅克隆到本机缓存再读。若 `repo.local` 在工作区外,需为其路径加 `external_directory: allow`(§6);凭据目录不在此列(deny)。

---

## 10. 操作台与可见性(复用,不自建)(评审 #14)

- **MVP 用 opencode TUI**:`packages/tui` 已实时渲染命令流,对每条 `ask` 弹审批框(bash 显示 `$ lantern exec … --cmd '<远端命令>'`,选 `once/reject`)。零开发即满足"实时可见 + 逐条确认"。serve 绑 loopback + password。
- **Phase2 Web**:"复用 `packages/app`"= **作为独立客户端进程、按 URL 连接所给 v2 server,原样运行 opencode 发布的 app/tui;或我们自建一个薄 SSE 客户端对接其文档化 API**。**均不 vendor、不 fork、不改源码**;多操作员鉴权/审计在该客户端**外侧**加网关层。
- 审批 UX:只读自动跑(仍展示+记录);改动逐条确认;复现回路可选限时会话批准(到期自动收回);审批界面醒目显示**目标环境/节点**防打错。

---

## 11. 安全与脱敏(研发环境姿态)

- **凭据存工作区外 + 不可被模型读到(评审 #3)**:环境注册表(含明文密码)存于 `~/.lantern/`(opencode 工作区之外),仅 `lanternd` 读取;opencode 侧 `external_directory` 对该路径 `deny`(§6)。📝 Phase 0 验证 opencode `read/grep/list` 无法逃出工作区读到该路径;研发环境下若仍可读,属可接受残余风险(明文、研发环境),Phase 2 接 keychain/Vault 接口已预留、可彻底消除而不动调用方。
- **模型上下文绝不出现明文密码**:描述符用 `secretRef`;`lanternd` 在发送时刻注入 PTY,所有流式/日志输出脱敏为 `***`。
- **`always` 治理(评审 #1,纠正旧表述)**:opencode `always` 持久化的是**那条精确命令串**(`bash.ts:146` `save:[input.command]`),误点的影响面仅限"再次运行完全相同的命令";但 opencode **无原生开关**能"禁止对改动命令 always"(除非改源码,已排除)。因此:① AGENTS.md/操作规范明确**改动命令一律选 `once`,绝不选 `always``**;② **默认**每次会话开始清空已保存规则(`DELETE /api/permission/saved`);③ `lanternd` 二层防御仍在。(旧版"always 仅限只读"的表述无法被 opencode 强制,已删除。)
- 轻量审计(非防篡改):`lanternd` 落 JSONL(时间、env/节点、远端命令原文、读/改判定、审批结果、退出码/输出摘要);亦可订阅 opencode SSE 的 `permission.v2.asked/replied` 记"谁批准了"。Phase2 视需要加哈希链/异地。

---

## 12. RCA 主循环与复现回路

主循环复用 opencode 工具调用:Agent 拿到(AGENTS.md/agent 描述的)`lantern` 子命令清单 → 形成假设 → 调只读子命令取证 → 关联本地代码 → 必要时建议侵入式观测/换包。复现回路(Phase2 状态机)先建立可复现信号(本地 UT、环境任务重跑、或一条会命中的 Arthas observe)再改;预算 ~3 典型 / ~10 上限,首次复现即停,不收敛升级人工。opencode 自带 doom-loop 检测,我方再加迭代/超时预算。

---

## 附录 A:opencode 1.17.8 关键锚点(file:line)
- bash self-assert + `save`:`packages/core/src/tool/bash.ts:143-150`(`save:[input.command]` 见 :146)。
- 权限引擎:`packages/core/src/permission.ts`(evaluate/assert/reply,deny 优先,默认 ask);schema `packages/core/src/permission/schema.ts`;默认 `external_directory: ask` 见 `packages/core/src/plugin/agent.ts:108`。
- 配置 `permissions`(扁平 ruleset,追加到每个 agent):`packages/core/src/config.ts:59`、`packages/core/src/config/plugin/agent.ts`。配置文件名 `opencode.json`/`opencode.jsonc`/`config.json`(**v2 不支持 YAML**)。
- 事件/SSE:`packages/core/src/session/event.ts`、`packages/server/src/groups/{event,permission}.ts`;reply 端点 `POST /api/session/:sessionID/permission/:requestID/reply`;saved 规则 `GET`/`DELETE /api/permission/saved`(`groups/permission.ts:28/40`)。
- serve + password:`packages/cli/src/commands/handlers/serve.ts`(127.0.0.1:4096 + `createRoutes(password)`);`commands.ts:21`(password Spec)。
- 现成 UI:`packages/tui/src/routes/session/permission.tsx`、`packages/app/src/pages/session/composer/session-permission-dock.tsx`。
- SDK:`@opencode-ai/sdk/v2`,`packages/sdk/js/src/v2/client.ts`。

## 附录 B:待 day-1 核实(详见 plan.md Phase 0)
bash 工具在 serve/TUI 下确经 `permissions` 网关并发 `permission.v2.asked`;`deny` 优先确压过 `allow`;glob 通配语义与 §6 deny/ask 规则的实际效果(含 `<( >( ${` 等**绕过测试**);未带 password 时本地伪造 reply 的可行性;`read/grep/list` 是否受限于工作区(凭据路径不可达);`always` 持久化精确串、saved 规则可清空;`lantern`-over-bash 端到端;`lanternd` 跨调用复用 PTY 会话 + TTL/锁/release。
