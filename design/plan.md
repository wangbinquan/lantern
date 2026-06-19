# Lantern · AI 环境问题定位助手 — 落地计划 (Plan)

> 版本: v2 (修订:基于 anomalyco/opencode **1.17.8**;无侵入架构 = 外部 `lantern` + opencode 内置 bash 工具)
> 日期: 2026-06-19  ·  配套: [proposal.md](./proposal.md) · [design.md](./design.md)

---

## 0. 里程碑总览

| 阶段 | 目标 | 退出标准 |
|---|---|---|
| **Phase 0** Day-1 验证 | 核实 bash 网关行为 + lantern-over-bash 链路 | 验证清单全绿 |
| **Phase 1** MVP | 跑通"选环境→建链→取日志/状态→在线诊断→结合本地代码定界" | 真实环境端到端走通,TUI 实时可见、改动逐条确认 |
| **Phase 2** 自主复现 + 存储 + Web 控制台 | 自主"改代码→构建→换包→复现";接 DB/Redis/Kafka;复用 app 做 Web | 典型问题预算内收敛;存储只读取证可用 |

---

## 1. Phase 0 — Day-1 验证 (动手前,~1 天)

在本地 **1.17.8** 上核实(因为我们只依赖"内置 bash 工具 + `permissions` 配置 + SSE",验证面很小)。

**验证清单:**
1. [ ] `opencode serve` 起得来;`GET /api/event` 能订到事件;确认 `permission.v2.asked` / `session.next.shell.started`(带命令原文)事件名。
2. [ ] **bash 工具在 serve/TUI 下确实经 `permissions` 网关**:配一条 `{action:"bash", resource:"echo hi", effect:"ask"}`,确认 `echo hi` 会阻塞并弹 `permission.v2.asked`,reply `once` 后才执行。
3. [ ] **`deny` 优先确实压过 `allow`**:同时配 `lantern logs *`→allow 与 `*&*`→deny,确认 `lantern logs x && y` 被拒(验证 §6 安全网成立)。
4. [ ] glob 通配语义:确认 `*` = `.*`(`lantern logs *` 匹配带空格后缀),据此校准 §6 规则顺序与 deny 列表。
5. [ ] reply 端点 `POST /api/session/:id/permission/:requestID/reply` 路径与 body(`{reply}`);确认对不存在 requestID 的处理(社区曾报误返 200)。
6. [ ] TUI(`packages/tui`)连本地 serve,bash 审批框显示 `$ <command>` 且能 `once/reject` —— 作为 MVP 操作台可用。
7. [ ] `ssh2` 在 Node/Bun(我们 `lanternd` 的运行时,**独立于 opencode**)里 `conn.shell({pty:true})` 可用。
8. [ ] `lanternd` 守护进程能跨多次 `lantern` CLI 调用**复用同一条已建链 PTY 会话**(本地 socket RPC 最小验证)。

**产出**:一页《1.17.8 bash 网关行为核实记录》+ 确认 `permissions` 规则集形态。

---

## 2. Phase 1 — MVP 任务拆解 (WBS)

### 2.1 目录结构(建议)
```
product-explorer/
├─ design/                      # 三件套
├─ .opencode/                   # 仅配置,不含 opencode 源码
│  ├─ opencode.json             # v2 permissions 加固 ruleset(§6)
│  └─ agent/env-debugger.md     # 受限子代理:系统提示 = "环境操作一律走 lantern <subcmd>"
├─ AGENTS.md                    # 给 agent 的环境操作规范/约束
├─ cmd/
│  ├─ lanternd/                 # 守护进程:持有多跳/su PTY、socket RPC
│  └─ lantern/                  # CLI 瘦客户端(opencode 经 bash 调用)
├─ src/
│  ├─ ssh/SessionManager.ts     # 持久多跳/su PTY + 标记/重连/脱敏
│  ├─ ssh/expect.ts             # 提示同步 + expect 原语
│  ├─ registry/                 # 环境注册表(读库/读文件)
│  ├─ secrets/                  # 密钥提供者(MVP: 读注册表明文,接口预留)
│  ├─ classify/                 # lanternd 内部读/改分类器(纵深防御)
│  ├─ diag/                     # 按 runtime 的探针封装(arthas/dlv/pyspy)
│  └─ audit/                    # 轻量 JSONL 审计
```

