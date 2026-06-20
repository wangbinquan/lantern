# RFC-0003: `lantern swap` — 换包闭环(上传 / 重启 / 健康 / 回滚)

- **Status**: Draft
- **Date**: 2026-06-20
- **Author**: Lantern
- **Relates**: `design.md`(在线诊断够不到时的"加日志→构建→换包→复现"回路)、RFC-0001(watch)、`ServiceDescriptor.swap`(已存在的 `SwapRecipe` 字段)

## 1. Summary

新增 `lantern swap`/`put`/`restart`:把**本地构建好的产物**经唯一的多跳/su PTY 通道**换到环境里**
并重启、健康检查、失败回滚——design 里"加日志→构建→换包→复现"回路里的**换包**那一环。
本地编辑+构建由 agent(opencode 的 bash,本就可见+确认)完成;`lantern` 负责**远端那段**
(最难、最危险的部分)。每条都是**改动类命令,需逐条确认**;watch 窗口实时显示内部每一步。

## 2. Motivation

被动诊断(snapshot/Arthas)够不到根因时,需要改代码加日志重打包换上去复现。环境**不许开端口、
不许装额外服务**,且通道是堡垒→su→跳转→su 的 PTY——**scp/sftp 穿不过 su/hop**。唯一可行的
上传方式是 **base64 流过 PTY**。这一环手工做极其痛苦且易错(无备份、无校验、无回滚),正是该自动化的。

## 3. Guide-level(UX)

```
# agent 先本地改代码 + 构建(opencode bash,可见+确认),产出 ./target/order-svc.jar
$ lantern swap --service order-svc --file ./target/order-svc.jar
  [确认] 这是改动操作 → 操作员在 opencode 窗口点允许;另开的 lantern watch 实时显示:
    ● prod-a state $ cp /app/order/order-svc.jar /app/order/order-svc.jar.lantern.bak
    ● prod-a put   $ (上传 27.4 MB,base64 分块…) ✓ sha256 校验通过
    ● prod-a state $ systemctl restart order-svc
    ● prod-a state $ curl -sf localhost:8080/health   ✓ exit 0
  ✔ swap 成功:order-svc 已换包并通过健康检查。
# 健康检查失败时(rollback 开启):自动 cp 备份回去 + 重启,并报告失败。
```

辅助命令:`lantern put --service X --file <local>`(只上传,带备份)、
`lantern restart --service X`(只重启)。三者都是 mutating。

## 4. Reference-level

### 4.1 描述符(已存在,补默认)

```ts
ServiceDescriptor.swap?: {
  remotePath: string;     // 远端产物路径(覆盖目标),必填
  restartCmd?: string;    // 重启命令(systemctl restart … / kill+拉起脚本)
  healthCmd?: string;     // 健康检查(只读,exit 0 = 健康)
  rollback?: boolean;     // 健康失败是否自动回滚(默认 true)
  decode?: string;        // 远端解码命令模板(默认见 §4.3 可移植回退)
  // mode/buildCmd/artifact/putMethod 暂不在 v1 用(本地构建归 agent)
}
```

### 4.2 命令分解(三个新 RPC,均 mutating)

- **`put`**:备份 remotePath(若存在 → `remotePath.lantern.bak`)→ base64 上传 → sha256 校验。
- **`restart`**:跑 `swap.restartCmd`。
- **`swap`**:`put` → `restart` → `healthCmd`(若有);健康失败且 `rollback` → 还原备份 + 重启,报失败。
  在 opencode 层是**一次确认**;内部多步由 watch 窗口逐条可见(RFC-0001)。

### 4.3 base64-over-PTY 上传(核心,可移植)

本地(lanternd 读本机文件):`bytes → base64 → 按 chunkSize 切块`,算本地 `sha256`。
远端命令序列(纯函数 `planUpload` 生成,全部 shell-quote / base64 字母表无元字符):

```
: > <tmp>                                   # 截断临时文件
printf %s '<chunk_0>' >> <tmp>              # 逐块追加(ECHO 关,无回显)
…
printf %s '<chunk_n>' >> <tmp>
( base64 -d <tmp> > <remotePath> 2>/dev/null || base64 -D <tmp> > <remotePath> )  # GNU/BSD 可移植
( sha256sum <remotePath> 2>/dev/null || shasum -a 256 <remotePath> )              # 取首段 hex
rm -f <tmp>
```

执行器跑这串命令(经 `pool.run`),解析校验和首段 hex,与本地 sha256 比对;**不符则失败、不重启**。
`base64 -d||-D`、`sha256sum||shasum` 双回退保证 Linux 环境 + macOS CI/smoke 都过。

