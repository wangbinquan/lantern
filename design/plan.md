# Lantern · AI 环境问题定位助手 — 落地计划 (Plan)

> ⚠️ **历史文档(已被取代)**:本文描述早期 CLI/bash 架构。现行架构见 [RFC-0005](./rfc/0005-mcp-server.md) —— Lantern 现在是一个只做"连接+执行"的 stdio MCP server,取日志/诊断/换包等改由各业务的 opencode skill 经 `exec` 工具实现。

> 版本: v2 (设计修订版次;基于 anomalyco/opencode 1.17.8;无侵入架构;已并入 Codex 评审跟进,见 [review-followups.md](./review-followups.md))
> 日期: 2026-06-19  ·  配套: [proposal.md](./proposal.md) · [design.md](./design.md)

---

## 0. 里程碑总览

| 阶段 | 目标 | 退出标准 |
|---|---|---|
| **Phase 0** Day-1 验证 | 核实 bash 网关行为 + 安全假设 + lantern-over-bash 链路 | 验证清单全绿(尤其门禁/绕过/凭据隔离) |
| **Phase 1** MVP | 跑通"选环境→建链→取日志/状态→在线诊断→结合本地代码定界" | 真实环境端到端走通,TUI 实时可见、改动逐条确认 |
| **Phase 2** 自主复现 + 存储 + Web | 自主"改代码→构建→换包(健康/回滚)→复现";接 DB/Redis/Kafka;对接 app 做 Web | 典型问题预算内收敛;存储只读取证可用 |

---

## 1. Phase 0 — Day-1 验证 (动手前,~1-2 天)

