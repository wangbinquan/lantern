# Lantern · AI 环境问题定位助手 — 提案 (Proposal)

> 版本: v2 (修订:基于 anomalyco/opencode 1.17.8 实测,改为"不改 opencode 源码"的无侵入架构)
> 日期: 2026-06-19  ·  状态: 待评审

## 1. 背景与问题

商用产品的服务**无法在开发本地运行**,导致用 AI 编码时调试困难——目前能跑的只有单元测试 (UT),而 UT 不足以覆盖所有运行态问题。

服务部署在**网络隔离环境**,运维通道极度受限:

- 只有主节点(堡垒)有大网 IP;只能用**极低权限用户** SSH 登录,登录后需 `su` 切到高权限用户才能操作。
- 跳转到内网节点必须:先 `su` 到具备跳转权限的用户 → 用内网小网 IP `ssh` 跳过去(需指定用户)→ 再 `su` 到高权限用户。
- **环境零端口/零额外服务**:不允许部署其它服务、不允许开端口。唯一通道就是 SSH:连接、用户切换、内网跳转。
- 环境有多种形态:有的用**专有内部运维命令**,有的是 **k8s** (`kubectl`)。

开发当前的日常定位流程是纯手工且重复:拉日志 → 看环境状态 → 本地对着日志读代码找问题 → 找不到就**加日志、本地打包、换包上环境、重跑任务**→ 再定位……动作繁琐、循环冗长。

## 2. 目标与非目标

### 目标
1. 让 AI 能**安全地连接到环境**,获取运行态信息(环境状态、日志,后续含 DB/Redis/Kafka)。
2. AI 能**读取本地/远端代码库**,把运行态信息与代码关联做定界定位。
3. 定位不了时,AI 能**建议加日志 → 构建 → 换包 → 复现**并循环推进,目标是**自主完成问题的定界定位分析**。
4. **复用 opencode** 作为 Agent(不自研框架),把"操作环境的 SSH 能力"接进 opencode。
5. 操作人**实时看到** opencode 在执行什么命令;**每条非只读命令必须人工确认**后才执行。

### 非目标(本期不做)
- **不修改 opencode 源码**(硬约束,需求方确认)。只用其配置 + 内置工具 + 我们自己的外部程序接入。
- 不做生产环境自动修复/自动变更(面向**研发阶段的研发环境问题定位**)。
- 不自研 Agent/LLM/权限框架。
- 首期不接 DB/Redis/Kafka(见 §6)。
- 不做重型合规审计链(研发环境,姿态从轻)。

## 3. 核心思路(无侵入)

一句话:**把 SSH 能力做成我们自己的本地程序 `lantern`,让 opencode 通过它自带的 bash 工具来调用 `lantern`;靠 opencode 在 v2 里 bash 工具本就经权限网关这一点,白捡"实时可见 + 逐条确认"。**

为什么是这条路(关键实测结论,见 design.md §2):
- opencode 1.17.8 的 `opencode serve`/TUI/SDK 都跑在新的 **v2 运行时**。**v2 目前不吃任何外部工具注入**:`.opencode/tool/*.ts` 磁盘工具、插件 hook(`tool.execute.before`)、MCP 都**只在旧的 v1 路径有效,v2 看不到**。要在 v2 里加"受权限网关管控的自定义工具"**唯一办法是改 core 源码**——而这被排除了。
- 但 **opencode 的内置 bash 工具在 v2 里本就 self-assert**(`packages/core/src/tool/bash.ts`:`action:"bash", resources:[命令原文]`)。所以只要让 Agent **通过 bash 调用我们的 `lantern` 程序**,每次调用就自动经 v2 权限网关:发 `permission.v2.asked` → 在 TUI/app 弹审批、命令原文实时可见。**无需碰 opencode 源码,两条硬需求即满足。**

三个支柱:

1. **opencode(原封不动)= 大脑 + 门禁 + 可见性**:Agent 工具调用循环、阻塞式 v2 权限网关(`permissions` 配置 allow/ask/deny)、TUI/app 现成的命令流 + 审批 UI、原生 `read/grep` 读代码。
2. **`lantern` 程序(我们自己写)= 手脚**:`lanternd` 守护进程持有一条长存多跳/su PTY 会话(`ssh2`),数据驱动走"登录 → 提权 → 跳转 → 提权";`lantern` CLI 是瘦客户端,被 opencode 的 bash 调用。读/改分类、脱敏、诊断、换包都在这里。
3. **在线诊断优先,重打包换包兜底**:JVM 用 Arthas(`watch/trace/redefine`,batch 不开端口)、Go 用 `dlv`/`bpftrace`、Python 用 `py-spy`,免去绝大多数循环。

## 4. 业界调研结论(借鉴来源)

| 项目 | 借鉴点 |
|---|---|
| **opencode** (anomalyco/opencode, MIT, npm `opencode-ai`, 文档 opencode.ai) | 复用主体(**不改源码**):Agent 循环、v2 阻塞式权限网关、`serve`+SSE+SDK、现成 TUI/app 审批 UI、原生 `read/grep`。注:anomalyco = 原 SST 团队 2026 年品牌统一后的组织名,opencode 主线本身。 |
| **HolmesGPT** (Robusta+MS, CNCF) | RCA 循环(假设→取证→收敛);声明式工具集 YAML → 我们的"环境命令目录";读/改安全分级。 |
| **kagent** (Solo.io, CNCF) | 只读即跑 / 改动需审批的拆分;拒绝理由回灌 LLM。 |
| **Claude Code 权限模型** | 只读 vs 改动分类器蓝图:只读白名单;复合命令拆段每段都需安全;灾难命令熔断。说明"对命令串前缀匹配不可靠"——故关键分类放在 `lanternd` 内部。 |
| **fuzzylabs/sre-agent** | 唯一显式"读源码仓库 + 关联运行态"的 agent。 |
| **ssh2 / pxssh / ssh-mcp-sessions** | 持久 PTY + 逐命令 UUID 标记(`__DONE_<uuid>__$?`)拿边界与退出码;`su` 后重置 PS1 → 标记法比 PS1 正则可靠。 |
| **Arthas** (Alibaba) | 最高杠杆:运行态 `watch/trace/stack/tt/jad/redefine`,batch 模式走普通 SSH,不开端口;**禁用 `tunnel-server`**(会起端口)。 |
| **SWE-agent / OpenHands / Self-Debugging** | 给 LLM 高层命令而非裸 shell(我们用 `lantern` 子命令);先建立可复现信号再修;预算与停止条件(典型 ~3、上限 ~10,首次复现即停)。 |