### 4.4 swap 编排 + 回滚

1. `assertReadOnly(healthCmd)`(健康检查必须只读,分类器校验)。
2. 备份:`cp <remotePath> <bak>`(remotePath 存在才备份;记住是否有备份)。
3. `put`(§4.3)。
4. `restart`。
5. `healthCmd`(若配置):exit≠0 ⇒ 不健康。
6. 不健康且 `rollback`(默认 true)且有备份 ⇒ `cp <bak> <remotePath>` + `restart`,返回 `swapped:false, rolledBack:true`。
7. 全程 publish watch 事件(`meta`/`command`/`exit`)+ 审计每步。

### 4.5 交付

CLI:`lantern swap --service X --file <local> [--dry-run] [--no-rollback] [--env id]`、`put`、`restart`。
**`--dry-run`**:只读本机文件算 sha256/大小、解析备份路径/restartCmd/healthCmd 并展示**将要做什么**,
**不执行任何远端改动**(仍校验 swap 配置存在、healthCmd 只读,使预览可信)。
lanternd 读**本机** `--file`(操作员机器上),base64 编码上传。RunResultPayload 扩展 swap 结果
(`swapped`/`rolledBack`/`sha256`/`healthExit`)。分类器把 put/restart/swap 标记 mutating;
opencode.json 对它们 `ask`(逐条确认);审计记录每步。

## 5. Security considerations

- **逐条确认**:put/restart/swap 在 opencode 权限网关 `ask`,绝不自动放行。swap 一次确认 = 一次
  完整换包;内部步骤由 **watch 窗口实时可见**(可信任面)。
- **备份 + 回滚 + 校验**:覆盖前先备份;上传后 sha256 校验(不符不重启);健康失败自动还原。
- **路径安全**:remotePath/tmp/svc 名全 shell-quote;healthCmd 强制只读(分类器);restartCmd 由
  操作员在描述符里授权(可信)。base64 块单引号包裹,字母表 `[A-Za-z0-9+/=]` 无逃逸面。
- **本地文件读取**:lanternd 读操作员机器上的 `--file`(意图内);opencode 网关已对该 `lantern swap`
  调用确认。临时文件上传后 `rm -f`。
- **审计**:backup/put/restart/health/rollback 每步入 `audit.jsonl` + watch 总线。

## 6. Drawbacks / Alternatives

- scp/rsync(否决:穿不过 su/hop PTY,且需干净 ssh 通道)。
- 开临时端口/HTTP 拉取(否决:环境硬约束不许开端口/装服务)。
- 大产物慢:base64 over PTY 对几十 MB 的 jar 是分块串行,分钟级。v1 接受;压缩对已压缩的 jar 收益小,暂不做。
- 本地构建纳入 lantern(否决 v1:构建归 agent/opencode,本就可见+确认;swap 取 `--file`)。

## 7. Testing

- `planUpload` 纯函数:命令序列正确(截断/分块/解码/校验/清理)、分块边界、shell-quote、可移植回退串。
- `readArtifact` 本地读 + sha256 + base64(临时文件)。
- 上传执行器(LOCAL_SHELL 集成):上传小文件到临时路径 → 实际 `base64 -d` 还原 → sha256 匹配;
  故意改一块 → 校验失败。
- swap 编排:健康通过 → swapped;健康失败 + rollback → 还原 + restart(用本地 fake restart/health 命令断言);
  healthCmd 非只读 → 拒绝。
- CLI argparse(put/restart/swap)+ 分类器标记 mutating + opencode.json 命中 ask。

## 8. Implementation slices(小步提交,每步过 CI)

1. `planUpload`(纯)+ `readArtifact`(本地 IO)+ 单测。
2. 上传执行器 + `put`(备份+上传+校验)+ LOCAL_SHELL 集成测试(真实 base64 还原 + 校验)。
3. `swap` 编排(backup→put→restart→health→rollback)+ `restart` + dispatch + 测试。
4. CLI(put/restart/swap)+ 分类器/权限/审计 + watch 事件接线。
5. 文档(README/AGENTS、RFC→Implemented)+ LOCAL_SHELL 全链路 smoke。

## 9. Unresolved questions(已定稿)

- **`--dry-run`**:做(预览将要做什么,不改远端)。
- 上传分块大小:默认 **16 KB base64/块**(可在 swap 参数或描述符调)。
- `put`/`restart` 独立命令:都暴露,`swap` 为主线。
- `env init` 是否问 swap 配置(remotePath/restartCmd/health)?v1 先让操作员在描述符里加;init 扩展留后续。
- 大产物压缩(gzip→base64→远端 gunzip):jar 已压缩,收益小,暂不做。
