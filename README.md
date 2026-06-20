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
- **只读实时镜像 `lantern watch`**(RFC-0001):另开一个终端跑 `lantern watch`,像旁观一场 SSH 会话那样实时看到 lanternd 对环境做的每件事——连接链 / 命令 / 输出 / 退出码 / 拒绝(密码恒 `***`)。对话在 opencode 窗口,信任面在 watch 窗口。
- **一句话接环境 `lantern env init`**(RFC-0002):交互式向导问几个问题(多跳/su 链 + 服务),密码隐藏输入直接进钥匙串,host key 经 `ssh-keyscan` 拉取并由你确认后 pin(TOFU)——取代手写描述符 JSON。
- **换包闭环 `lantern swap`**(RFC-0003):本地构建好的产物经 **base64 流过 PTY** 上传(scp 穿不过 su/hop)→ 备份 → sha256 校验 → 重启 → 健康检查 → **失败自动回滚**;`--dry-run` 先预览、一次确认、watch 窗口看内部每一步。`put`/`restart` 为构件。
- **在线诊断优先**:JVM 用 Arthas(`watch/trace/redefine`,batch 模式不开端口)、Go 用 `dlv`/`bpftrace`、Python 用 `py-spy`,免去绝大多数重打包换包。
- **代码关联**:用 opencode 原生 `read/grep` 把日志/栈跟踪关联到本地或远端代码库做根因分析。

## 现状

🟢 **MVP 已实现**(TypeScript / Bun;**271 tests**,CI 绿)。已落地:多跳/su PTY 会话引擎、读/改命令分类器、SQLite 环境注册表、`lanternd` 守护进程 + `lantern` CLI(unix socket RPC)、OS 钥匙串密钥 + socket 能力令牌 + ssh host-key pin、`lantern env init` 交互式接环境向导(RFC-0002)、`lantern watch` 只读实时镜像(RFC-0001)、`lantern swap` 换包闭环(RFC-0003,base64-over-PTY 上传 + 备份/校验/健康/回滚)、opencode 加固权限配置 + `env-debugger` agent。`connectSsh2`(真实 ssh)需活动 sshd,以受控 e2e 验证;DB/Redis/Kafka 存储、复现回路、Web 控制台属 Phase 2。设计文档:

- [`design/proposal.md`](./design/proposal.md) — 提案:背景、目标、调研借鉴、已确认决策、分期、风险。
- [`design/design.md`](./design/design.md) — 详细设计:架构、环境描述符、lanternd 会话管理、lantern 子命令、bash 门禁、在线诊断分层。
- [`design/plan.md`](./design/plan.md) — 落地计划:Day-1 验证、MVP WBS、扩展、验收、排期。
- [`design/review-followups.md`](./design/review-followups.md) — Codex 评审跟进:问题处置与待决项。
- [`design/rfc/0001-lantern-watch.md`](./design/rfc/0001-lantern-watch.md) — RFC-0001:`lantern watch` 只读实时镜像(已实现)。
- [`design/rfc/0002-lantern-env-init.md`](./design/rfc/0002-lantern-env-init.md) — RFC-0002:`lantern env init` 交互式接环境向导(已实现)。
- [`design/rfc/0003-lantern-swap.md`](./design/rfc/0003-lantern-swap.md) — RFC-0003:`lantern swap` 换包闭环(已实现)。

## 快速开始

```bash
bun install
bun test                                              # 全部测试
bun run typecheck && bun run lint && bun run format:check && bun test   # 同 CI 的门禁

# 零-ssh 本地演示(会话跑在本机的 bash 而非真实环境):
export LANTERN_HOME=$(mktemp -d) LANTERN_LOCAL_SHELL=1
bun src/cli/lanternd.ts &                             # 启守护进程(unix socket)
# 接真实环境推荐交互式向导(问答 + host key 自动 pin): bun src/cli/lantern.ts env init <id>
# 本地演示直接喂 JSON:
echo '{"env":{"id":"local","form":"proprietary","bastion":{"host":"h","loginUser":"me","auth":{"type":"password","secretRef":"x"}},"services":[{"name":"sys","runtime":"jvm","locate":{"pid":"echo 1"}}]}}' \
  | bun src/cli/lantern.ts env add
bun src/cli/lantern.ts env use local
bun src/cli/lantern.ts exec -- echo "hello"           # 只读:直接跑
bun src/cli/lantern.ts exec -- rm -rf /tmp/x          # 灾难命令:被拒

# 两窗口模式:另开一个终端,只读实时镜像环境操作(Ctrl-C 脱离)
bun src/cli/lantern.ts watch                          # 看连接链/命令/输出/拒绝
```

操作员/agent 的完整使用规范见 [`AGENTS.md`](./AGENTS.md);opencode 接入配置在 [`.opencode/`](./.opencode)。

## 代码模块(`src/`)

| 模块 | 职责 |
|---|---|
| `pty/` | 命令标记协议 + expect FSM + spawn 传输 |
| `classify/` | 读 vs 改命令分类器(灾难拒绝) |
| `ssh/` | SessionManager(多跳/su 编排)+ ssh2 真实传输 |
| `registry/` | 环境描述符(zod)+ bun:sqlite 存储 @ `~/.lantern` |
| `daemon/` | RPC dispatch + 会话池 + 只读命令构造 + 审计 + unix socket |
| `cli/` | `lantern` / `lanternd` 入口 + RPC 客户端 + argparse |
| `opencode/` | 权限规则集校验(镜像 opencode v2 语义) |

## 名字由来

调试隔离环境像在黑暗里摸索——Lantern 就是那盏带进去的灯。
