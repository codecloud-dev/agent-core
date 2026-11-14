# 更新日志 · agent-core

> 格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

本文件记录**显著的**用户可见变更。琐碎的排版、内部重构、CI 微调不单独列条目；完整逐笔记录请看 [提交历史](../../commits/main) 与 [Releases](../../releases)。

## [Unreleased]

> 尚未发布的改动合并后写在这里，发布时归入对应版本段落。

### 新增 / 修复 / 变更

- _（暂无待发布条目）_

## [1.1.1] - 2026-11-14

### 变更

- **升级依赖（仅 devDependencies）**：`@types/node` 20.19.43 → 26.6.6、`esbuild` 0.25.12 → 0.28.2、`typescript` 下限 `^5.4.0` → `^5.9.3`（实际锁定 5.9.3，仍属 5.x 安全线，未跨大版本 7.x）。构建产物与发布包（dist/README/LICENSE）不受影响；`npm run build` 与 `npm test`（56 通过 / 0 失败）均通过，`npm audit` 0 漏洞。
- **文档修正**：README / README.en 的包名由旧前缀 `@mox/agent-core` 统一更正为 `@codecloud-dev/agent-core`，版本徽标与发布状态（已发布）与 `package.json` 实际一致。

## 历史版本

历史变更请看 [Releases 页面](../../releases)；本文件自 2026-11-11 起统一维护，此前条目不再补录，避免与发布记录产生两个互相矛盾的版本来源。

---

**条目写法**：`### 新增` / `### 修复` / `### 变更` / `### 移除` / `### 安全`，每条一句话说清「用户能感知到什么变化」，涉及破坏性变更必须以 **`BREAKING`** 开头标出。
