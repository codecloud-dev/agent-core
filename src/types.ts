// @mox/agent-core · 核心类型与运行时抽象接口
// 设计原则：核心不依赖任何平台（Cloudflare / Node / Vercel 等），所有外部依赖通过接口注入。

// ============ 元认知动作协议 ============
// 任何自主 Agent 都能复用这套结构化动作：think 外显推理、reflect 执行后自检、
// call 调工具、answer 收尾。引擎（流式循环）负责按这些动作驱动，并把 think/reflect
// 渲染成人类可读的「推理卡 / 自检卡」。

export type ActionType = 'think' | 'reflect' | 'call' | 'answer';

export type Perspective = '站长' | '用户' | '安全' | '成本';

export interface ThinkReasoning {
  goal: string;
  assumptions: string[];
  checks: string[];
  perspectives: Record<Perspective, string>;
}

export interface ThinkAction {
  action: 'think';
  reasoning: ThinkReasoning;
  text?: string;
}

export type ReflectVerdict = '可行' | '需改' | '放弃';

export interface ReflectAction {
  action: 'reflect';
  verdict: ReflectVerdict | string;
  side_effects: string[];
  better_way: string;
  confidence: number; // 0..1
}

export interface CallAction {
  action: 'call';
  tool: string;
  args: Record<string, any>;
  why?: string;
}

export interface AnswerAction {
  action: 'answer';
  text: string;
  why?: string;
}

export type Action = ThinkAction | ReflectAction | CallAction | AnswerAction;

// ============ 运行时抽象（注入式，平台无关） ============

// 键值存储：护栏的「单日熔断额度」「影子模式开关」都存这里。任何 KV / 数据库都能实现。
export interface Storage {
  getJSON<T = unknown>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
}

// 动作执行器：护栏只负责「何时允许 / 何时模拟」，真正的自愈动作由外部执行。
export interface ActionExecutor {
  execute(tool: string, args: Record<string, any>): Promise<{
    ok: boolean;
    summary: string;
    data?: unknown;
    error?: string;
  }>;
}

// 审计日志（可选）：护栏的关键分支（熔断拦截 / 影子模拟）会回调，便于可观测。
export interface ActionLogger {
  log?(level: string, kind: string, action: string, detail: string): void | Promise<void>;
}
