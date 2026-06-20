# Lantern · Codex 评审跟进 (Review Follow-ups)

> 来源:2026-06-19 Codex 对 design/ 三件套 + README 的评审。
> 状态标记:🔧 **已改入文档** · ✍️ **已澄清措辞** · 📝 **已记录(Phase 0 验证 / 待决策)**
> 配套: [proposal.md](./proposal.md) · [design.md](./design.md) · [plan.md](./plan.md)

本轮评审的一个总体结论已采纳:**所有关于 opencode 1.17.8 v2 内部行为的断言,本会话已对本地 1.17.8 源码 clone 逐条核实并标注 file:line;但"目标部署构建上仍成立"作为 Phase 0 的硬性前置条件,而非普通里程碑。** 见 design.md §0。

此外,本轮促成一处**设计强化**:把"自动放行的只读子命令(`logs`/`state`/`snapshot`)做成 **read-only by construction**"——它们只接受结构化 flag、由 `lanternd` 用固定模板拼出已知只读命令,**不透传任何远端自由 shell**。自由文本只走 `lantern exec --cmd`(`ask`,人必看)。这一条同时化解了 #2/#4/#10 的大部分攻击面。

---

## Critical

### #1 `always` 审批与"逐条确认"矛盾 — 🔧已改 + 📝
- **核实**:bash 工具 `assert` 用 `save:[input.command]`(`bash.ts:146`),故 `always` 持久化的是**那条精确命令字符串**,不是 `lantern exec *` 通配——误点 `always` 的影响面仅限"再次运行完全相同的命令"。opencode **无原生开关**能"只对只读允许 always / 禁止对改动 always"(除非改源码,已排除)。
- **处置**:
  1. 改 design.md §11:删除"always 仅限只读"这一**无法被 opencode 强制**的错误表述,改为准确描述(精确串持久化 + 无法原生禁止改动 always)。
  2. 缓解(已写入 §11):AGENTS.md/操作规范明确"改动命令一律选 `once`,绝不选 `always`";每次会话开始**清空已保存规则**(`GET`/`DELETE /api/permission/saved` 已存在,`groups/permission.ts:28/40`);`lanternd` 二层防御仍在。
  3. 📝 Phase 0 验证 `always` 行为与 saved 规则清空(plan §1)。

### #2 deny glob 未覆盖全部 shell 绕过(如 `<(...)` 进程替换) — 🔧已改
- **核实**:Codex 正确。`<( >( ${ ` 换行 等未列。枚举元字符本质是打地鼠。
- **处置**:重写 design.md §6,把 deny-glob 明确**降级为纵深防御,而非真正边界**;补齐硬拒列表(`; & | && || \` $( ${ <( >(` 反引号/换行);并确立真正边界:① 仅 `lanternd` 持凭据可达环境 + 只读子命令 read-only by construction;② 自由文本只走 `ask` 的 `exec`,人必看。📝 Phase 0 专门做**绕过测试**(plan §1)。

### #3 凭据可被 opencode read/grep 读到 — 🔧已改
- **核实**:§6 放行 `read|grep|glob|list: *`,§11 说明文密码 OK,未规定凭据路径在工作区之外。
- **处置**:改 design.md §11/§6 与 descriptor:**环境注册表(含明文密码)存于 opencode 工作区之外**(如 `~/.lantern/`),由 `lanternd` 读取;opencode 侧 `external_directory:"deny"`(默认是 `ask`,见 `agent.ts:108`),并 📝 Phase 0 验证 `read/grep/list` 无法逃出工作区读到该路径。

---

## High

### #4 `lanternd` 二层与审批 UI 断链(死区) — 🔧已改(由构造消除)
- **核实**:lanternd 在 bash 下游,无法回弹 opencode 审批 UI;若已放行的 `logs` 被二层判为改动,只能静默执行或报错。
- **处置**:从根上消除死区——**自动放行子命令 read-only by construction**(结构化 flag + 固定只读模板,永不产生改动),故不存在"读子命令里混入改动"的情形;`lanternd` 二层对这些子命令是 **fail-closed**:任何越出模板的请求直接拒绝并提示改用 `lantern exec`(`ask`)。改 design.md §5/§6。

### #5 `observe` 被自动放行但在线诊断有侵入性 — 🔧已改
- **核实**:Arthas `watch/trace/tt`、`dlv attach`、`bpftrace` 可加负载/暂停/需高权,不应等同只读。
- **处置**:**拆分子命令**(glob 友好):新增 `lantern snapshot`(一次性被动快照:jstack/jad/`sc`/py-spy dump)→ `allow`;`lantern observe`(实时 watch/trace/tt、dlv、bpftrace,有开销/可暂停)→ **`ask`**。改 design.md §5/§6/§7。兼顾"允许在线观测"的决策(被动快照免确认,侵入式逐条确认)。