## 5. 关键决策与权衡(已与需求方确认)

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| 1 | 服务运行时 | **多语言混合** | 在线诊断探针按运行时分流;描述符带 `runtime` |
| 2 | 登录/跳转认证 | **全程静态密码,无 MFA;内网跳转需指定跳板用户** | 可全自动 expect;跳转须先 `su` 到指定用户 |
| 3 | 在线诊断策略 | **允许在线观测 + 允许热替换类** | 在线诊断优先;Arthas `redefine` 可用;重打包退为兜底 |
| 4 | 审批粒度 | **逐条确认;复现回路可选"限时会话批准"** | 只读自动跑;改动逐条 ask |
| 5 | 凭据/治理 | **研发环境;环境注册表存库,明文密码 OK;每次选一套环境** | 不引入 Vault;重心改为"别打错环境 + 模型上下文不回显密码" |
| 6 | 存储接入 | **首期不接 DB/Redis/Kafka,先做 日志 + 在线诊断** | MVP 范围收敛 |
| 7 | 节点工具 | **可传二进制上节点,但只能命令行用,起 server 外部连不上** | Arthas 必走 batch;缺失 CLI 可上传;严禁起服务/端口 |
| 8 | 审批运维模式 | **单操作员;SSE 流 + HTTP 回复;无人时 agent 就等** | 直接吃 opencode 原生 TUI |
| 9 | 代码来源 | **混合:部分本地、部分远端 git 拉取** | 描述符按服务填 `repo.local` 或 `repo.git` |
| 10 | 构建换包 | **部分语言本地可产出制品(如 jar)、部分需 CI/特定环境** | `swapRecipe` 支持 `auto`/`ci`/`manual` |
| **11** | **opencode 集成方式** | **不改 opencode 源码** | v2 无法无侵入加"受网关管控的自定义工具" → 改走 **lantern CLI + opencode 内置 bash 工具 + `permissions` 配置** |

## 6. 范围与分期

### MVP (Phase 1) — 日志 + 在线诊断,跑通"连接→取证→定位"
- 环境注册表 + 环境描述符 schema。
- `lanternd` 守护进程(多跳/su PTY、逐命令标记、重连、脱敏)+ `lantern` CLI(瘦客户端)。
- `lantern` 子命令:`logs/state/observe`(只读),`exec/redefine/put/swap/restart`(改动),`env`(选环境)。
- opencode 配置:`.opencode/opencode.json`(v2 `permissions` 加固 ruleset:放行只读 `lantern` 子命令、ask 改动、deny shell 串联与危险命令)+ `env-debugger` agent + AGENTS.md。
- 可见性与审批:**直接用 opencode TUI**(命令流 + 审批 UI 现成)。
- 在线诊断先打通 JVM(Arthas batch),再扩 Go/Python。
- 代码关联:本地仓库(opencode 原生 `read/grep`)。

### Phase 2 — 自主复现 + 存储 + 自定义控制台
- 存储工具集(DB/Redis/Kafka **CLI-over-SSH**,只读护栏)作为新的 `lantern` 子命令。
- 远端 git 拉取;服务↔仓库映射完善。
- 复现回路状态机(预算/停止条件)+ 按语言的 `swapRecipe` 自动化。
- 若需 Web/多人:**复用 `packages/app`**(SolidJS,SSE + 审批 dock 现成),外加鉴权/审计层,而非从零自建。

### Phase 0 — Day-1 验证(动手前)
在本地 1.17.8 上核实 bash 网关行为与 `lantern`-over-bash 链路(详见 plan.md)。

## 7. 主要风险与缓解(摘要)

- **bash 命令串门禁可被串联绕过**(`lantern logs x && rm -rf /`):用 **deny-wins** 规则挡掉 `; & | $( \`` 等 shell 元字符,逼所有环境交互走结构化 `lantern` 调用;关键读/改分类在 `lanternd` 内部再做一层。
- **`su` 必须 PTY**:唯一可行模型是持久 PTY 脚本化(`lanternd` 持有),无捷径。
- **裸 PTY 解析脆弱**:逐命令 UUID 标记 + 去 ANSI + `stty -echo` + 每跳后重同步。
- **依赖 opencode v2(实验中 + 日更)**:HTTP/SSE/权限契约相对稳;锁定 1.17.8,Day-1 核实事件/端点名;因为我们只依赖"内置 bash 工具 + `permissions` 配置"这一最稳的面,受 v2 churn 影响最小。
- **打错环境**:每次会话显式选定一套环境;审批界面醒目显示目标节点;只读白名单收紧。

## 8. 成功标准

- MVP:在一套真实研发环境上,AI 自主完成"选环境→建链→拉日志/看状态→Arthas 在线观测→结合本地代码给出定界结论",全程 opencode TUI 实时可见、每条改动命令有确认。
- Phase 2:在线诊断够不到时,AI 自主走通"改代码→构建→换包→复现→再定位"且收敛在预算内。
