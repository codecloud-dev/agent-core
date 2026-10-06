# @mox/agent-core

通用 **Agent 核心**：把「元认知协议引擎」与「分级自主护栏」从具体项目里抽出来，做成**平台无关、可注入、可测试**的通用代码。适用于运维、研发、数据分析、内容生产等任何需要「会思考 + 可控自治」的 Agent 场景。

<p>
  <a href="README.md">中文</a> ·
  <a href="https://codecloud-dev.github.io/agent-core/">📖 文档站 Docs (中/EN 一键切换)</a>
</p>

> 设计理念：元认知不应该只是一句提示词，而应该是**真实跑在引擎里的架构**。于是推理链、执行后自检、工具风险分级、单日熔断、影子模式，都做成了可测试的结构化模块——平台无关，任何人都能 `npm i`（即将发布）或源码引入，用在自己的 Agent 上。

## 它解决什么

- **元认知可外显、可强制**：`think`（推理卡）/ `reflect`（自检卡）是结构化协议动作，引擎能渲染给人类看，并强制"变更后必须先 reflect 才能收尾"。
- **一次吐多个动作不再丢**：模型常把 `think` 和 `call` 打包成 `[{think},{call}]`，普通实现会整体落入兜底吞掉 `call`，导致"只思考不干事"。`normalizeActions` 把单对象/数组都归一化成动作数组。
- **分级自主护栏**：工具三级风险（low/mid/high）+ 单日自动变更熔断 + 影子模式（中危只模拟上报）。让"AI 拿权限"可控、可观测、可回滚。
- **零平台绑定**：不依赖 Cloudflare/Node/Vercel。存储、动作执行器、日志都通过接口注入。附 `D1Storage` 适配器直接上 CF。

## 安装

> ⚠️ **npm 包尚未发布**：`@mox/agent-core` 暂未推送到 npm registry（搜索返回 404）。
> 当前请走下面的「方式一：源码安装」；npm 安装方式将在正式发布后启用（即将发布）。

### 方式一：源码安装（当前可用）

```bash
git clone https://github.com/codecloud-dev/agent-core.git
cd agent-core
npm install                 # 仅拉取 esbuild 等开发依赖
# 打包成单文件（无原生依赖，可直接 require，也可上 Cloudflare Workers 等边缘运行时）
npx esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.cjs
```

### 方式二：npm 安装（即将发布）

```bash
npm i @mox/agent-core
```

需要打包到边缘运行时（Cloudflare Workers 等）时，用 esbuild/workerd 打包即可（无原生依赖）：

```bash
esbuild src/index.ts --bundle --format=esm --outfile=dist/index.js
```

## 快速开始

### 1. 元认知：归一化动作 + 闭环门

```ts
import { normalizeActions, ReflectGate, buildThink, buildReflect } from '@mox/agent-core';

// 模型可能返回单个对象，也可能返回数组（think+call 打包）
const actions = normalizeActions(parsedModelOutput); // Action[]
for (const a of actions) {
  if (a.action === 'think') renderReasonCard(a.reasoning);
  if (a.action === 'call')  runTool(a.tool, a.args);
  if (a.action === 'reflect') renderReflectCard(a);
  if (a.action === 'answer') send(a.text);
}

// 变更后强制反思闭环
const gate = new ReflectGate();
gate.afterMutation();        // 执行了 mid/high 工具后
// ... 收到 reflect 动作时：
gate.onReflect();
if (gate.isPending) reject('请先 reflect 再收尾'); // 驳回重做
```

### 2. 分级护栏：让自主执行可控

```ts
import { guardExecute, defaultRemediationTier, isShadowMode, checkDailyGate } from '@mox/agent-core';
import { D1Storage } from '@mox/agent-core/adapters/cloudflare';

const deps = {
  storage: new D1Storage(env.DB),   // 任何实现 Storage 的都行
  executor: {                       // 真正的自愈动作由你执行
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

## 核心概念

### 元认知动作协议

| 动作 | 含义 | 引擎职责 |
|------|------|----------|
| `think`  | 目标/假设/查证计划/四视角推理 | 渲染成「推理卡」给人类看 |
| `reflect`| 执行后自检（verdict/副作用/更优解/置信度） | 渲染成「自检卡」；`ReflectGate` 要求它在收尾前出现 |
| `call`   | 调工具（带 `why` 可见思考） | 中危走批准门，高危永远人工确认 |
| `answer` | 自然语言收尾 | 打字机输出 |

`think` 的 `perspectives` 固定四视角：`决策者 / 用户 / 安全 / 成本`——逼 Agent 每次决策都从这四个立场过一遍（拍板的人/受众/风险/资源）。

### 工具风险分级

```ts
type ToolTier = 'low' | 'mid' | 'high';
// low  —— 可逆/无影响（发公告、记记忆）→ 自主可自动
// mid  —— 有业务影响但可逆（加币/会员/调价/踢人）→ 需批准或影子模拟
// high —— 不可逆/高影响（退款/封禁）→ 永远人工确认，不在无人确认下自动执行
```

`defaultToolTier` / `defaultRemediationTier` 是示例策略，接入方**必须按自己业务覆盖**。

### 护栏三件套

1. **单日自动变更熔断**（`checkDailyGate`/`bumpDailyGate`）：防失控、防自激循环。状态存 `Storage`，跨请求持久。
2. **影子模式**（`isShadowMode`/`setShadowMode`）：开启后中危动作只模拟上报不真改，先观察 Agent 决策质量一周再放开。
3. **`guardExecute` 统一包装**：所有"自主/无人值守"执行都走它，自动施加熔断 + 影子 + 额度计数。

## 运行时抽象（注入式）

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

### Cloudflare 适配

`src/adapters/cloudflare.ts` 提供 `D1Storage`——表名与列名在构造时传入，核心不硬编码任何业务 schema。默认使用中立的 `kv_store` 表（`key TEXT PRIMARY KEY, value TEXT`）：

```sql
CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT);
```

```ts
import { D1Storage } from '@mox/agent-core';
const storage = new D1Storage(env.DB, { table: 'agent_kv' }); // 用你自己的表
```

其余护栏 / 元认知逻辑完全平台无关。换 Node/Vercel 只需实现自己的 `Storage`（如 `node:keyvalue` / Redis / Prisma）。

## 测试

```bash
npm test      # esbuild 打包后用内存 Storage mock 跑，47 项覆盖全路径
```

## 支持我们

如果这个核心帮到了你，欢迎用以下方式支持项目持续维护：

- 💛 **爱发电（国内可用，首选）**：<https://afdian.com/a/cloudharbor> —— 国内可直接收款，点个赞助就是最大鼓励。
- ⭐ 在 GitHub 上 **Star** 本仓库，让更多人发现「可注入、可测试的元认知护栏」。
- 🐛 遇到 bug 或想提需求，欢迎开 **Issue** 或 **PR**。

> 注：GitHub Sponsors 暂不支持中国大陆地区（官方支持约 103 个地区，不含大陆，且需开启两步验证），故国内用户请走上面的爱发电通道。

## 许可

MIT © mox / codecloud-dev