### 2.2 工作包

**WP1 — lanternd 会话管理(最高风险,先做)**
- [ ] `ssh2 conn.shell({pty:true})` 登录堡垒;expect 原语(写入+按 `promptRe` 等待+超时);`sync_original_prompt` 初始同步。
- [ ] 数据驱动建链:遍历 `escalate`/`hops` 走 `su`/`ssh`/`su`(全密码;跳转先 su 到指定跳板用户),每步后重同步提示。
- [ ] 逐命令 UUID 标记拿 stdout+退出码;去 ANSI、`stty -echo`、剥回显。
- [ ] keepalive + 掉线自动重走全链;命令队列串行化;`abort`/超时;密码脱敏。
- [ ] 本地 unix socket RPC,守护进程跨调用复用会话。
- 验收:对真实环境,`lantern exec --cmd whoami` 在最深一跳返回 high 用户,退出码正确,二次调用复用同一会话(秒级)。

**WP2 — 环境注册表 + lantern CLI 骨架**
- [ ] 描述符 schema 落库/落文件 + 读取层;`lantern env use/list`。
- [ ] CLI 结构化 argv 解析(不透传远端 shell);至少录入 1 套真实环境(k8s)+ 1 个 JVM 服务。

**WP3 — 只读子命令**
- [ ] `lantern logs`(server-side 过滤+硬上限)、`lantern state`(只读 verb)、`lantern observe`(Arthas batch,强制 `-n`+超时;Go/Python 探针留桩)。
- 验收:三者稳定取回**有界**输出。

**WP4 — opencode 接入与门禁(不改源码)**
- [ ] `.opencode/opencode.json` v2 `permissions` 加固 ruleset(§6:只读 lantern→allow、改动→ask、串联/危险→deny);`env-debugger.md` agent(系统提示约束只走 lantern,锁工具集到 read/grep/glob + bash)。
- [ ] AGENTS.md:只读优先、改动必确认、目标环境必显。
- [ ] `lanternd` 内部分类器(WP-classify):读/改判定 + kubectl/专有 verb 表 + 灾难拒绝。
- 验收:用 TUI 跑一遍,只读 lantern 自动执行、改动弹审批、`lantern logs x && rm` 被 deny。

**WP5 — 改动子命令**
- [ ] `lantern exec`(默认 ask)、`lantern redefine`(Arthas 单类热替换)、`lantern put`(scp 优先 + base64 兜底,sha256)、`lantern swap/restart`。
- 验收:`lantern redefine` 把本地编译的单 `.class` 热替换到目标 JVM 并被 `jad` 确认。

**WP6 — Agent 编排 + 代码关联**
- [ ] `env-debugger.md` 系统提示:RCA 流程(假设→只读取证→关联本地代码→必要时建议在线诊断/换包),"在线诊断优先"。
- [ ] 本地 repo 读取(opencode 原生 read/grep)。
- 验收:给一个真实 bug,agent 自主拉日志 + Arthas observe + 读本地代码,产出定界结论。

**WP7 — 可见性 + 轻量审计**
- [ ] MVP 用 opencode TUI 验证"实时可见 + 逐条确认"。
- [ ] `lanternd` 落 JSONL 审计(远端命令/判定/结果)。

### 2.3 依赖
- 运行时:opencode 1.17.8(pinned,**不改源码**)+ Node/Bun(跑 `lanternd`);`ssh2`。
- 环境侧:节点上 Arthas jar(无则 `lantern put`);JVM PID 可定位。
- 资料:专有 CLI 只读 verb 白名单(运维提供);一套可连研发环境账号。

---

## 3. Phase 2 — 扩展

