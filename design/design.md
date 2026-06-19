# Lantern · AI 环境问题定位助手 — 详细设计 (Design)

> 版本: v2 (修订:基于 anomalyco/opencode **1.17.8** 实测源码;架构改为"不改 opencode 源码"的无侵入路线)
> 日期: 2026-06-19  ·  配套: [proposal.md](./proposal.md) · [plan.md](./plan.md)
> 所有 opencode 事实均来自对本地 1.17.8 源码 `/Users/wangbinquan/Documents/code/opencode`(= anomalyco/opencode 主线)的核实,并标注 file:line。请在 day-1 对所用构建再次核对。

---

## 0. 关于 opencode 版本与 v1/v2(地基,先读)

- 本设计针对 **opencode 1.17.8**(组织 `anomalyco/opencode`,即原 SST 团队 2026 年品牌统一后的 opencode 主线;MIT;npm 包 `opencode-ai`;文档 https://opencode.ai)。
- opencode 正从旧实现(v1,`packages/opencode/src`)迁移到**事件溯源的 v2 运行时**(`PermissionV2`/`EventV2`/`SessionV2`,`packages/core/src`)。**`opencode serve` 起的是 v2 API server**,TUI/app/SDK 也都连 v2。
- **关键限制**:v2 运行时**不消费任何外部工具注入**——`.opencode/tool/*.ts` 磁盘自定义工具、插件 hook(`tool.execute.before` 等)、MCP server **都只在 v1 路径有效**(`packages/core/src/session/runner/llm.ts:57` 把 "MCP/plugin tools" 列为未完成 TODO)。在 v2 里加"受权限网关管控的自定义工具"**唯一办法是改 core 源码**。
- 因为**不改源码**是硬约束,本设计**不给 opencode 加自定义工具/插件/MCP**,而是让 Agent 通过 **opencode 内置的 bash 工具**调用我们自己的外部程序 `lantern`——bash 工具在 v2 本就经权限网关,故"实时可见 + 逐条确认"白捡。

---

## 1. 总体架构

**一切"推理、门禁、可见性"跑在本机;只有 `lantern` 发起的 SSH 命令触达隔离环境。** opencode 原封不动。

```
  操作台 (MVP: opencode TUI;Phase2: 复用 packages/app Web)
     │  SSE: GET /api/event(命令流 + permission.v2.asked)
     │  HTTP: POST /api/session/:id/permission/:requestID/reply(once|reject)
     ▼
  opencode serve  (v2 API server, 127.0.0.1:4096, 本机, 源码不改)
   ├─ Agent 工具调用循环(假设→取证→收敛)                      ← 复用
   ├─ v2 PermissionV2 网关(bash 工具 self-assert,允许/询问/拒绝) ← 复用
   ├─ 内置 read/grep/glob(读本地/远端代码做关联)               ← 复用
   └─ 内置 bash 工具 ── 执行 `lantern <subcmd> …`(本机执行)
     │                         │  (本地 unix socket)
     │                         ▼
     │                   lanternd 守护进程(我们写) ── 持有长存多跳/su PTY
     │                         │  ssh2 conn.shell({pty:true}) 数据驱动脚本:
     │                         │  登录(低权) → su 高权 │ su 跳板用户 → ssh 内网IP → su 高权
     │                         ▼
     │                   隔离环境(堡垒 + 内网节点;form = k8s | proprietary;多语言)
     │                         ├─ 日志:kubectl logs / 磁盘日志(server-side grep|head)
     └─ AGENTS.md/agent 约束    └─ 在线诊断:Arthas(JVM)/ dlv·bpftrace(Go)/ py-spy(Python),CLI/batch 不开端口
```

数据流:Agent 决定取证 → 发起 `bash("lantern logs --env A --service order-svc --tail 200")` → opencode v2 bash 工具 `permission.assert` → 命中只读 allow 规则则直接跑(仍在 TUI 显示);命中改动则 `permission.v2.asked` 阻塞、TUI 弹审批,操作员 `once/reject` → bash 真正执行 `lantern …` → `lantern` 经 unix socket 让 `lanternd` 在长存 PTY 上跑远端命令 → 输出回到 Agent。

---

## 2. opencode 复用点(1.17.8 v2 实测 + 接入方式)

### 2.1 内置 bash 工具 = 我们的接入点与"每条非只读命令需确认"
- bash 工具在 v2 **execute 开头自己 assert**:`packages/core/src/tool/bash.ts:143-150`,`action:"bash"`,`resources:[input.command]`(**命令原文**),`save:[input.command]`。
- 权限引擎 `packages/core/src/permission.ts`:`evaluate()` 有序 `findLast` 匹配 `action`+`resource`(glob 通配),**未命中默认 `ask`**;**`deny` 优先**(任一资源命中 deny 即拒,压过 allow);`assert()` 命中 `ask` 时 publish `permission.v2.asked` 并阻塞在 `Deferred` 上,直到 reply(`once`/`always`/`reject`;`always` 落库持久化)。
- 因此:**让 Agent 只通过 bash 调用 `lantern …`,每次调用就自动经此网关。** 我们用 `permissions` 配置把只读 `lantern` 子命令设 `allow`、改动设 `ask`、shell 串联/危险命令设 `deny`(§6)。

### 2.2 服务化 + SSE + 现成 UI = "实时可见 + 审批 UI"(不用自建)
- `opencode serve` = v2 API server(`packages/cli/src/commands/commands.ts:27` 描述 "Start the v2 API server";`handlers/serve.ts`),默认 `127.0.0.1:4096`(被占用则随机端口)。
- SSE:`GET /api/event`(`packages/server/src/groups/event.ts`);事件含 `permission.v2.asked`/`permission.v2.replied`(`permission.ts:75`)、`session.next.shell.started`(**带命令原文**,`session/event.ts:150`)、`session.next.tool.called`。⚠️ 事件按 `location`(directory+workspace)过滤,客户端需带 directory。
- 审批回复:`POST /api/session/:sessionID/permission/:requestID/reply`,body `{reply:"once"|"always"|"reject", message?}`(`packages/server/src/groups/permission.ts:67`)。
- **现成客户端**(都是按 URL 连同一个 v2 server,源码不改即可用):
  - `packages/tui`(TS+SolidJS):已实现 bash 审批弹窗,显示 `$ <command>`,选项 `once/always/reject`(`packages/tui/src/routes/session/permission.tsx`)。**MVP 操作台直接用它。**
  - `packages/app`(SolidJS Web):`session-permission-dock.tsx` 审批面板 + `message-timeline.tsx` 命令流,经 SDK + SSE。**Phase2 Web 控制台直接复用它。**
  - `packages/desktop`(Electron):内嵌带 Basic Auth 的本地 serve(sidecar)+ 复用 app UI。
- SDK:`@opencode-ai/sdk/v2`,`createOpencodeClient()`;`client.v2.event.subscribe()`、`client.v2.session.permission.reply()`、`client.v2.session.prompt()`(Phase2 自建/集成时用)。

### 2.3 不复用的(因不改源码 / v2 未支持)
- ❌ 自定义磁盘工具 `.opencode/tool/*.ts`、插件 hook `tool.execute.before`、MCP server —— 这些只对 v1 有效,**v2 serve/TUI 看不到**。故 Lantern **不走**这条;SSH 能力放在外部 `lantern` 程序里,经 bash 接入。
- `console`/`enterprise`/`identity` 是 anomalyco 的云产品/资产,本地不适用。
- 加固策略可放心建立在 v2 权限引擎的 **deny-wins** 语义上(`permission.ts` 中 `denied()` 先判、用户 `always` 只能加 `allow` 不能覆盖 deny)。

---

## 3. 环境注册表与环境描述符

每次问题定位**先选一套环境**(`lantern env use <id>`)。环境信息存库(研发环境,明文密码可接受),数据驱动 `lanternd` 建链、探针选择、日志定位。

```yaml
env:
  id: "env-A-dev"
  label: "订单域-研发环境A"
  form: "k8s"                 # k8s | proprietary
  bastion:
    host: "1.2.3.4"
    port: 22
    loginUser: "low"
    auth: { type: "password", secretRef: "env-A/low" }   # 值不进模型上下文
  escalate:                   # 主节点提权(按序)
    - { type: "su", user: "high", secretRef: "env-A/high", promptRe: "[Pp]assword:" }
  hops:                       # 跳内网节点(可多段;每段可再提权)
    - to: "10.0.0.12"
      viaUser: "jump"                         # 先 su 到指定跳板用户(本环境要求)
      viaSecretRef: "env-A/jump"
      sshSecretRef: "env-A/node12-ssh"
      then:
        - { type: "su", user: "high", secretRef: "env-A/high" }
  shellInit: "export LANG=C; stty -echo 2>/dev/null || true"
  promptSyncTimeoutMs: 12000
  services:
    - name: "order-svc"
      runtime: "jvm"                          # jvm | go | python
      locate:
        k8s: { namespace: "order", selector: "app=order-svc" }
        pid: "pgrep -f order-svc.jar"
      logs:
        k8s: "kubectl -n order logs -l app=order-svc --tail={{tail}} --since={{since}}"
        file: "/var/log/order/order-svc.log"
      repo:
        local: "/Users/wangbinquan/Documents/code/order-svc"
        git: "ssh://git@.../order-svc.git"
        ref: "release/3.2"
      diag: { arthasJar: "/opt/arthas/arthas-boot.jar" }   # 不存在则 lantern put 上传
      swap:
        mode: "auto"                           # auto | ci | manual
        buildCmd: "mvn -q -pl order-svc -am package"
        artifact: "order-svc/target/order-svc.jar"
        putMethod: "scp"                       # scp | base64
        remotePath: "/opt/app/order-svc/order-svc.jar"
        restartCmd: "kubectl -n order rollout restart deploy/order-svc"
```

要点:建链完全数据化(`bastion/escalate/hops`,全密码、无 MFA、可全自动);`form` + 服务 `locate/logs` 决定 `kubectl` 还是磁盘文件/专有命令;`runtime` 决定探针;密码用 `secretRef`,真实值由 `lanternd` 在发送时刻注入 PTY、在所有输出里脱敏成 `***`。

---

## 4. lanternd 守护进程(本地,持有 PTY)

职责:持有**一条长存 PTY**,数据驱动走完建链,为 `lantern` 子命令提供"在当前 shell 跑一条命令、拿 stdout 与退出码"的可靠原语。本地 unix socket 服务,**不在环境上、不开网络端口**,完全合规"环境零服务"。守护进程化是为了**跨多次 `lantern` 调用复用同一条已建好的会话**(否则每次 bash 调用都要重走 su/hop 并重输密码)。

### 4.1 为什么必须持久 PTY
`su` 从**控制终端**读密码——`sshpass`/`ProxyJump -J`/`ssh2.exec()` 都喂不进。唯一可行:`ssh2 conn.shell({pty:true})` 开一条交互式 PTY,像人一样按序写 `su - user\n` → 等密码提示 → 写密码 → `ssh 内网IP\n` → …。每次 `su/ssh` 只是再叠一层 shell。

### 4.2 建链算法
1. `conn.shell({pty:true})` 以低权用户登录堡垒。
2. 初始提示同步(pxssh `sync_original_prompt`:连按两次回车比较锁定提示)。
3. 按序走 `escalate`/`hops`:写 `su - <user>\n`(或 `ssh <ip>\n`)→ 读到 `promptRe` 密码提示 → 写密码(脱敏)→ 每步后重同步提示(新 shell 重置 PS1)。

### 4.3 命令边界与退出码
每条命令包裹:`<cmd>; printf '\n__OC_DONE_<uuid>__%d\n' $?\n`,读到唯一标记为止,前为 stdout、后整数为退出码。新 uuid/命令;去 ANSI;`stty -echo`;不信 PS1 正则。

### 4.4 健壮性
keepalive + 掉线自动重走全链;命令队列串行化;尊重超时;每个 env 一条会话,会话池按 `env.id` 管理。

### 4.5 对 `lantern` CLI 暴露(本地 socket RPC)
`run(envId, service, cmd, {timeoutMs, readOnly})` → `{stdout, exitCode, truncated}`;`connect/ensure/status`。所有子命令最终落到 `run`,由 `run` 负责标记注入、脱敏、截断、超时。

---

## 5. `lantern` CLI 子命令(opencode 经 bash 调用)

**子命令按可变性分组,使 bash `permissions` 模式确定性生效**。CLI 用**结构化 flag**(不直接透传远端 shell),所有复杂度在 `lanternd`。

| 子命令 | 类别 | 作用 | 关键 flag | bash 权限 |
|---|---|---|---|---|
| `lantern env use/list` | 控制 | 选定/列出环境并建链 | `--env` | allow |
| `lantern logs` | 只读 | 取服务日志(server-side 过滤+硬上限) | `--env --service --grep --tail --since --limit-bytes` | allow |
| `lantern state` | 只读 | 环境/服务状态(k8s get/describe/top;专有只读 verb) | `--env --service` | allow |
| `lantern observe` | 只读 | 在线观测 | `--env --service --kind watch/trace/stack/dump --target` | allow |
| `lantern exec` | 改动 | 其它命令(默认归改动) | `--env --service --cmd …` | **ask** |
| `lantern redefine` | 改动 | Arthas 单类热替换 | `--env --service --class --classfile` | **ask** |
| `lantern put` | 改动 | 传包/二进制上节点 | `--env --local --remote --method` | **ask** |
| `lantern swap` / `restart` | 改动 | 换包/重启 | `--env --service` | **ask** |

要点:只读子命令内置护栏(`logs` 强制上限;`state` 只允许只读 verb;`observe` 强制 Arthas `-n`+超时);`exec` 是"逃生舱",默认 ask,且 `lanternd` 内部对其 `--cmd` 再过一遍读/改分类(§6 层 2);所有子命令把**目标环境/节点 + 将执行的远端命令原文**回显在 CLI 输出,使 bash 审批框看到确切动作;输出统一治理防淹没(§8)。

---

## 6. 只读 vs 改动 的门禁(两层,均不改 opencode 源码)

**第 1 层(真正边界)= opencode 内置 bash 工具的 v2 `permissions` 配置。** 放进 `.opencode/opencode.json`。利用 `deny` 优先 + `findLast` 后者覆盖:

```jsonc
{
  "permissions": [
    { "action": "*",    "resource": "*", "effect": "ask"   },
    { "action": "read", "resource": "*", "effect": "allow" },
    { "action": "grep", "resource": "*", "effect": "allow" },
    { "action": "glob", "resource": "*", "effect": "allow" },
    { "action": "list", "resource": "*", "effect": "allow" },

    { "action": "bash", "resource": "*",                "effect": "ask"   },
    { "action": "bash", "resource": "lantern env *",    "effect": "allow" },
    { "action": "bash", "resource": "lantern logs *",   "effect": "allow" },
    { "action": "bash", "resource": "lantern state *",  "effect": "allow" },
    { "action": "bash", "resource": "lantern observe *","effect": "allow" },
    { "action": "bash", "resource": "lantern exec *",   "effect": "ask"   },
    { "action": "bash", "resource": "lantern redefine *","effect": "ask"  },
    { "action": "bash", "resource": "lantern put *",    "effect": "ask"   },
    { "action": "bash", "resource": "lantern swap *",   "effect": "ask"   },
    { "action": "bash", "resource": "lantern restart *","effect": "ask"   },

    // —— deny-wins 安全网(先判 deny,压过上面的 allow):
    // 挡掉 shell 串联/替换/重定向,逼所有环境交互走单条结构化 lantern 调用
    { "action": "bash", "resource": "*;*",   "effect": "deny" },
    { "action": "bash", "resource": "*&*",   "effect": "deny" },
    { "action": "bash", "resource": "*|*",   "effect": "deny" },
    { "action": "bash", "resource": "*`*",   "effect": "deny" },
    { "action": "bash", "resource": "*$(*",  "effect": "deny" },
    { "action": "bash", "resource": "*>*",   "effect": "deny" },
    { "action": "bash", "resource": "rm -rf*","effect": "deny" },
    { "action": "bash", "resource": "*sudo*","effect": "deny" },
    { "action": "bash", "resource": "ssh *", "effect": "deny" },   // 禁止绕过 lantern 直连

    { "action": "edit", "resource": "*", "effect": "ask" },
    { "action": "write","resource": "*", "effect": "ask" }
  ]
}
```
> 说明:`*` glob = `.*`,故 `lantern logs *` 本会把 `lantern logs x && rm -rf /` 也匹配为 allow——但 **deny 优先**的串联/元字符规则会先把它拒掉,从而堵住该绕过。代价:`lantern` 的 flag 值不要带这些 shell 元字符(用结构化 flag / 文件 / base64 传递特殊内容)。`always` 仅对只读放行(它会跨重启持久化)。

**第 2 层(纵深防御)= `lanternd` 内部分类器。** 即便 bash 放行了某条 `lantern` 调用,`lanternd` 仍对实际要在远端执行的命令做读/改分类(移植 Claude Code 思路:只读白名单 + kubectl/专有 verb 表 + 灾难命令拒绝),并且 `lantern` CLI 结构化解析 argv(不透传远端 shell),把"分类边界"握在自己手里——这是真正决定"读 vs 改"的地方,bash 配置只是审批闸门。专有 CLI 的只读 verb 白名单由平台/运维维护,默认未识别即按改动处理。

---

## 7. 在线诊断分层(取代大部分重打包换包)

据 `service.runtime` 选探针。**全部走 CLI/batch,不开端口/起 server**(节点可传二进制,但起 server 外部连不上)。

- **Tier-0 在线只读观测(默认)**:JVM/Arthas batch `java -jar arthas-boot.jar <PID> -c 'watch <Class> <method> "{params,returnObj,throwExp}" -n 3 -x 2; stop'`(`watch/trace/tt/stack` **必须 `-n`+超时**否则不退;**禁 `tunnel-server`**);`jad` 确认线上真实字节码;Go 用 `dlv attach`/`bpftrace` uprobe(需 root,已有 su 高权;锁内核/非特权容器可能不行);Python 用 `py-spy dump/record`。经 `lantern observe`。
- **Tier-1 热替换单类**:JVM Arthas `redefine`(仅方法体)。本地编出单 `.class` → `lantern put` → `lantern redefine`。
- **Tier-2 重打包换包(兜底)**:加日志(可审阅 diff)→ 本地构建(UT 门禁)→ `lantern put` → `lantern swap/restart` → 拉新日志 → 回只读 RCA。每步改动均经 ask;复现段可选限时会话批准。

换包配方 `swapRecipe`:`auto`(本地产出制品如 jar,全自动)/`ci`(改代码+触发 CI,产物就绪后换)/`manual`。制品传输优先 `scp`(经同跳链),不可用则 base64-over-PTY(`tee`+sed 切片,两端 sha256,gzip+分块);优先 `redefine` 单类而非传整包。

---

## 8. 日志与输出治理(防上下文淹没)

尽量在节点侧过滤聚合,只带回相关切片:`--tail/--since/--limit-bytes`,文件 `grep -n | head -N`、`tail -n N`、`sed -n 'A,Bp'`、`zgrep`;预聚合 `grep -c`/`wc -l`/`sort|uniq -c`;`lanternd.run` 统一字节/行硬截断并标 `truncated`;崩溃用 `kubectl logs -p`。

---

## 9. 代码关联(本地 / 远端)

本地优先(`repo.local` → opencode 原生 `read/grep/glob` 直接读);无本地时按 `repo.git`+`ref` 浅克隆到本机缓存再读。服务↔仓库映射在描述符维护。

---

## 10. 操作台与可见性(复用,不自建)

- **MVP 用 opencode TUI**:`packages/tui` 已实时渲染命令流,对每条 `ask` 弹审批框(bash 显示 `$ lantern exec … --cmd '<远端命令>'`,选 `once/reject`)。零开发即满足"实时可见 + 逐条确认"。
- **Phase2 复用 `packages/app`**(SolidJS Web):SDK + `GET /api/event` SSE + `session-permission-dock` 审批 + `message-timeline` 命令流都现成;只需在其外加多操作员鉴权/审计层。
- 审批 UX:只读自动跑(仍展示+记录);改动逐条确认;复现回路可选限时会话批准(到期自动收回);审批界面醒目显示**目标环境/节点**防打错。

---

## 11. 安全与脱敏(研发环境姿态)

- **模型上下文绝不出现明文密码**:描述符用 `secretRef`;`lanternd` 在发送时刻把密码写入 PTY,并在所有流式/日志输出里脱敏为 `***`。MVP 凭据存环境注册表库(明文可接受);接口预留,Phase2 可换钥匙串/Vault 而不动调用方。
- **写操作不沉淀越权**:`always` 仅限只读;改动逐条确认。
- 轻量审计(非防篡改):`lanternd` 落 JSONL(时间、env/节点、远端命令原文、读/改判定、审批结果、退出码/输出摘要);亦可订阅 opencode SSE 的 `permission.v2.asked/replied` 记"谁批准了"。Phase2 视需要加哈希链/异地。

---

## 12. RCA 主循环与复现回路

主循环复用 opencode 工具调用:Agent 拿到(由 AGENTS.md/agent 描述的)`lantern` 子命令清单 → 形成假设 → 调只读子命令取证 → 关联本地代码 → 必要时建议在线诊断/换包。复现回路(Phase2 状态机)先建立可复现信号(本地 UT、环境任务重跑、或一条会命中的 Arthas observe)再改;预算 ~3 典型 / ~10 上限,首次复现即停,不收敛升级人工。opencode 自带 doom-loop 检测,我方再加迭代/超时预算。

---

## 附录 A:opencode 1.17.8 关键锚点(file:line)
- bash self-assert:`packages/core/src/tool/bash.ts:143-150`。
- 权限引擎:`packages/core/src/permission.ts`(evaluate/assert/reply,deny 优先,默认 ask);schema `packages/core/src/permission/schema.ts`。
- 配置 `permissions`(扁平 ruleset,追加到每个 agent):`packages/core/src/config.ts:59`、`packages/core/src/config/plugin/agent.ts`。配置文件名 `opencode.json`/`opencode.jsonc`/`config.json`(**v2 不支持 YAML**)。
- 事件/SSE:`packages/core/src/session/event.ts`、`packages/server/src/groups/{event,permission}.ts`;reply 端点 `POST /api/session/:sessionID/permission/:requestID/reply`。
- 现成 UI:`packages/tui/src/routes/session/permission.tsx`、`packages/app/src/pages/session/composer/session-permission-dock.tsx`。
- SDK:`@opencode-ai/sdk/v2`,`packages/sdk/js/src/v2/client.ts`。
- serve:`packages/cli/src/commands/handlers/serve.ts`(v2 API server,127.0.0.1:4096)。

## 附录 B:待 day-1 核实(详见 plan.md Phase 0)
bash 工具在 serve/TUI 下确实经 `permissions` 网关并发 `permission.v2.asked`;`deny` 优先确实压过 `allow`;glob 通配语义(`*`=`.*`)与上述串联 deny 规则的实际效果;`lantern`-over-bash 端到端链路;`lanternd` 跨多次 `lantern` 调用复用同一 PTY 会话。
