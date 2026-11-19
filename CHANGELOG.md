# 更新日志 · agent-core

> 格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

本文件记录**显著的**用户可见变更。琐碎的排版、内部重构、CI 微调不单独列条目；完整逐笔记录请看 [提交历史](../../commits/main) 与 [Releases](../../releases)。

## [Unreleased]

> 尚未发布的改动合并后写在这里，发布时归入对应版本段落。

### 新增 / 修复 / 变更

- _（暂无待发布条目）_

## [1.1.2] - 2026-11-19

### 新增

- **有状态图引擎 `StateGraph` / `CompiledGraph`**（对标 LangGraph 六能力中的 state-graph + checkpoint + HITL + time-travel + observability）：`addNode` / `addEdge` / `addConditionalEdge` 构图，默认浅合并 reducer 可替换；每一步（含起点/终点）落盘 `Checkpoint`，`parentId` 串成可回溯链；节点内 `ctx.interrupt(payload)` 暂停等待人工输入，`resume(cpId, value)` 注入后重跑该节点；`invoke(input, { fromCheckpoint, stateOverride })` 从历史快照分叉（会按新状态重算后继，不再沿用旧路由）；`observer` 收到完整事件流（start / node_start / node_end / checkpoint / interrupt / resume / end / error），observer 抛错被吞掉不影响图执行；`maxSteps` 防自激循环，节点抛错也落 error checkpoint。checkpointer 可换成任意 `Storage`，已测 MemoryStorage / NodeStorage 跨实例恢复。
- **`Storage.compareAndSwapJSON(key, expected, next)` 原子 CAS 接口**，三个内置适配器全部实现：`MemoryStorage` 用同步读改写、`NodeStorage` 用进程内串行化、`D1Storage` 用条件 `UPDATE ... WHERE key=? AND value=?` + `INSERT OR IGNORE`（跨 Worker 行级原子）。未实现 CAS 的自定义 `Storage` 由护栏侧进程内互斥锁兜底。
- **真实基准脚本 `scripts/benchmark.mjs`**（`npm run bench -- 200`）：跑 dist 真实实现，覆盖 200 步状态图全量 checkpoint、MemoryStorage / NodeStorage 读写、guardExecute 并发占位吞吐。本机实测（node v22.13.1，N=200，连续 4 次采样区间，随负载波动）：状态图 200 步 / 202 checkpoint 用 2.59–3.11 ms（约 6.4–7.7 万 steps/s）；MemoryStorage 写 0.42–0.59 ms / 读 0.15–0.18 ms；NodeStorage 逐条落盘写 46.57–52.48 ms，改 `autosync:false` + 一次 `flush()` 仅 0.59–0.89 ms（约 76–79x）；guardExecute 并发占位 1.35–2.04 ms（约 9.8–14.8 万 ops/s）。

### 修复

- **单日熔断按 UTC 而非本地日期分桶**：原 `todayStr()` 用 `toISOString().slice(0,10)`，导致 UTC+8 用户在每天 08:00（而非午夜）就跳到下一天额度桶，与文档承诺不符。改为用本地年月日分量拼装；回归测试钉 `TZ=Asia/Shanghai` + `2026-10-03T20:00Z`，确认落桶为 `2026-10-04`。
- **并发请求可击穿单日熔断（真 bug）**：原 `checkDailyGate → 执行 → bumpDailyGate` 非原子，10 个并发请求在 cap=3 时全部执行、`gate.count` 只记到 1。改为「先原子占位、再执行、失败退回占位」：`claimGateSlot` 在 `(Storage, key)` 互斥锁 + CAS 重试下完成读-判-加一，只有抢到额度的请求才调用执行器；执行失败 `releaseGateSlot` 退回，保持「只有成功的中/高危才计费」。回归测试：cap=3 / 10 并发 → 恰好执行 3 次、count=3、拦截 7 次；cap=5 / 20 并发同样准确；失败动作 count 回到 0。
- **文档链接与配置**：README / README.en 的 Gitee 镜像链接由旧账号路径 `gitee.com/thousand-code-crafts/*` 更正为 `gitee.com/codecloud-dev/*`；`gitee-mirror.yml` 的仓库路径与 Basic 认证用户名同步改为 `codecloud-dev`（旧 login 作 Gitee push 用户名会被 403 拒绝）；测试横幅与测试数同步为 116。

### 变更

- `tests/run.sh` 增加 `reliability.test.cjs`（23 例）与 `graph.test.cjs`（37 例）。全套 `npm test` 由 56 例增至 **116 例全过**（47 + 9 + 23 + 37）；`npm run build`（含 `tsc` 声明产出）退出码 0；`npx tsc --noEmit` 退出码 0。

## [1.1.1] - 2026-11-14

### 变更

- **升级依赖（仅 devDependencies）**：`@types/node` 20.19.43 → 26.6.6、`esbuild` 0.25.12 → 0.28.2、`typescript` 下限 `^5.4.0` → `^5.9.3`（实际锁定 5.9.3，仍属 5.x 安全线，未跨大版本 7.x）。构建产物与发布包（dist/README/LICENSE）不受影响；`npm run build` 与 `npm test`（56 通过 / 0 失败）均通过，`npm audit` 0 漏洞。
- **文档修正**：README / README.en 的包名由旧前缀 `@mox/agent-core` 统一更正为 `@codecloud-dev/agent-core`，版本徽标与发布状态（已发布）与 `package.json` 实际一致。

## 历史版本

历史变更请看 [Releases 页面](../../releases)；本文件自 2026-11-11 起统一维护，此前条目不再补录，避免与发布记录产生两个互相矛盾的版本来源。

---

**条目写法**：`### 新增` / `### 修复` / `### 变更` / `### 移除` / `### 安全`，每条一句话说清「用户能感知到什么变化」，涉及破坏性变更必须以 **`BREAKING`** 开头标出。