### #6 MVP 审批接口无认证(本地进程可伪造 reply) — 🔧已改 + ✍️
- **核实**:`opencode serve` **支持 password**(`commands.ts:21` "Get or set the server password" → `createRoutes(password)`,`serve.ts:19/37`),且默认绑 `127.0.0.1`。
- **处置**:改 design.md §2.2/§10:MVP 即**绑 loopback + 启用 serve password**;📝 Phase 0 确认未带密码时本地伪造 reply 的可行性与防护。

### #7 嵌套 su 单 PTY 下 scp 基本不可用 — 🔧已改
- **核实**:Codex 正确。scp 另开 SSH 通道,无法复用 PTY 内 su 得到的权限/跳链。
- **处置**:**把 base64-over-PTY 设为换包主路径**,scp 仅作"存在直达跳点时"的优化。改 design.md §3(`putMethod` 默认 `base64`)、§4/§7。

### #8 `env use` 自动放行但"打错环境"是已登记风险 — 🔧已改
- **处置**:`lantern env use`(切换目标环境)改为 **`ask`**;`lantern env list`(只列出)保持 `allow`。改 design.md §5/§6。审批框醒目显示目标环境/节点。

---

## Medium

### #9 v2 内部行为是断言、Phase 0 才验证 — ✍️已澄清 + 📝
- **处置**:design.md §0 增加**来源声明**:断言已对本地 1.17.8 源码 clone 核实(附 file:line),Phase 0 在**实际部署/所用构建**上复核为硬前置。Appendix B 列出复核项。

### #10 deny `*|*`/`*>*` 误杀合法 grep 管道 — 🔧已改
- **核实**:`lantern logs --grep 'a|b'` 的 `|` 在原始串里仍触发 deny;§8 又靠 grep/zgrep 服务端过滤。
- **处置**:① 只读子命令**服务端过滤在 `lanternd` 内做**,bash 串里不出现管道/重定向(结构化 flag);复杂正则用编码 flag(`--grep-b64`)或临时文件传入,使 bash 串保持无元字符。② deny 分级:**硬拒**命令串联/替换/`sudo`/`rm -rf`(`; && || & \` $( ${ <( >(`);对**单独的 `|`/`>`** 采用 `ask`(而非 deny),避免误杀合法引号内用法又保留人审。改 design.md §6/§8。

### #11 换包失败无回滚/无健康检查 — 🔧已改
- **处置**:`swapRecipe` 增 `healthCmd` 与**回滚**(保留上一制品,健康检查失败自动恢复并告警);Agent/操作员行为写入 §7。改 design.md §3/§7、plan WP5、风险表。

### #12 高权 PTY 生命周期/所有权未定义 — 🔧已改
- **处置**:design.md §4.4 增:每会话 **TTL + 空闲超时**自动断开并重置;单拥有者**锁**(一个 env 同时只允许一个活动会话);显式 `lantern env release` 拆链;进程退出兜底清理。

---

## Low

### #13 README "v1" 与文档 "v2" 版本不一致 — 🔧已改
- **处置**:README "现状"改为"📐 设计阶段(文档 v2,尚无代码实现)",消除歧义(三份文档头部的 `v2` 指**设计修订版次**,非里程碑)。

### #14 "复用 packages/app" 集成方式含糊 — ✍️已澄清
- **处置**:design.md §10 明确:**作为独立客户端进程、按 URL 连接所给 v2 server,原样运行 opencode 发布的 `app`/`tui`,或我们自建一个薄 SSE 客户端对接其文档化 API;均不 vendor、不 fork、不改源码**。Phase2 的鉴权/审计是在该客户端**外侧**加的网关层。

---

## 仍待你决策的开放项(未擅自定稿)
- **#5 观测分级的确切清单**:哪些 Arthas/dlv 操作算"被动快照(`snapshot`,免确认)"、哪些算"侵入式(`observe`,需确认)"——建议由你/运维拍板一份白名单(design.md 给了默认划分)。
- **#1 是否在会话开始强制清空 saved 规则**:默认建议"清空 + 禁止对改动点 always",但这会让每次都重新确认重复的只读命令(只读本就 allow,影响小)。如需保留只读的 always 便利,可只清空"非 allowlist 命中"的 saved 项。
- **#6 是否引入更强本地认证**:MVP loopback+password 已足够研发场景;若多用户/跨机访问再升级。

---

# Codex 代码评审跟进 (2026-06-20,实现后)

对全部 `src/` 代码 + 设计的对抗式评审,处置如下。🔧=已改并加测试 · ✍️=已澄清 · 📝=已记录/后续。