"不改源码"架构的**硬性前置条件**(评审 #9):任一项不成立则需重估方案。在本地 **1.17.8** 上核实:

**A. 权限网关与可见性**
1. [ ] `opencode serve` 起得来;`GET /api/event` 订到 `permission.v2.asked` / `session.next.shell.started`(带命令原文)。
2. [ ] **bash 经 `permissions` 网关**:配 `{action:"bash",resource:"echo hi",effect:"ask"}`,确认 `echo hi` 阻塞、弹 ask、reply `once` 后才执行。
3. [ ] **`deny` 优先压过 `allow`**:同时配 `lantern logs *`→allow 与 `*&*`→deny,确认 `lantern logs x && y` 被拒。
4. [ ] reply 端点路径/body(`{reply}`);TUI(`packages/tui`)bash 审批框显示 `$ <command>` 且能 `once/reject`。

**B. 绕过测试(评审 #2/#10,关键)**
5. [ ] 逐一尝试并确认被 deny/ask 拦截:`lantern logs x && rm -rf /`、`; rm`、`` `id` ``、`$(id)`、`${IFS}`、`<(sh -c id)`、`>(cmd)`、`| sh`、`> /etc/x`;确认引号内合法 `--grep 'a|b'` 的处置(应 ask 或经 `--grep-b64` 规避)。把结果回填 design.md §6 的 deny/ask 列表。

**C. 凭据隔离(评审 #3)**
6. [ ] 把假凭据放工作区外(`~/.lantern/`),`external_directory` 对该路径 deny;确认 opencode `read/grep/list` **无法**读到它;确认 `repo.local` 外部路径加 `external_directory:allow` 后可读。

**D. `always` 行为(评审 #1)**
7. [ ] 确认 `always` 持久化的是**精确命令串**(再跑同串免确认,改一字符即重新确认);确认 `DELETE /api/permission/saved` 可清空。

**E. 服务认证(评审 #6)**
8. [ ] 确认 serve 绑 `127.0.0.1` + `password` 生效;未带 password 时本机伪造 reply 的可行性与防护边界。

**F. 链路与会话**
9. [ ] `ssh2 conn.shell({pty:true})` 在 `lanternd` 运行时(Node/Bun,独立于 opencode)可用。
10. [ ] `lanternd` 跨多次 `lantern` 调用**复用同一 PTY 会话**;TTL/空闲超时/`release` 生效(评审 #12)。
11. [ ] opencode `provider` 指向**内部 LLM 网关**(baseURL+key)可完成一次工具调用循环(发起 prompt → 调 bash → 收结果)。

**产出**:一页《1.17.8 网关行为 + 绕过测试 + 凭据隔离 核实记录》。

---

## 2. Phase 1 — MVP 任务拆解 (WBS)

### 2.1 目录结构(建议)
```
product-explorer/
├─ design/                      # 四件套 + review-followups
├─ .opencode/                   # 仅配置,不含 opencode 源码
│  ├─ opencode.json             # v2 permissions 加固 ruleset(design §6)
│  └─ agent/env-debugger.md     # 受限子代理:环境操作一律走 lantern <subcmd>;改动只点 once
├─ AGENTS.md                    # 环境操作规范/约束
├─ cmd/{lanternd,lantern}/      # 守护进程 + CLI 瘦客户端
└─ src/
   ├─ ssh/{SessionManager,expect}.ts   # 持久多跳/su PTY + 标记/重连/脱敏/TTL/锁
   ├─ registry/                 # 环境注册表(工作区之外:~/.lantern/)
   ├─ secrets/                  # 密钥提供者(MVP: 读注册表明文;接口预留 keychain/Vault)
   ├─ classify/                 # lanternd 内部读/改分类器 + 只读子命令模板(by construction)
   ├─ diag/                     # 按 runtime 探针(arthas snapshot/observe、dlv、pyspy)
   ├─ swap/                     # put/swap/restart + 健康检查 + 回滚
   └─ audit/                    # 轻量 JSONL 审计
```

### 2.2 工作包

**WP1 — lanternd 会话管理(最高风险,先做)**
- [ ] `ssh2 conn.shell({pty:true})` 登录 + expect 原语(写入/按 `promptRe` 等待/超时)+ `sync_original_prompt`。
- [ ] 数据驱动建链:`escalate`/`hops` 走 `su`/`ssh`/`su`(全密码;跳转先 su 指定用户),每步后重同步提示。
- [ ] 逐命令 UUID 标记拿 stdout+退出码;去 ANSI/`stty -echo`/剥回显。
- [ ] keepalive + 掉线自动重走全链;命令队列串行化;**TTL/空闲超时 + 单拥有者锁 + `release`**(评审 #12);密码脱敏。
- [ ] 本地 unix socket RPC,跨调用复用会话;**op 为结构化操作描述,不透传自由 shell**。
- 验收:真实环境 `lantern exec --cmd whoami` 最深一跳返回 high 用户、退出码正确;二次调用秒级复用;空闲到期自动重置。

**WP2 — 环境注册表(工作区外)+ lantern CLI 骨架**
- [ ] 描述符 schema 落 `~/.lantern/`;`lantern env list`(allow)/`env use`(ask,评审 #8)。
- [ ] CLI 结构化 argv 解析(不透传远端 shell);录入 1 套真实 k8s 环境 + 1 个 JVM 服务。

**WP3 — 只读子命令(by construction)**
- [ ] `lantern logs`(server-side `--grep`/`--grep-b64`/`--tail`/`--since`/`--limit-bytes`,过滤在 lanternd 内拼,bash 串无元字符,评审 #10)、`lantern state`(只读 verb)、`lantern snapshot`(jstack/jad/sc/py-spy dump,被动一次性,评审 #5)。
- 验收:三者稳定取回**有界**输出;越出模板的请求被 lanternd fail-closed 拒绝(评审 #4)。

**WP4 — opencode 接入与门禁(不改源码)**
- [ ] `.opencode/opencode.json` v2 `permissions`(design §6:只读 lantern→allow、改动/侵入→ask、串联/替换/灾难→deny、管道/重定向→ask、`external_directory` 凭据路径→deny / 仓库路径→allow);`env-debugger.md`(锁工具集到 read/grep/glob + bash;规范"改动只点 once")。
- [ ] AGENTS.md:只读优先、改动必确认、目标环境必显、绝不点 always。
- [ ] `lanternd` 内部分类器:对 `exec --cmd` 自由文本读/改分类 + verb 白名单 + 灾难拒绝;只读子命令 fail-closed。
- [ ] serve 启动脚本:绑 `127.0.0.1` + `password`。
- 验收:TUI 跑通——只读 lantern 自动执行、改动/侵入弹审批、绕过用例(Phase0-B)全被拦、凭据不可读。

**WP5 — 改动子命令 + 换包安全**
- [ ] `lantern observe`(ask;Arthas watch/trace `-n`+超时,禁 tunnel-server;dlv/bpftrace)、`lantern exec`(ask)、`lantern redefine`(Arthas 单类)、`lantern put`(**默认 base64-over-PTY**,sha256;scp 仅直达优化,评审 #7)、`lantern swap/restart`(**带 `healthCmd` + 失败 `rollback` 恢复上一制品并告警**,评审 #11)。
- 验收:`redefine` 单类热替换被 `jad` 确认;模拟换包后健康检查失败 → 自动回滚到上一制品。

**WP6 — Agent 编排 + 代码关联**
- [ ] `env-debugger.md` 系统提示:RCA 流程(假设→只读取证→关联本地代码→必要时侵入观测/换包),"在线诊断优先"。
- [ ] 本地 repo 读取(opencode 原生 read/grep;外部仓库路径加 external_directory allow)。
- 验收:给一个真实 bug,agent 自主拉日志 + snapshot/observe + 读本地代码,产出定界结论。

**WP7 — 可见性 + 轻量审计**
- [ ] MVP 用 opencode TUI 验证"实时可见 + 逐条确认"。
- [ ] `lanternd` 落 JSONL 审计(远端命令原文/判定/审批结果/退出码摘要);可选订阅 SSE 记审批人。

### 2.3 依赖
- 运行时:opencode 1.17.8(pinned,**不改源码**)+ Node/Bun(`lanternd`/CLI,**TypeScript**)+ `ssh2`;注册表 **SQLite(`~/.lantern/`)**;opencode `provider` 配**公司内部 LLM 网关**(baseURL+key,OpenAI/Anthropic 兼容);诊断按**节点裸进程**直接对 PID attach。
- 环境侧:节点上 Arthas jar(无则 `lantern put`);JVM PID 可定位。
- 资料:专有 CLI 只读 verb 白名单(运维提供);在线诊断"被动 vs 侵入"分级清单(运维拍板,评审 #5);一套可连研发环境账号。

---

## 3. Phase 2 — 扩展

- **存储子命令(CLI-over-SSH,只读护栏)**:`lantern db/redis/kafka`——PG `default_transaction_read_only` + 静态 SELECT-only 解析;Redis `--scan`(禁 `KEYS`)、限 `@read`;Kafka `kcat -C` 不入组不提交、强制 `-o/-e/-c`、禁 `-G`;均经同一 bash ask 网关、走 lanternd 结构化构造。
- **远端 git 拉取** + 服务↔仓库映射完善。
- **复现回路状态机**:预算(~3/10)、首次复现即停、升级人工;`swapRecipe` 自动化(含健康检查/回滚)。
- **Web 控制台**:对接 opencode `app`(独立客户端,按 URL 连 v2 server,**不 vendor/不 fork**),外加多操作员鉴权 + 审计落库;加固策略用 v2 deny-wins。
- **审计加固**(按需):哈希链 + 异地存储;凭据迁 keychain/Vault。

---

## 4. 验收标准

- **Phase 1**:真实研发环境上,操作员选定环境后,AI 自主完成"建链→拉日志/看状态→Arthas 被动快照/侵入观测→结合本地代码给出定界结论";全程 TUI 实时可见,每条改动命令有确认;只读命令自动执行且输出有界;凭据不可被模型读取;绕过用例全被拦。
- **Phase 2**:在线诊断够不到时,AI 自主走通"改代码→构建→换包(健康检查/回滚)→复现→再定位"并在预算内收敛;DB/Redis/Kafka 只读取证可用且有护栏。

---

## 5. 风险登记与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| bash 字符串门禁被 shell 构造绕过(`<( $( ${` 等) | allowed lantern 调用后接本地危险命令 | deny-glob 只是纵深防御;真正边界=凭据隔离 + 只读 by-construction + 自由文本必人审;Phase0-B 绕过测试 |
| 凭据被模型 read/grep 读到 | 泄露 SSH 凭据 | 注册表存工作区外 + `external_directory:deny`;Phase0-C 验证;Phase2 接 keychain/Vault |
| `always` 无法限定为只读 | 误点对改动命令生效(限精确串) | 规范"改动只点 once"+ 会话开始清 saved + lanternd 二层 |
| 在线诊断侵入性(watch/trace/dlv/bpftrace 暂停/加载) | 影响共享 R&D 实例 | 被动快照 `snapshot`→allow;侵入式 `observe`→ask;分级清单由运维拍板 |
| 嵌套 su 下 scp 不可用 | 换包主路径失效 | 默认 base64-over-PTY,sha256;scp 仅直达优化;优先 redefine |
| 换包后服务起不来 | 共享环境持续降级 | swap 带 `healthCmd` + 失败自动 `rollback` 上一制品并告警 |
| 高权 PTY 残留 | 跨任务误操作/持续访问 | TTL/空闲超时 + 单拥有者锁 + `release` 显式拆链 + 进程退出兜底清理 |
| `su`/裸 PTY 解析脆弱 | 命令边界/退出码错乱 | UUID 标记 + 去 ANSI + `stty -echo` + 每跳后重同步 |
| opencode v2 实验中 + 日更 | 事件/端点名漂移 | 锁 1.17.8;Day-1 核实;只依赖最稳的 bash 网关 + permissions + SSE |
| 节点缺 CLI / 起 server 受限 | 工具集跑不起来 | 可 `lantern put` 上传二进制;Arthas 走 batch、绝不 tunnel-server |
| 本地只能跑 UT,复现保真有限 | Tier-2 回路昂贵/打转 | 在线诊断优先;预算与停止条件;不收敛升级人工 |
| 打错环境 | 误操作研发环境 | `env use` 为 ask;审批界面醒目显示目标节点 |
| MVP 审批接口被本地进程伪造 | 绕过人工确认 | serve 绑 loopback + password;Phase0-E 验证 |

---

## 6. 排期建议(粗粒度)

| 周 | 内容 |
|---|---|
| W0 | Phase 0 验证(尤其门禁/绕过/凭据隔离)+ 录入首套环境描述符 |
| W1–W2 | WP1 lanternd 会话管理(建链 + 标记 + 重连 + socket RPC + TTL/锁) |
| W2–W3 | WP2 注册表/CLI 骨架 + WP3 只读子命令(by construction) |
| W3–W4 | WP4 opencode 接入与门禁(permissions + 凭据隔离 + 分类器)+ WP6 Agent 编排/代码关联 |
| W4–W5 | WP5 改动子命令(observe/redefine/put base64/swap 健康回滚)+ WP7 审计;MVP 端到端联调 |
| W5+ | Phase 2:存储子命令 / 复现状态机 / app Web 控制台 |

---

## 7. 立即下一步
1. 跑 **Phase 0 验证清单**(尤其 B 绕过测试、C 凭据隔离、第 2/3/10 项)。
2. 找运维拿**专有 CLI 只读 verb 白名单** + **在线诊断"被动 vs 侵入"分级清单** + 一套可连研发环境账号。
3. 录入**首套环境描述符**(k8s + 1 个 JVM 服务,存 `~/.lantern/`),作为 WP1/WP3 联调靶子。
