# RFC-0001: `lantern watch` — 只读实时会话镜像

- **Status**: Draft
- **Date**: 2026-06-20
- **Author**: Lantern
- **Relates**: `design.md`(实时可见性 / 第 2 层安全)、`AGENTS.md`、`review-followups.md`

## 1. Summary

新增 `lantern watch`:一个长连接、**只读**的 CLI,把 lanternd 在隔离环境里做的每件事
——连接链(堡垒登录→su→跳转→su)、每条已执行的命令、输出(密码已脱敏)、退出码、
lanternd 侧的拒绝——实时渲染成类 SSH 的流水。它把设计里"操作者实时可见每条命令"
这条安全属性做成一个**独立窗口**,和 opencode 的对话/审批窗口分离。

目标使用形态(用户期望):同时开两个终端——

```
┌─ 窗口 1:opencode ──────────────┐   ┌─ 窗口 2:lantern watch ───────────────────────┐
│ 你对话 + 逐条审批(权限网关在此) │   │ 只读实时镜像:看 lanternd 对环境实际做了什么   │
└────────────────────────────────┘   └───────────────────────────────────────────────┘
```

## 2. Motivation

- "实时可见"目前只藏在 opencode TUI 的工具调用展开里,不连续、不可一眼扫。运维想要一个
  持续、可信赖的"它现在对我生产机干了啥"的视图。
- 两窗口模型把**信任面**(右:看环境真实操作)和**工作面**(左:对话+批准)拆开,更简单、更放心。
- 直接复用 SessionManager 已有的事件(见 §4.1),增量很小。

## 3. Guide-level(UX)

```
$ lantern watch                 # 跟看所有环境的实时流水
$ lantern watch --env prod-a    # 只看某个环境
$ lantern watch --no-output     # 只看命令/步骤,不打印输出(更安静)
# Ctrl-C 脱离(不影响任何会话)
```

渲染样例:

```
● prod-a  connected  ops@10.1.2.3 → su approot → ssh 192.168.10.5 → su appadmin
12:04:01 prod-a logs   $ tail -n200 /app/order/logs/app.log | grep -- ERROR | head -c 200000
                       │ ...NullPointerException at OrderService.price(OrderService.java:88)...
12:04:01 prod-a logs   ✓ exit 0  (2.1 KB)
12:04:09 prod-a snapshot $ jstack 48213
                       │ "http-nio-8080-exec-7" ... waiting on <DB pool>
12:04:20 prod-a exec   ✗ refused (catastrophic): rm -rf (recursive+force)
```

约定:连接 banner(`●`)、时间戳 + envId + method + `$ 命令`、输出缩进到 `│`、
退出行 `✓/✗ exit N (字节数)`、密码行恒为 `***`、lanternd 拒绝行 `✗ refused …`。
非 TTY 或 `NO_COLOR` 时输出纯文本。

## 4. Reference-level(技术设计)

### 4.1 已有的事件(无需新造)

`SessionManager` 已 emit(`src/ssh/session.ts`,均**已脱敏**):

| emit | 触发 | 内容 |
|---|---|---|
| `stdout` | 输出到达 | `redact(stripAnsi(chunk))` |
| `step` | 提权/跳转 | `escalate: su - X` / `hop: ssh Y` |
| `write` | 发送命令 | 命令(密码 → `***`) |
| `error` | 出错 | 错误信息 |

缺的只有一层:这些事件目前没人转发出去(`pool.ts` 未挂 `onEvent`),且没有流式订阅通道。

### 4.2 WatchEvent(daemon 级信封)

在 SessionEvent 外再包一层、加 `ts`/`env`,并并入 dispatch 级事件:

```ts
type WatchEvent =
  | { ts; env; kind: "connect"; chain: string[] }              // 连接建立 + 链路
  | { ts; env; kind: "step";    text: string }                 // escalate/hop
  | { ts; env; kind: "command"; method; command: string }      // 一条已批准并即将执行的命令
  | { ts; env; kind: "stdout";  text: string }                 // 输出块(已脱敏)
  | { ts; env; kind: "exit";    method; exitCode; bytes; truncated? }
  | { ts; env; kind: "denied";  method; command; reason }      // lanternd 灾难拒绝(第 2 层)
  | { ts; env; kind: "error";   text: string }
  | { ts; env; kind: "meta";    text: string }                 // env.add/env.use 等
```

### 4.3 关键修正:审批发生在 lanternd **之前**

opencode 的权限网关拦的是 **bash 工具**:AI 想跑 `lantern exec …` 时,opencode 先在
TUI 问操作者;**批准后** opencode 的 bash 才真正执行 `lantern exec`,这时才到 lanternd。
所以 **lanternd 只看得到"已批准并已执行"的命令**,看不到"待批准"。

