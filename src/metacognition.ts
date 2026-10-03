// @mox/agent-core · 元认知引擎
// 把「思考链 + 执行后自检」做成真实可复用的协议，而不是一句提示词。

import type { Action, ThinkAction, ReflectAction, ThinkReasoning, Perspective } from './types';

// 归一化模型输出为「动作数组」：兼容「单个动作对象」与「一次吐多个动作的 JSON 数组」。
// 模型偶尔把 think 与随后的 call 打包成 [{think},{call}]；不支持数组会让数组整体
// 既非已知 action 也非原子对象，落入兜底吞掉后续动作（如 call），导致「只思考不干事」。
// 空 / 非法输入返回 []（交给引擎走兜底）。
export function normalizeActions(parsed: unknown): Action[] {
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed.filter((a) => a != null && typeof a === 'object') as Action[];
  if (typeof parsed === 'object') return [parsed as Action];
  return [];
}

const PERSPECTIVES: Perspective[] = ['决策者', '用户', '安全', '成本'];

// 构造 think 动作（带四视角推理骨架）。
export function buildThink(reasoning: ThinkReasoning, text?: string): ThinkAction {
  return { action: 'think', reasoning, ...(text ? { text } : {}) };
}

// 构造 reflect 动作（执行后自检）。confidence 自动夹紧到 0..1。
export function buildReflect(input: {
  verdict: ReflectAction['verdict'];
  side_effects?: string[];
  better_way?: string;
  confidence: number;
}): ReflectAction {
  return {
    action: 'reflect',
    verdict: input.verdict,
    side_effects: input.side_effects ?? [],
    better_way: input.better_way ?? '',
    confidence: Math.max(0, Math.min(1, input.confidence)),
  };
}

export function isThink(a: unknown): a is ThinkAction {
  return !!a && typeof a === 'object' && (a as any).action === 'think' && !!(a as any).reasoning;
}

export function isReflect(a: unknown): a is ReflectAction {
  return !!a && typeof a === 'object' && (a as any).action === 'reflect';
}

// 校验四视角是否齐全（缺视角说明元认知没跑满，可用于引擎级把关）。
export function missingPerspectives(r: ThinkReasoning | undefined): Perspective[] {
  if (!r || !r.perspectives) return [...PERSPECTIVES];
  return PERSPECTIVES.filter((p) => !r.perspectives[p] || !String(r.perspectives[p]).trim());
}

// 元认知闭环门：变更类动作执行后必须先 reflect 才能收尾。
// 用法（在你的流式循环里）：
//   - 执行 mid/high 工具成功后 gate.afterMutation()
//   - 收到 reflect 动作时 gate.onReflect()
//   - 准备 answer 前若 gate.isPending → 驳回重做（闭环规则：先自检，再收尾）
export class ReflectGate {
  private pending = false;
  afterMutation(): void { this.pending = true; }
  onReflect(): void { this.pending = false; }
  get isPending(): boolean { return this.pending; }
  reset(): void { this.pending = false; }
}

// 工具风险分级 → 是否算「变更」（需要反思闭环）。低危可逆不算。
export function isMutationTier(tier: 'low' | 'mid' | 'high'): boolean {
  return tier !== 'low';
}
