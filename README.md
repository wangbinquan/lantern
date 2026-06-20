# Lantern 🏮

> 把一盏灯带进不透明的隔离环境里照问题。

**Lantern 是一个极简的 stdio MCP 服务**:让 [opencode](https://github.com/anomalyco/opencode)(或任意 MCP 客户端)**连进一个 SSH-only、网络隔离的环境并执行命令**——穿过那条唯一的多跳/su 链(堡垒登录 → su 提权 → ssh 跳内网 → 再 su)。**这就是它的全部职责。**

取日志、看状态、在线诊断、换包——这些是**各业务自己写的 opencode skill**(它们调用 `exec` 工具),不在 Lantern 里。Lantern 只负责"连上 + 执行"。

## 为什么是 MCP

商用产品的服务常常无法在本地运行,环境又在网络隔离里:只有堡垒有大网 IP,极低权限用户 SSH 登录,需 `su` 提权、`su` 到跳板再 `ssh` 跳内网,且不许部署额外服务、不许开端口。难点在那条 SSH 链(`su` 必须 PTY 喂密码)。Lantern 把这条链做成一个 MCP 工具 `exec`,opencode 就能像在环境里敲命令一样定位问题,而**确认、可见性都由 MCP 客户端原生提供**。

> 历史注:早期版本误以为 opencode v2 不支持 MCP,于是把能力做成 CLI 经 bash 工具接入,并内置了 logs/swap/observe 等大量业务命令。**opencode v2 其实完整支持 MCP**(`ConfigV2.MCP.Local/Remote`),那套是为不存在的限制做的弯路,已按 [RFC-0005](./design/rfc/0005-mcp-server.md) 收敛回连接器本源。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `env_list` | 列出已配置的环境(id + label + 角色名) |
| `exec` | 以某**角色**身份在环境上跑一条命令 → `{stdout, exitCode}`;密码在 PTY 注入、**绝不回传** |

**按操作选身份:角色(role)**(RFC-0007)。隔离环境每台机上有很多用户,按操作选(重启服务用一个、传文件用另一个,可能在不同节点)。所以描述符是**骨架 + 角色**:`bastion` 登录 + 命名 `nodes`(怎么到每台机)+ `roles`(在哪台、su 成谁)。`exec(env, command, role)` 由 skill 按操作传 `role`,Lantern 把那条链解析出来、在对应提示符注入该角色的 su 密码(keychain)。同角色复用一条常驻会话,换角色切另一条。

安全/可见性交给 MCP 客户端:**逐条 `exec` 确认** = opencode 的工具调用权限网关;**实时可见** = opencode TUI 显示每次工具调用 + 结果。Lantern 只保留一条**灾难命令兜底**(拒绝 `rm -rf` / `mkfs` / fork bomb 等)。密码全程在 OS 钥匙串,经 PTV 注入、从每个结果里脱敏。

**旁观模式 `lantern monitor`**(RFC-0006):想要一个独立的"只读 ssh 窗口"?另开一个终端跑 `lantern monitor`,它跟读 server 的 `~/.lantern/exec.jsonl`,实时镜像环境上**已执行的每条命令 + 输出 + 退出码 + 拒绝**(无密码)。左边 opencode 对话+批,右边 monitor 旁观。

## 接入 opencode

1. **配置环境(out-of-band,密钥不经模型)**——交互向导,隐藏输入直接进钥匙串、host key 经 `ssh-keyscan` 确认后 pin(TOFU):
   ```bash
   bun src/cli/lantern.ts env init prod-a              # 问登录 + 内网节点 + 各操作角色
   bun src/cli/lantern.ts env node add prod-a app2     # 之后增量加一个节点
   bun src/cli/lantern.ts env role add prod-a restart  # 之后增量加一个角色(节点+su 用户)
   bun src/cli/lantern.ts env list                     # 显示 id/label/角色名
   ```
2. **在 opencode v2 配置里声明 MCP server**(opencode 用命令拉起它,走 stdio):
   ```jsonc
   { "mcp": { "servers": {
     "lantern": { "type": "local", "command": ["bun", "/abs/path/to/product-explorer/src/mcp/server.ts"] }
   } } }
   ```
3. opencode 即可调用 `env_list` / `exec`。你写自己的 skill 用 `exec` 拼业务动作(取日志、诊断、换包)。

## 快速开始(零-ssh 本地演示)

```bash
bun install
bun run typecheck && bun run lint && bun run format:check && bun test   # 同 CI 的门禁

# 会话跑在本机 bash 而非真实环境:
export LANTERN_HOME=$(mktemp -d)/lantern LANTERN_LOCAL_SHELL=1
# 答:label, host, port, user, auth, 密码, 配节点?(n), 角色名, 在哪台(bastion), su?(空), 再加?(n)
printf 'demo\nh\n\nme\n\npw\nn\ndefault\n\n\nn\n' | bun src/cli/lantern.ts env init demo --insecure-host-key
bun src/cli/lantern.ts env list
# 启 MCP server(opencode 会这样拉起它);用任意 MCP 客户端调 exec
bun src/mcp/server.ts
```

## 代码模块(`src/`)

| 模块 | 职责 |
|---|---|
| `mcp/` | stdio MCP server(`env_list` + `exec` 工具)— opencode 拉起的就是它 |
| `ssh/` | SessionManager(执行注入的 su/ssh 链)+ ssh2 真实传输 — **最难的核心** |
| `pty/` | 命令标记协议 + expect FSM + spawn 传输 |
| `session/` | SessionPool(每 env+角色一条常驻会话)+ `resolveChain`(角色→链) |
| `registry/` | 环境**连接 + 角色**描述符(zod)+ bun:sqlite + 钥匙串密钥 @ `~/.lantern` |
| `safety/` | 灾难命令兜底(`rm -rf` / `mkfs` / fork bomb …) |
| `cli/` | env-admin CLI(`env init/list/use/rm` → 直写注册表,out-of-band) |

## 现状

🟢 MCP server 已实现(TypeScript / Bun;**91 tests**,CI 绿)。核心:多跳/su PTV 会话引擎、SQLite 连接注册表、钥匙串密钥、host-key pin、`env init` 向导、`env_list` + `exec` MCP 工具、灾难兜底。已用 MCP SDK 客户端端到端验证(`tools/list` + `exec` + 灾难拒绝)。`connectSsh2`(真实 ssh)需活动 sshd,以受控 e2e 验证。

设计文档:[RFC-0005](./design/rfc/0005-mcp-server.md)(现行架构)。RFC-0001..0004 与 `design/{proposal,design,plan}.md` 是被其取代的历史(旧 CLI/bash 架构)。

## 名字由来

调试隔离环境像在黑暗里摸索——Lantern 就是那盏带进去的灯。