## Critical
- **C1 凭据可被 opencode `read:*` 越权读出** — 🔧**已解决(macOS)**:secrets 改存 **OS 钥匙串**(`security`,service `lantern`),**完全不进任何文件**——opencode `read` 读不到(已验证:secret 在钥匙串、registry.db 内 absent)。非 macOS 回退 sqlite(0700/0600)。`SecretStore` 抽象,lanternd 在 macOS 自动启用;Vault/跨平台留 Phase 2。
- **C2 unix socket 无认证** — 🔧**已加固**:每次启动生成 **256-bit 能力令牌**(`~/.lantern/token`,0600),每条 RPC 必带并校验(无/错令牌→`unauthorized`);socket 0600 + 目录 0700 挡跨用户。同用户进程仍能读令牌文件(研发单机信任边界);per-command 能力 / `SO_PEERCRED` 记 Phase 2。
- **C3 "read-only by construction" 不成立(描述符注入)** — 🔧**已改**:`logs.k8s` 模板与 `locate.pid` 现经分类器校验为只读、**fail-closed**;`snapshot` 改两步解析**数值 PID**(无 `$()`);数据字段 shellQuote。+注入拒绝测试。

## High
- **H1 ssh host-key 不校验** — 🔧**已改**:`connectSsh2` 设 `hostHash:"sha256"` + `hostVerifier`;描述符加 `bastion.hostKeySha256`(pin 指纹,容忍 `SHA256:`/冒号/大小写)。**fail-closed**:未 pin 且未显式 `insecureHostKey:true` → `makeBastionFactory` 抛错拒连。`makeHostVerifier`/`normalizeFingerprint` 纯函数已测;真实握手仍走受控 e2e。
- **H2 建链期描述符注入(su/ssh)** — 🔧**已改**:`su -`/`ssh` 的 user/host 已 shellQuote + schema 正则校验(无 shell 元字符)。
- **H3 docker/git 嵌套子命令误判 read** — 🔧**已改**:`docker image`(管理组)/`git config|branch|tag|remote` 移出只读集。
- **H4 "只读"二进制有写模式** — 🔧**已改**:jmap/jinfo 移出只读(jstack/jps/pgrep/pidof 保留);`sed --in-place`/`w` 拦截;`find -fprint0/-fprintf` 拦截。
- **H5 `rm -r -f`/`--recursive --force` 绕过灾难拒绝** — 🔧**已改**:`hasCatastrophicRm` 按任意短/长/拆分标志检测 recursive+force。
- **H6 ensureFresh/队列竞态 + 超时残留脏 PTY** — 📝**记录**:建议把 freshness 检查并入队列、超时即 release 重建。当前 Expecter 串行 + 拒并发 expect 缓解了一部分;完整修复列后续。
- **H7 注册表目录/DB 默认 umask** — 🔧**已改**:`~/.lantern` 0700 + registry.db 0600(+测试)。

## Medium
- **M1 policy 镜像与 opencode `findLast` 不一致** — 🔧**已改**:核实源码 `evaluate()` 为 findLast;`policy.ts` 改纯 findLast + 默认 ask;新增"后置 allow 覆盖前置 deny"测试。**规则顺序成约定:deny 必须置后**。
- **M2 AGENTS.md 与实际 deny 不符** — 🔧**已改**:opencode.json 加 `su` deny;AGENTS.md 改为"ssh/su 拒绝、kubectl/管道需确认应拒绝"的准确表述。
- **M3 审批者看不到展开后的远端命令** — 🔧**已改**:`lantern` CLI 在 stderr 回显 `[lantern <env>] $ <expanded command>`。
- **M4 审计漏 env.add/env.use** — 🔧**已改(部分)**:env.add/env.use 现已审计。actor/peer-UID(Bun 未暴露 `SO_PEERCRED`)/关联 opencode 审批事件 留 Phase 2。
- **M5 输出无上限** — 🔧**已改**:`SessionManager.run` 统一对 stdout 设 `maxStdoutBytes`(默认 1MB)硬截断并置 `truncated`,覆盖所有子命令(state/snapshot/exec),不再只靠 logs 的 `head -c`。

## Low
- **L1 `LANTERN_LOCAL_SHELL` 静默本机执行** — 🔧**已改**:启动打印醒目 DEV/DEMO 警告横幅。
- **L2 fixture 不覆盖真实 PTY/host-key/超时** — 📝**记录**:Phase 2 加 localhost sshd 受控集成(host-key 不符、ECHO-on、超时、并发重连)。
- **L3 未知尾随参数被静默忽略** — 📝**记录**:hand-rolled parser 对受控 agent 用法够用;后续可换严格 schema。

**Codex 确认无误**:registry SQL 参数化无注入;`sendSecret` 脱敏路径无明文泄漏;NDJSON happy-path 分帧正确。
