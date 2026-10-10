# @mox/agent-core

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-8a7bff" alt="version">
  <img src="https://img.shields.io/badge/npm-publish%20pending-ffb000" alt="npm">
  <img src="https://img.shields.io/badge/license-MIT-37d5d3" alt="license">
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/runtime-any%20platform-2088FF" alt="platform-agnostic">
  <img src="https://img.shields.io/badge/docs-中%2FEN%20switch-ff7ac3" alt="docs">
</p>


> **通用 Agent 核心** —— 把「元认知协议引擎」与「分级自主护栏」从具体项目里抽出来，做成
> **平台无关、可注入、可测试**的通用代码。适用于运维、研发、数据分析、内容生产、客服、自动化……
> 任何需要「会思考 + 可控自治」的 Agent 场景。

<p>
  <a href="README.md">中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="https://codecloud-dev.github.io/agent-core/">📖 文档站 Docs (中/EN 一键切换)</a>
</p>

<p align="center"><img src="assets/demo.svg" width="760" alt="agent-core 元认知环动图：核心引擎驱动 think → act → reflect 循环，分级自主护栏可控"></p>

<p>
  <b>⭐ 如果 @mox/agent-core 对你有用,欢迎点个 <a href="https://github.com/codecloud-dev/agent-core">Star</a> —— 它能让更多开发者用上会思考、可控自治的 Agent 核心!</b>



## 🐛 欢迎来“批斗”我

> 这是个刚起步的项目，**bug 肯定有，而且不少**。我不装完美——
> 你踩到的每一个坑、每一个槽点，都是帮我把它养好的机会。

