# RFC-0004: `lantern observe` — 只读侵入式诊断(Arthas)

- **Status**: Draft
- **Date**: 2026-06-20
- **Author**: Lantern
- **Relates**: `design.md` §7(snapshot vs observe)、`classify`(arthas 只读/改动动词集)、`review-followups` #5(观测分级)、RFC-0001(watch)

## 1. Summary

新增 `lantern observe`:对 JVM 服务用 **Arthas 批处理模式**做**只读但侵入式**的运行时观测——
`watch`(方法入参/返回/异常)、`trace`(调用路径+耗时)、`stack`(到达某方法的栈)、`tt`(时光隧道)。
不开端口、一次性、按 `-n` 次数有界。区别于已有的 `snapshot`(被动一击、免确认):observe **侵入**
(attach agent、有性能影响),故**需逐条确认**。只读性由**构造**保证:只允许只读 Arthas 动词 +
**固定安全表达式**(不接受任意 OGNL)。v1 限 JVM/Arthas。

## 2. Motivation

被动 `snapshot`(jstack)只给某一刻的线程栈;定位"某方法为何返回错值 / 某调用为何慢"需要观测
**多次调用的入参/返回/路径**——Arthas `watch`/`trace` 正是干这个的。手工跑 Arthas 要进交互控制台
(易开端口、易误用 OGNL/`redefine`)。observe 用**批处理 + 固定表达式**把它**安全、可见、一次性**封装。

## 3. Guide-level(UX)

```
lantern observe --service order-svc --op watch --class com.x.OrderService --method price --count 5
lantern observe --service order-svc --op trace --class com.x.OrderService --method price --count 3
# op: watch(入参/返回/异常) · trace(路径+耗时) · stack(到达栈) · tt(时光隧道)
# 改动类 → 逐条确认;watch 窗口实时显示;-n 有界,跑完自动 `stop` 卸载 agent。
```

## 4. Reference-level

### 4.1 构造(只读 by construction)

`buildObserve(service, { op, className, method, count }, pid) → string`(纯)

- `op ∈ {watch, trace, stack, tt}`(只读 Arthas 动词,复用分类器 arthas 只读集;**不含** redefine/
  retransform/ognl/vmtool/heapdump 等改动/写盘动词)。
- `className` 正则 `^[A-Za-z0-9_$.*]+$`、`method` 正则 `^[A-Za-z0-9_$<>*]+$`(排除一切 shell 元字符;
  shellQuote 为真正防线,正则是 sanity 闸)。非法即拒。
- `count` 夹取 `1..1000`(默认 10)。
- watch 表达式**硬编码** `{params,returnObj,throwExp}`(只读字段访问;**不接受任意 OGNL** ⇒ 杜绝
  `{@System@exit(0)}` 类副作用)。
- `arthasJar = service.diag.arthasJar`(必填,缺失报错)。
- arthasCmd 例:`watch <cls> <m> '{params,returnObj,throwExp}' -n <n> ; stop`(trace/stack/tt 无表达式)。
- 整命令:`java -jar <q(arthasJar)> <pid> --batch-mode -c <q(arthasCmd)>`(批处理、不开端口、跑完 `stop`
  卸载 agent)。`q()`=shellQuote;cls/method 也 quote。

### 4.2 dispatch

两步(同 snapshot,免 `$()`):先跑 `locate.pid` 解析**数值 pid** → `buildObserve` → `pool.run`
(受 `--timeout` 约束)→ `record` + watch `command`/`exit` 事件。observe **不自动放行**
(opencode `bash * → ask`,read-only allow 未含 observe)。

### 4.3 CLI

`lantern observe --service X --op <watch|trace|stack|tt> --class <FQN> --method <m> [--count N] [--env id] [--timeout ms]`。
Arthas 输出打到 stdout;`--class`/`--method`/`--op` 必填。

## 5. Security considerations

- **不接受任意 OGNL**:watch 表达式固定为只读字段;op 白名单只含只读动词。这是 observe 最大的安全点。
- class/method 正则校验 + shellQuote;count 夹取;pid 数值化(2 步解析)。
- **需确认**(侵入 + 性能影响);watch 窗口实时可见;每次审计。
- 批处理 + `stop`:不开端口、跑完卸载 agent(满足"环境不许开端口")。

## 6. Drawbacks / Limitations

- **挂起风险**:`watch/trace -n N` 会**阻塞直到该方法被调用 N 次**;若方法长期不被调用,会用满
  `--timeout`,且 Arthas agent 可能残留到 JVM 重启(批处理 `stop` 未及执行)。⇒ 建议只对**确实在被
  调用**的方法用、给小 `-n`。远端 `timeout` 包裹 / `observe --stop` 清理留 **Phase 2**(`timeout` 在
  macOS 测试不可移植,故 v1 不内置)。
- v1 限 JVM/Arthas。Python(`py-spy record` 写文件)、Go(`dlv trace` attach 会 pause)语义不同,留后续。

## 7. Testing

- `buildObserve` 纯函数:各 op 命令正确;watch 固定表达式;class/method 校验拒非法(含 shell 元字符);
  count 夹取;shellQuote;arthasJar 缺失报错。
- dispatch:解析数值 pid → 构造 → 发布 watch `command` 事件(断言命令内容);observe 落 `ask`(权限不变)。
- CLI argparse(observe + 必填校验)。

## 8. Implementation slices(小步提交,每步过 CI)

1. `buildObserve`(纯)+ 校验 + 单测。
2. observe dispatch(2 步 pid + 构造 + run + watch/audit)+ CLI(args/lantern/HELP)+ 测试。
3. 文档(README/AGENTS、RFC→Implemented)+ smoke(LOCAL_SHELL:用 stub launcher 验证 pid 解析 +
   命令构造 + 发布到 watch)。

## 9. Unresolved questions

- 观测分级白名单(snapshot vs observe 的确切 Arthas 动词划分)由运维拍板;本 RFC 取保守只读集。
- 挂起/detach 清理(远端 `timeout`、`observe --stop`)。
- Python/Go observe。