- **存储子命令(CLI-over-SSH,只读护栏)**:`lantern db/redis/kafka`——PG `PGOPTIONS='-c default_transaction_read_only=on' psql -X -At` + 静态 SELECT-only 解析;Redis `--scan`(禁 `KEYS`)、限 `@read`;Kafka `kcat -C`(不入组不提交)强制 `-o/-e/-c`,禁 `-G`;均经同一 bash ask 网关。
- **远端 git 拉取** + 服务↔仓库映射完善。
- **复现回路状态机**:预算(~3/10)、首次复现即停、升级人工;按语言 `swapRecipe` 自动化。
- **Web 控制台**:**复用 `packages/app`**(SDK+SSE+审批 dock 现成),外加多操作员鉴权 + 审计落库(可用 monorepo 里 `packages/effect-sqlite-node` 思路);加固策略用 v2 deny-wins。
- **审计加固**(按需):哈希链 + 异地存储。

---

## 4. 验收标准

- **Phase 1**:真实研发环境上,操作员选定环境后,AI 自主完成"建链→拉日志/看状态→Arthas 在线观测→结合本地代码给出定界结论";全程 opencode TUI 实时可见,每条改动命令有确认;只读命令自动执行且输出有界。
- **Phase 2**:在线诊断够不到时,AI 自主走通"改代码→构建→换包→复现→再定位"并在预算内收敛;DB/Redis/Kafka 只读取证可用且有护栏。

---

## 5. 风险登记与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| bash 命令串门禁被 shell 串联绕过 | 在 allowed lantern 调用后接本地危险命令 | deny-wins 规则挡 `; & \| $( \` >`;lantern 结构化 argv 不透传 shell;关键分类在 lanternd 内部 |
| `su`/裸 PTY 解析脆弱(banner/ANSI/PS1) | 命令边界/退出码错乱 | UUID 标记 + 去 ANSI + `stty -echo` + 每跳后重同步 |
| 只读分类漏判(尤其专有 verb) | 改动命令被当只读 | 边界是 bash ask 网关 + lanternd 默认 ask;verb 白名单由运维维护;灾难熔断 |
| opencode v2 实验中 + 日更 | 事件/端点名漂移 | 锁 1.17.8;Day-1 核实;只依赖最稳的 bash 网关 + permissions 配置面 |
| 节点缺 CLI / 起 server 受限 | 工具集跑不起来 | 可 `lantern put` 上传二进制;Arthas 走 batch、绝不 `tunnel-server` |
| 本地只能跑 UT,复现保真有限 | Tier-2 回路昂贵/打转 | 在线诊断优先;预算与停止条件;不收敛升级人工 |
| 打错环境 | 误操作研发环境 | 每会话显式选定 env;审批界面醒目显示目标节点;只读白名单收紧 |
| 制品经嵌套 su/多跳传输失败 | 换包受阻 | scp 优先,base64-over-PTY 兜底,sha256 校验;优先 `redefine` 单类 |

---

## 6. 排期建议(粗粒度)

| 周 | 内容 |
|---|---|
| W0 | Phase 0 验证 + 录入首套环境描述符 |
| W1–W2 | WP1 lanternd 会话管理(建链 + 标记 + 重连 + socket RPC) |
| W2–W3 | WP2 注册表/CLI 骨架 + WP3 只读子命令 |
| W3–W4 | WP4 opencode 接入与门禁 + WP6 Agent 编排/代码关联 |
| W4–W5 | WP5 改动子命令 + WP7 审计;MVP 端到端联调 |
| W5+ | Phase 2:存储子命令 / 复现状态机 / app Web 控制台 |

---

## 7. 立即下一步
1. 跑 **Phase 0 验证清单**(尤其第 2、3、8 项:bash 网关阻塞、deny-wins、PTY 会话复用)。
2. 找运维拿**专有 CLI 只读 verb 白名单** + 一套可连研发环境账号。
3. 录入**首套环境描述符**(k8s + 1 个 JVM 服务),作为 WP1/WP3 联调靶子。