- 💥 遇到崩溃 / 黑屏 / 跑不起来？→ [提个 Bug 报告](https://github.com/codecloud-dev/agent-core/issues)
- 💡 有想要的功能？→ [开个需求](https://github.com/codecloud-dev/agent-core/issues)
- 🗯️ 单纯想吐槽、挑刺？→ 也欢迎开 issue，标签随便打 😄

每个 issue 我都会看，能修的尽快修。一起把它从“能跑”养到“好用” 💪
</p>

> 设计理念：元认知不应该只是一句提示词，而应该是**真实跑在引擎里的架构**。于是推理链、执行后自检、工具风险分级、单日熔断、影子模式，都做成了可测试的结构化模块——平台无关，任何人都能 `npm i` 或源码引入，用在自己的 Agent 上。

---

<details>
<summary>📑 目录 · Contents</summary>

- [🎯 它解决什么](#它解决什么)
- [📦 安装](#安装)
- [🚀 快速开始](#快速开始)
- [🛠️ 多种使用方法](#多种使用方法)
- [⚙️ 核心概念](#核心概念)
- [🔹 运行时抽象（注入式）](#运行时抽象注入式)
- [📚 完整 API 参考](#完整-api-参考)
- [🗺️ 进度表 / 路线图](#进度表-路线图)
- [❓ 常见问题（FAQ）](#常见问题faq)
- [🧪 测试](#测试)
- [💖 支持我们](#支持我们)
- [📜 许可](#许可)

</details>

## 🎯 它解决什么

- **元认知可外显、可强制**：`think`（推理卡）/ `reflect`（自检卡）是结构化协议动作，引擎能渲染给人类看，并强制"变更后必须先 reflect 才能收尾"。
- **一次吐多个动作不再丢**：模型常把 `think` 和 `call` 打包成 `[{think},{call}]`，普通实现会整体落入兜底吞掉 `call`，导致"只思考不干事"。`normalizeActions` 把单对象/数组都归一化成动作数组。
- **分级自主护栏**：工具三级风险（low/mid/high）+ 单日自动变更熔断 + 影子模式（中危只模拟上报）。让"AI 拿权限"可控、可观测、可回滚。
- **零平台绑定**：不依赖 Cloudflare/Node/Vercel。存储、动作执行器、日志都通过接口注入。内置 `D1Storage`(CF) / `MemoryStorage`(本地&测试) / `NodeStorage`(Node 文件) 三个适配器，任意后端（Redis/Prisma/DynamoDB）照模板自写即可。

---

## 📦 安装

### 📦 方式一：源码安装（当前始终可用）

```bash
git clone https://github.com/codecloud-dev/agent-core.git
cd agent-core
npm install                 # 仅拉取 esbuild / typescript 等开发依赖
# 打包成单文件（无原生依赖，可直接 require，也可上 Cloudflare Workers 等边缘运行时）
npm run build
```

### 📦 方式二：npm 安装（v1.0.0 起已就绪）

```bash
npm i @mox/agent-core
```

> 发布状态：`package.json` 已就绪（`version: 1.0.0`、`prepublishOnly` 会自动构建）。维护者执行一次
> `npm publish` 即可上线；上线后上方 `npm i` 即生效。文档站与示例均已按 1.0.0 编写。

需要打包到边缘运行时（Cloudflare Workers 等）时，用 esbuild/workerd 打包即可（无原生依赖）：

```bash
esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js
```

---

## 🚀 快速开始

### 🔹 1. 元认知：归一化动作 + 闭环门

```ts
import { normalizeActions, ReflectGate, buildThink, buildReflect } from '@mox/agent-core';

// 模型可能返回单个对象，也可能返回数组（think+call 打包）
const actions = normalizeActions(parsedModelOutput); // Action[]
const gate = new ReflectGate();
for (const a of actions) {
  if (a.action === 'think') renderReasonCard(a.reasoning);
  if (a.action === 'call')  { runTool(a.tool, a.args); gate.afterMutation(); }
  if (a.action === 'reflect') gate.onReflect();
  if (a.action === 'answer') send(a.text);
}
// 收尾前若 gate.isPending → 驳回重做（闭环规则：先自检，再收尾）
if (gate.isPending) reject('请先 reflect 再收尾');
```

### 🔹 2. 分级护栏：让自主执行可控

```ts
import { guardExecute, defaultRemediationTier, isShadowMode } from '@mox/agent-core';
import { MemoryStorage } from '@mox/agent-core'; // 本地/测试零依赖；生产换 D1Storage / NodeStorage

const deps = {
  storage: new MemoryStorage(),   // 任何实现 Storage 的都行
  executor: {                    // 真正的自愈动作由你执行
    async execute(tool, args) {
      return await runRemediation(tool, args);
    },
  },
  remediationTier: defaultRemediationTier,
  logger: { log: (lvl, kind, action, detail) => recordAudit(lvl, kind, action, detail) },
};

// 单日额度耗尽 → 直接拦截（blocked），不会真执行
const gate = await checkDailyGate(deps);

// 中危动作：若开了影子模式 → 只模拟上报；否则真执行并计额度
const res = await guardExecute(deps, 'disable_channel', { id: 7 });
if (res.blocked)    alert('今日自动变更额度已耗尽');
else if (res.simulated) reviewLater(res.summary); // 影子模式
else if (res.ok)     console.log('已执行：', res.summary);
```

跑一个真实可运行的最小示例：

```bash
npx tsx examples/quickstart.ts
```

---

## 🛠️ 多种使用方法（从引入到上线）

同一个核心，按你的运行环境选一种接法即可——下面每一种都给可直接抄的片段。

| 场景 | 引入方式 | 存储适配器 | 关键点 |
|------|----------|------------|--------|
| Node 服务 / CLI | `npm i @mox/agent-core`（ESM）或 `require`（CJS） | `NodeStorage` | 文件持久化，零原生依赖 |
| 边缘 / Cloudflare Workers | esbuild 打包成单文件 ESM | `D1Storage` | 无原生依赖，直接上 Workers |
| 单元测试 / 本地 | 源码 `npx tsx examples/quickstart.ts` | `MemoryStorage` | 零依赖 Mock，跑通即验证 |
| Web 框架（Hono / Express） | 作为中间件注入 | 任意 | 请求级隔离，每个请求一个新 Storage |

### 🔹 1. Node.js：ESM 与 CJS 两种引入

```ts
// ESM（推荐，package.json 设 "type": "module"）
import { normalizeActions, guardExecute, MemoryStorage } from '@mox/agent-core';

// CJS
// const { guardExecute, MemoryStorage } = require('@mox/agent-core');
```

### 🔹 2. 边缘运行时：Cloudflare Workers / 无服务器

核心无原生依赖，`NodeStorage` 只在方法被调用时才 `import('node:fs')`，Workers 里别用它即可，不影响打包。

```ts
// worker.ts
import { guardExecute, D1Storage, defaultRemediationTier } from '@mox/agent-core';

export default {
  async fetch(_req: Request, env: { DB: unknown }) {
    const storage = new D1Storage(env.DB as any, { table: 'agent_kv' });
    const res = await guardExecute(
      { storage, executor: myExecutor, remediationTier: defaultRemediationTier },
      'disable_channel', { id: 7 },
    );
    return new Response(JSON.stringify(res));
  },
};
```

```bash
# 打包（产物可直接部署到 Workers / 边缘）
esbuild worker.ts --bundle --format=esm --outfile=dist/worker.js
```

### 🔹 3. 单元测试：注入 Mock，不碰真实后端

`MemoryStorage` 自带 `clear()`，每个用例前清一次即可隔离；用假 `executor` 断言护栏行为：

```ts
import { guardExecute, MemoryStorage, setShadowMode, defaultRemediationTier } from '@mox/agent-core';

const fakeExec = { async execute() { return { ok: true, summary: 'mock' }; } };
const storage = new MemoryStorage();

// 单日额度耗尽 → blocked（不会真执行）
const g1 = await guardExecute({ storage, executor: fakeExec, remediationTier: defaultRemediationTier }, 'add_credits', { uid: 1, amount: 10 });
console.log(g1.blocked);   // true

// 开启影子模式 → 中危只模拟上报
await setShadowMode(storage, true);
const g2 = await guardExecute({ storage, executor: fakeExec, remediationTier: defaultRemediationTier }, 'add_credits', { uid: 1, amount: 10 });
console.log(g2.simulated); // true
storage.clear();
```

### 🔹 4. 接入 Web 框架（以 Hono 为例）

```ts
import { Hono } from 'hono';
import { guardExecute, D1Storage, defaultRemediationTier } from '@mox/agent-core';

const app = new Hono<{ Bindings: { DB: any } }>();
app.post('/agent/act', async (c) => {
  const storage = new D1Storage(c.env.DB, { table: 'agent_kv' });
  const res = await guardExecute(
    { storage, executor: myExecutor, remediationTier: defaultRemediationTier },
    c.req.query('tool')!, await c.req.json(),
  );
  return c.json(res);
});
// Express / Fastify 同理：把 c.env.DB 换成 req.app.locals.db 即可
```

### 🔹 5. 端到端：一个「客服补偿」Agent 从零搭

把上面几块串起来就是生产用法：模型一次性吐多个动作 → `normalizeActions` 归一化 → 变更类动作逐个走 `guardExecute` 护栏 → `ReflectGate` 强制「先 reflect 再收尾」→ `answer`。完整可运行代码见仓库 [`examples/quickstart.ts`](examples/quickstart.ts)，直接跑：

```bash
npx tsx examples/quickstart.ts
```

> 想换存储后端（Redis / Prisma / DynamoDB）？照 [`examples/custom-adapter.ts`](examples/custom-adapter.ts) 的 `RedisStorage` 模板实现 `Storage` 接口的 `getJSON` / `setJSON` 两个方法即可，核心一行不用改。

---

## ⚙️ 核心概念

### 🔹 元认知动作协议

| 动作 | 含义 | 引擎职责 |
|------|------|----------|
| `think`  | 目标/假设/查证计划/四视角推理 | 渲染成「推理卡」给人类看 |
| `reflect`| 执行后自检（verdict/副作用/更优解/置信度） | 渲染成「自检卡」；`ReflectGate` 要求它在收尾前出现 |
| `call`   | 调工具（带 `why` 可见思考） | 中危走批准门，高危永远人工确认 |
| `answer` | 自然语言收尾 | 打字机输出 |

`think` 的 `perspectives` 固定四视角：`决策者 / 用户 / 安全 / 成本`——逼 Agent 每次决策都从这四个立场过一遍（拍板的人/受众/风险/资源）。可用 `missingPerspectives()` 校验四视角是否齐全。

### 🔹 工具风险分级

```ts
type ToolTier = 'low' | 'mid' | 'high';
// low  —— 可逆/无影响（发公告、记记忆）→ 自主可自动
// mid  —— 有业务影响但可逆（加币/会员/调价/踢人）→ 需批准或影子模拟
// high —— 不可逆/高影响（退款/封禁）→ 永远人工确认，不在无人确认下自动执行
```

`defaultToolTier` / `defaultRemediationTier` 是示例策略，接入方**必须按自己业务覆盖**。

### 🔹 护栏三件套

1. **单日自动变更熔断**（`checkDailyGate`/`bumpDailyGate`）：防失控、防自激循环。状态存 `Storage`，跨请求持久。
2. **影子模式**（`isShadowMode`/`setShadowMode`）：开启后中危动作只模拟上报不真改，先观察 Agent 决策质量一周再放开。
3. **`guardExecute` 统一包装**：所有"自主/无人值守"执行都走它，自动施加熔断 + 影子 + 额度计数。

---

## 🔹 运行时抽象（注入式）

核心不 import 任何平台 API。外部依赖通过接口注入：

```ts
interface Storage {           // 熔断额度 / 影子开关 都存这
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
}
interface ActionExecutor {    // 真正的自愈动作由外部执行
  execute(tool: string, args: Record<string, any>): Promise<{ ok: boolean; summary: string; data?: unknown; error?: string }>;
}
interface ActionLogger {      // 护栏关键分支回调（可选）
  log?(level: string, kind: string, action: string, detail: string): void | Promise<void>;
}
```

### 🔹 内置适配器

| 适配器 | 导入 | 用途 | 依赖 |
|--------|------|------|------|
| `MemoryStorage` | `@mox/agent-core` | 本地开发 / 单测 / 演示 / 无状态冷启动 | 零依赖 |
| `NodeStorage` | `@mox/agent-core` | Node 服务 / CLI / 自托管，文件持久化 | 仅用 `node:fs`（**方法调用时才动态加载**，不影响 Workers 兼容性） |
| `D1Storage` | `@mox/agent-core` | Cloudflare D1 | Cloudflare 运行时 |

```ts
import { MemoryStorage, NodeStorage, D1Storage } from '@mox/agent-core';

// 本地 / 测试
const a = new MemoryStorage();

// Node 文件持久化（默认 ./agent-core.kv.json，可用 { file } 指定路径）
const b = new NodeStorage({ file: '/var/lib/agent/kv.json' });

// Cloudflare D1（表名/列名由你传入，核心不写死业务 schema）
const c = new D1Storage(env.DB, { table: 'agent_kv' });
```

### 🔹 写自己的 Storage 适配器

核心只认 `Storage` 接口。以 Redis 为例（完整模板见 `examples/custom-adapter.ts`）：

```ts
import type { Storage } from '@mox/agent-core';

class RedisStorage implements Storage {
  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = await redis.get(key);          // 你的后端读取
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  }
  async setJSON(key: string, value: unknown): Promise<void> {
    await redis.set(key, JSON.stringify(value));
  }
}
```

---

## 📚 完整 API 参考

### 🔹 元认知（`metacognition`）

| 导出 | 签名 | 说明 |
|------|------|------|
| `normalizeActions` | `(parsed: unknown) => Action[]` | 单对象/数组/空/非法 → 动作数组；过滤 `null`，空输入返回 `[]` |
| `buildThink` | `(reasoning: ThinkReasoning, text?: string) => ThinkAction` | 构造带四视角的 `think` 动作 |
| `buildReflect` | `(input) => ReflectAction` | 构造 `reflect`，`confidence` 自动夹紧到 `0..1` |
| `isThink` / `isReflect` | `(a: unknown) => a is ThinkAction / ReflectAction` | 类型守卫 |
| `missingPerspectives` | `(r?: ThinkReasoning) => Perspective[]` | 检出缺失的视角（用于引擎级把关） |
| `ReflectGate` | `class` | 闭环门：`afterMutation()` / `onReflect()` / `isPending` / `reset()` |
| `isMutationTier` | `(tier) => boolean` | `low` 之外都算变更（需反思闭环） |

### 🔹 护栏（`guardrails`）

| 导出 | 签名 | 说明 |
|------|------|------|
| `ToolTier` | `'low' \| 'mid' \| 'high'` | 工具风险级别类型 |
| `TierPolicy` | `{ [tool: string]: ToolTier }` | 工具→级别映射 |
| `defaultToolTier` / `defaultRemediationTier` | `TierPolicy` | 示例策略（**接入方须覆盖**） |
| `getToolTier` | `(policy, tool) => ToolTier` | 查级别，缺省 `'mid'` |
| `checkDailyGate` | `(deps, today?) => Promise<{blocked, remain, cap}>` | 单日熔断查询 |
| `bumpDailyGate` | `(deps, today?) => Promise<void>` | 计数 +1 |
| `isShadowMode` / `setShadowMode` | `(storage, key?) => Promise<boolean> / void` | 影子模式开关 |
| `guardExecute` | `(deps, action, args, opts?) => Promise<GuardResult>` | 统一护栏包装，自动熔断+影子+额度 |

`GuardResult`：`{ ok, summary, simulated, blocked?, data }`。

### 🔤 类型（`types`）

`ActionType`、`Action`、`ThinkAction`、`ReflectAction`、`CallAction`、`AnswerAction`、
`ThinkReasoning`、`Perspective`、`ReflectVerdict`、`Storage`、`ActionExecutor`、`ActionLogger`。

### 🔹 适配器（`adapters`）

`D1Storage` / `D1Like` / `D1StorageOptions` · `MemoryStorage` · `NodeStorage` / `NodeStorageOptions`。

---

## 🗺️ 进度表 / 路线图

| 模块 | 状态 | 说明 |
|------|------|------|
| 元认知协议引擎（think/reflect/normalizeActions/ReflectGate） | ✅ 已发布 | 0.1.0 起 |
| 分级护栏（工具分级 / 单日熔断 / 影子模式 / guardExecute） | ✅ 已发布 | 0.1.0 起 |
| Cloudflare D1 适配器 | ✅ 已发布 | 0.1.0 起 |
| 内存 Storage 适配器 `MemoryStorage` | ✅ **1.0.0 新增** | 本地开发 / 测试零依赖 |
| Node 文件 Storage 适配器 `NodeStorage` | ✅ **1.0.0 新增** | Node 服务零依赖持久化 |
| 可运行开发者示例 `examples/` | ✅ **1.0.0 新增** | quickstart / 自定义适配器模板 |
| 完整开发者文档 + API 参考 | ✅ **1.0.0 新增** | 本 README |
| npm 正式发布 | 🟡 待发布 | 配置已就绪，维护者 `npm publish` 即上线 |
| 更多官方适配器示例（Redis / Prisma / DynamoDB） | ⏳ 规划中 | 欢迎社区贡献 |
| 护栏指标 / 可观测性导出 | ⏳ 规划中 | `ActionLogger` 已留回调口 |

---

## ❓ 常见问题（FAQ）

**Q：真的能上 Cloudflare Workers 吗？**
能。`NodeStorage` 只在方法被调用时才动态 `import('node:fs')`，不用它就不会拉入 Node 依赖；`D1Storage` 走 `env.DB`。打包后无原生依赖。

**Q：单日熔断的"今天"怎么算？**
`checkDailyGate` / `bumpDailyGate` 接受 `today?` 与 `now?` 注入，便于测试与跨时区。默认用本地日期 `YYYY-MM-DD`。

**Q：高危动作会被自动执行吗？**
不会。`guardExecute` 只对 `mid`/`low` 生效；`high` 由上层批准门拦截，永远人工确认。

**Q：如何重置熔断 / 影子状态？**
直接通过 `Storage` 删掉对应键（`agent:gate` / `agent:shadow`）即可；`MemoryStorage` 提供 `clear()`。

---

## 🧪 测试

```bash
npm test      # esbuild 打包后用内存 Storage mock 跑，全部覆盖全路径
```

覆盖：① 动作归一化；② 工具分级；③ 单日熔断；④ 影子模式；⑤ guardExecute（熔断拦截 / 影子模拟 / 低危免额度 / 正常执行）；⑥ ReflectGate 闭环；⑦ think/reflect 构造与校验；⑧ MemoryStorage / NodeStorage 往返。

---

## 💖 支持我们

如果这个核心帮到了你，欢迎用以下方式支持项目持续维护：

- 💛 **爱发电（国内可用，首选）**：<https://afdian.com/a/cloudharbor> —— 国内可直接收款，点个赞助就是最大鼓励。
- ⭐ 在 GitHub 上 **Star** 本仓库，让更多人发现「可注入、可测试的元认知护栏」。
- 🐛 遇到 bug 或想提需求，欢迎开 **Issue** 或 **PR**。

> 注：GitHub Sponsors 暂不支持中国大陆地区（官方支持约 103 个地区，不含大陆，且需开启两步验证），故国内用户请走上面的爱发电通道。

## 📜 许可

MIT © mox / codecloud-dev
