# Lantern 🏮

> 把一盏灯带进不透明的隔离环境里照问题。

**Lantern** 是一个面向**研发阶段、网络隔离环境**的 AI 问题定位助手。

商用产品的服务常常**无法在开发本地运行**,而环境又部署在**网络隔离**里——只有堡垒节点有大网 IP,只能用极低权限用户 SSH 登录,需 `su` 提权、还要 `su` 到跳板用户再 `ssh` 跳进内网节点,且**不允许部署任何额外服务、不允许开端口**。日常定位只能反复手工"拉日志 → 看状态 → 读代码 → 加日志重打包换包重跑"。

Lantern 通过这条**唯一的 SSH 通道**安全地连进环境,实时取证(日志/状态,后续含 DB/Redis/Kafka),结合本地或远端代码库自主完成问题的**定界定位**;在线诊断够不到时,可在人工逐条确认下走"加日志 → 构建 → 换包 → 复现"回路。

## 架构一句话

**不改 opencode 源码**:把 SSH 能力做成本地程序 `lantern`(守护进程持有长存多跳/su PTY 会话),让 [opencode](https://github.com/anomalyco/opencode) 通过它**自带的 bash 工具**来调用 `lantern …`。因为 opencode 的 bash 工具在 v2 里本就经权限网关,所以"操作员实时可见每条命令 + 每条非只读命令需确认"两条需求,靠 opencode 原生能力即可满足。

## 核心特性

- **复用 opencode 作为 Agent**(零侵入,仅通过其配置与内置 bash 工具接入,不碰源码)。opencode 由 Anomaly(原 SST 团队)维护,MIT,npm 包 `opencode-ai`,文档 https://opencode.ai。
- **持久化多跳 / `su` PTY 会话**:`lanternd` 像人一样脚本化走"登录 → 提权 → 跳转 → 提权"(全密码、可全自动),解决 `su` 必须 PTY 喂密码的难题。
- **人在环路**:操作员**实时可见**每条命令(opencode TUI/app 的命令流);**每条非只读命令需人工确认**(opencode 阻塞式 v2 权限网关 + `permissions` 配置)。
- **在线诊断优先**:JVM 用 Arthas(`watch/trace/redefine`,batch 模式不开端口)、Go 用 `dlv`/`bpftrace`、Python 用 `py-spy`,免去绝大多数重打包换包。
- **代码关联**:用 opencode 原生 `read/grep` 把日志/栈跟踪关联到本地或远端代码库做根因分析。

## 现状

📐 **设计阶段 (v1)**,尚无代码实现。完整方案见:

- [`design/proposal.md`](./design/proposal.md) — 提案:背景、目标、调研借鉴、已确认决策、分期、风险。
- [`design/design.md`](./design/design.md) — 详细设计:架构、环境描述符、lanternd 会话管理、lantern 子命令、bash 门禁、在线诊断分层。
- [`design/plan.md`](./design/plan.md) — 落地计划:Day-1 验证、MVP WBS、扩展、验收、排期。

## 名字由来

调试隔离环境像在黑暗里摸索——Lantern 就是那盏带进去的灯。