⇒ watch 窗口展示的是**环境的真实操作流水(post-approval ground truth)+ lanternd 自己的
灾难拒绝**,不展示审批提示(那始终在 opencode 窗口)。这反而更干净:watch = 真正碰到环境
的东西的唯一真相源。(上面 §3 样例据此不含"待批准"行。)

### 4.4 EventBus + 环形缓冲

Daemon 持有一个 `EventBus`:
- `publish(e: WatchEvent)`:写入环形缓冲(最近 N 条,默认见 §8)并广播给所有订阅者。
- `subscribe(fn) → unsubscribe`:新订阅者先收到环形缓冲回放(attach 即见近况),再收实时流。
- 慢订阅者隔离:每订阅者有界队列,超限丢最旧并打一条 `meta: "watch backlog dropped"`(不阻塞会话)。

接线:
- `SessionPool` 给它创建的每个 `SessionManager` 传 `onEvent`,打上 envId 后 `bus.publish`;
  会话首次建立时由 pool 发 `connect`(链路从描述符推导)。
- `dispatch` 在 `record()` 同处发 `command`/`exit`/`denied`(它本就在那做审计,顺手 publish)。

### 4.5 流式传输(复用 unix socket)

当前 socket 是"一行请求→一行响应"。新增方法 `watch`,**特例化**:
- 收到 `{ method:"watch", params:{ env? } }` 后**不**关连接:校验令牌 → 回放环形缓冲 →
  把该 socket 注册为 bus 订阅者,每个 WatchEvent 作为一帧 NDJSON 推送,直到客户端断开。
- 令牌校验照旧(watch 请求必须带令牌)。socket 仍 0600。

### 4.6 CLI

`lantern watch`:读令牌 → 连 socket → 发 `watch` 请求 → 循环读 NDJSON 帧 →
`renderWatchEvent(e)`(纯函数,可单测)渲染成 §3 那种行 → 直到 Ctrl-C/EOF。
需要一个新的流式客户端 `watchStream(socketPath, params, onFrame)`(现有 `rpc()` 是一问一答,
不能复用)。

## 5. Security considerations

- **令牌**:watch 流携带环境输出,必须带能力令牌(同所有 RPC)。
- **只脱敏内容上总线**:SessionManager 在 emit 前已 `redact`,密码恒 `***`;env.add 的密钥**值**
  绝不 publish(只发一条不含值的 `meta`)。新增测试:已知 secret 串绝不出现在 watch 流里。
- **只读**:watch 订阅者只能收,没有任何把命令送进会话的路径(无 stdin 桥)。
- **环形缓冲仅在内存**:有界、不落盘(落盘的审计是 `audit.jsonl`,另一条路径)。

## 6. Drawbacks / Alternatives

- 依赖 opencode TUI 看(否决:不连续、和对话混在一起、不可一眼扫)。
- `tail audit.jsonl`(否决:事后、无实时输出流、无连接链、无回放语义)。
- 全 TUI 多窗格(v1 过度:先做纯流水文本,后续可加)。

## 7. Testing

- Bus 单测:pub/sub、环形回放、多订阅广播、断开即退订、慢订阅丢弃。
- Server:一条 `watch` 连接能收到另一条连接跑命令产生的帧;无令牌被拒;已知 secret 不出现。
- 渲染单测:`renderWatchEvent` 各 kind → 期望行(含 `NO_COLOR`/非 TTY 纯文本)。
- e2e(LOCAL_SHELL):起 daemon → attach watch(抓帧)→ 另一客户端跑 `state`/`exec` →
  断言 watch 流含 command + stdout + exit;跑灾难命令 → 含 `denied`。

## 8. Implementation slices(小步提交,每步过 CI)

1. `WatchEvent` 类型 + `EventBus`(环形缓冲、pub/sub、慢订阅隔离)+ 单测。
2. `pool` 转发 SessionManager 事件→bus(打 envId)+ `connect`;`dispatch` publish command/exit/denied/meta。
3. server:`watch` 流式方法(keep-open、回放、广播、令牌、慢客户端)+ 单测。
4. CLI:`watchStream` 客户端 + `lantern watch` 渲染器 + HELP + L3 风格参数校验。
5. e2e + 文档(AGENTS.md "开一个 watch 窗口"、README/design 提一句)。

## 9. Unresolved questions

- 环形缓冲大小:默认 **512 条 或 256 KB**(取先到)?
- `connect` 链路串:从描述符推导(`ops@host → su X → ssh Y → su Z`),密码不入串——OK?
- 多 env 时是否给每个 env 不同颜色前缀(nice-to-have,可放 slice 4 末)。
