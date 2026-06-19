# Lantern · AI 环境问题定位助手 — 提案 (Proposal)

> 版本: v2 (设计修订版次:基于 anomalyco/opencode 1.17.8 实测;无侵入架构;已并入 Codex 评审跟进,见 [review-followups.md](./review-followups.md))
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
- **不修改 opencode 源码**(硬约束)。只用其配置 + 内置工具 + 我们自己的外部程序接入。
- 不做生产环境自动修复/自动变更(面向**研发阶段的研发环境问题定位**)。
- 不自研 Agent/LLM/权限框架。
- 首期不接 DB/Redis/Kafka(见 §6)。
- 不做重型合规审计链(研发环境,姿态从轻)。

## 3. 核心思路(无侵入)

一句话:**把 SSH 能力做成本地程序 `lantern`,让 opencode 通过它自带的 bash 工具来调用 `lantern`;靠 opencode 在 v2 里 bash 工具本就经权限网关这一点,白捡"实时可见 + 逐条确认"。**

为什么是这条路(关键实测结论,见 design.md §0/§2):
- opencode 1.17.8 的 `opencode serve`/TUI/SDK 都跑在新的 **v2 运行时**;v2 **不吃**磁盘工具/插件 hook/MCP(只 v1 有效)。要在 v2 加"受网关管控的自定义工具"**唯一办法是改 core 源码**——已被排除。
- 但 **opencode 内置 bash 工具在 v2 本就 self-assert**;让 Agent **经 bash 调用 `lantern`**,每次调用自动经 v2 权限网关 → `permission.v2.asked` → TUI/app 弹审批、命令原文可见。**两条硬需求,零改源码。**

三个支柱:
1. **opencode(原封不动)= 大脑 + 门禁 + 可见性**:Agent 循环、阻塞式 v2 权限网关、TUI/app 现成审批 UI、原生 `read/grep`。
2. **`lantern` 程序(我们写)= 手脚**:`lanternd` 守护进程持有长存多跳/su PTY,数据驱动建链;`lantern` CLI 瘦客户端被 bash 调用。读/改分类、脱敏、诊断、换包都在这里。
3. **在线诊断优先,重打包换包兜底**:被动快照免确认、侵入式观测/热替换/换包逐条确认。

## 4. 业界调研结论(借鉴来源)

| 项目 | 借鉴点 |
|---|---|
| **opencode** (anomalyco/opencode, MIT, npm `opencode-ai`, 文档 opencode.ai) | 复用主体(**不改源码**):Agent 循环、v2 阻塞式权限网关、`serve`+SSE+SDK(支持 password)、现成 TUI/app 审批 UI、原生 `read/grep`。anomalyco = 原 SST 团队品牌统一后的组织名,opencode 主线本身。 |
| **HolmesGPT** (CNCF) | RCA 循环;声明式工具集 → 我们的环境命令目录;读/改分级。 |
| **kagent** (CNCF) | 只读即跑 / 改动需审批;拒绝理由回灌 LLM。 |
| **Claude Code 权限模型** | 只读 vs 改动分类器蓝图;"对命令串前缀匹配不可靠"——故关键分类放 `lanternd` 内部,只读子命令做成 by-construction。 |
| **fuzzylabs/sre-agent** | "读源码仓库 + 关联运行态"。 |
| **ssh2 / pxssh / ssh-mcp-sessions** | 持久 PTY + 逐命令 UUID 标记拿边界/退出码;`su` 后重置 PS1。 |
| **Arthas** (Alibaba) | 运行态 `watch/trace/jad/redefine`,batch 走普通 SSH 不开端口;**禁 `tunnel-server`**;区分被动快照 vs 侵入式。 |
| **SWE-agent / OpenHands / Self-Debugging** | 给 LLM 高层命令(`lantern` 子命令);先建立可复现信号再修;预算/停止条件(~3 典型、~10 上限)。 |

## 5. 关键决策与权衡(已与需求方确认)

| # | 决策点 | 结论 | 影响 |
|---|---|---|---|
| 1 | 服务运行时 | **多语言混合** | 探针按运行时分流 |
| 2 | 登录/跳转认证 | **全程静态密码,无 MFA;内网跳转需指定跳板用户** | 可全自动 expect;跳转先 `su` 到指定用户 |
| 3 | 在线诊断策略 | **允许在线观测 + 允许热替换类** | 被动快照免确认;侵入式观测/redefine 逐条确认 |
| 4 | 审批粒度 | **逐条确认;复现回路可选限时会话批准** | 只读自动跑;改动逐条 ask |
| 5 | 凭据/治理 | **研发环境;环境注册表存库(工作区之外),明文密码 OK;每次选一套环境** | 不引入 Vault;凭据路径对 opencode 不可读;模型上下文不回显密码 |
| 6 | 存储接入 | **首期不接 DB/Redis/Kafka,先做 日志 + 在线诊断** | MVP 范围收敛 |
| 7 | 节点工具 | **可传二进制上节点,但只能命令行用,起 server 外部连不上** | Arthas 必走 batch;严禁起服务/端口 |
| 8 | 审批运维模式 | **单操作员;SSE 流 + HTTP 回复;无人时 agent 就等** | 直接吃 opencode 原生 TUI(绑 loopback + password) |
| 9 | 代码来源 | **混合:部分本地、部分远端 git 拉取** | 描述符按服务填 `repo.local`/`repo.git` |
| 10 | 构建换包 | **部分语言本地可产出制品、部分需 CI/特定环境** | `swapRecipe` 支持 `auto`/`ci`/`manual` + 健康检查/回滚 |
| 11 | opencode 集成方式 | **不改 opencode 源码** | 改走 lantern CLI + 内置 bash 工具 + `permissions` 配置 |
| 12 | lanternd/CLI 实现 | **TypeScript(Node/Bun + ssh2)** | 与 opencode 同生态;`ssh2 conn.shell({pty})` 持有 PTY |
| 13 | 注册表存储 | **本地 SQLite(`~/.lantern/`,工作区外)** | 零额外服务;凭据不入 opencode 工作区 |
| 14 | 诊断 attach 形态 | **节点裸进程,直接对 PID attach** | Arthas/py-spy/dlv 走节点 shell,**不需 `kubectl exec`** |
| 15 | LLM 来源 | **公司内部 LLM 网关/代理** | opencode provider 配 baseURL+key(OpenAI/Anthropic 兼容) |

## 6. 范围与分期

### MVP (Phase 1) — 日志 + 在线诊断,跑通"连接→取证→定位"
- 环境注册表(工作区之外)+ 环境描述符 schema。
- `lanternd` 守护进程(多跳/su PTY、逐命令标记、重连、脱敏、TTL/锁)+ `lantern` CLI(瘦客户端)。
- `lantern` 子命令:`env list`/`logs`/`state`/`snapshot`(只读,by construction,allow);`env use`/`observe`/`exec`/`redefine`/`put`/`swap`/`restart`(改动/侵入,ask)。
- opencode 配置:`.opencode/opencode.json`(v2 `permissions` 加固 ruleset:放行只读 `lantern` 子命令、ask 改动/侵入、deny 命令串联/替换/灾难、凭据路径 `external_directory:deny`)+ `env-debugger` agent + AGENTS.md。
- 可见性与审批:**直接用 opencode TUI**(命令流 + 审批 UI 现成);serve **绑 127.0.0.1 + 启用 password**。
- 在线诊断先打通 JVM(Arthas batch),再扩 Go/Python。
- 代码关联:本地仓库(opencode 原生 `read/grep`)。

### Phase 2 — 自主复现 + 存储 + Web 控制台
- 存储工具集(DB/Redis/Kafka **CLI-over-SSH**,只读护栏)作为新的 `lantern` 子命令(经同一 bash ask 网关)。
- 远端 git 拉取;服务↔仓库映射完善。
- 复现回路状态机(预算/停止条件)+ 按语言的 `swapRecipe` 自动化(含健康检查/回滚)。
- 若需 Web/多人:**原样运行/对接 opencode 的 `app`(独立客户端,按 URL 连 v2 server,不 vendor/不 fork)**,在其外侧加鉴权/审计网关。

### Phase 0 — Day-1 验证(动手前)
在本地 1.17.8 上核实 bash 网关阻塞、deny 优先、绕过测试、凭据不可读、PTY 会话复用等(详见 plan.md §1)——作为"不改源码"架构的**硬性前置条件**。

## 7. 主要风险与缓解(摘要,详见 [review-followups.md](./review-followups.md))

- **bash 命令串门禁本质是字符串匹配,deny-glob 只是纵深防御,非真正边界**(`<(...)` 等构造无穷)。真正边界三条:① 仅 `lanternd` 持凭据可达环境;② 只读子命令 read-only **by construction**(结构化 flag + 固定模板,不透传自由 shell);③ 自由文本只走 `ask` 的 `lantern exec`,人必看。deny-wins 挡 `; & \` $( ${ <( >( rm -rf sudo ssh`,管道/重定向降级为 ask。Phase 0 做绕过测试。
- **凭据被模型读取**:注册表存工作区外,`external_directory:deny`;Phase 0 验证 `read/grep` 不可逃逸;Phase 2 接 keychain/Vault 彻底消除。
- **`always` 无法被 opencode 限定为只读**:`always` 持久化的是精确命令串(影响面有限);靠操作规范"改动只点 once"+ 会话开始清空 saved 规则 + lanternd 二层。
- **在线诊断侵入性**:被动快照(`snapshot`)免确认;侵入式(`observe`:watch/trace/dlv/bpftrace)逐条确认。
- **嵌套 su 下 scp 不可用**:换包默认 base64-over-PTY,scp 仅作直达优化;换包带健康检查 + 失败回滚。
- **高权 PTY 残留**:TTL/空闲超时 + 单拥有者锁 + `env release` 显式拆链。
- **`su` 必须 PTY / 裸 PTY 解析脆弱**:持久 PTY 脚本化(无捷径);UUID 标记 + 去 ANSI + `stty -echo` + 每跳后重同步。
- **依赖 opencode v2(实验中 + 日更)**:只依赖最稳的"bash 工具 + `permissions` + SSE"面;锁定 1.17.8,Day-1 核实。
- **打错环境**:`env use` 为 ask;审批界面醒目显示目标节点。

## 8. 成功标准

- MVP:在一套真实研发环境上,AI 自主完成"选环境→建链→拉日志/看状态→Arthas 被动快照/侵入观测→结合本地代码给出定界结论",全程 opencode TUI 实时可见、每条改动命令有确认。
- Phase 2:在线诊断够不到时,AI 自主走通"改代码→构建→换包(带健康检查/回滚)→复现→再定位"且收敛在预算内。
