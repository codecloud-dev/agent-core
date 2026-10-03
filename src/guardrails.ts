// @mox/agent-core · 分级自主护栏
// 工具三级风险 + 单日熔断 + 影子模式。逻辑平台无关，状态存注入的 Storage。

import type { Storage, ActionExecutor, ActionLogger } from './types';

export type ToolTier = 'low' | 'mid' | 'high';

// 工具风险分级策略（示例，接入方务必按自己业务覆盖）：
//   low  —— 低危：可逆 / 无业务影响（发公告、记记忆）。自主模式可自动执行。
//   mid  —— 中危：有业务影响但可逆（加币 / 会员 / 调价 / 踢人 / 启停渠道）。需批准或影子模拟。
//   high —— 高危：不可逆或高影响（退款 / 封禁）。永远需人工确认，不在无人确认下自动执行。
export interface TierPolicy { [tool: string]: ToolTier }

export const defaultToolTier: TierPolicy = {
  publish_notice: 'low',
  memory_save: 'low',
  memory_delete: 'low',
  memory_search: 'low',
  add_credits: 'mid',
  grant_membership: 'mid',
  cancel_membership: 'mid',
  set_pricing: 'mid',
  revoke_sessions: 'mid',
  unban_user: 'mid',
  enable_channel: 'mid',
  execute_action: 'mid',
  ban_user: 'high',
  remove_credits: 'high',
};

// 自愈动作（action 子字段）的风险分级。
export const defaultRemediationTier: TierPolicy = {
  publish_incident_notice: 'low',
  enable_fallback: 'low',
  retry_migration_check: 'low',
  clear_health_alarm: 'low',
  run_migration: 'mid',
  disable_channel: 'mid',
  enable_channel: 'mid',
  revoke_sessions: 'mid',
};

export function getToolTier(policy: TierPolicy, tool: string): ToolTier {
  return policy[tool] || 'mid';
}

// ============ 护栏 1：单日自动变更熔断（防失控 / 防自激循环） ============
export interface GateState { date: string; count: number; cap: number; }

export interface BreakerDeps {
  storage: Storage;
  gateKey?: string;       // 默认 'agent:gate'
  defaultCap?: number;    // 默认 30
  now?: () => Date;       // 可注入（测试 / 跨时区）
}

function todayStr(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString().slice(0, 10);
}

function freshGate(cap: number, t: string): GateState {
  return { date: t, count: 0, cap };
}

export async function checkDailyGate(
  deps: BreakerDeps,
  today?: string,
): Promise<{ blocked: boolean; remain: number; cap: number }> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  const t = today || todayStr(deps.now);
  const raw = await deps.storage.getJSON<GateState>(key);
  const state: GateState = !raw || raw.date !== t ? freshGate(cap, t) : raw;
  return { blocked: state.count >= state.cap, remain: Math.max(0, state.cap - state.count), cap: state.cap };
}

export async function bumpDailyGate(deps: BreakerDeps, today?: string): Promise<void> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  const t = today || todayStr(deps.now);
  const raw = await deps.storage.getJSON<GateState>(key);
  const state: GateState = !raw || raw.date !== t ? freshGate(cap, t) : raw;
  state.count += 1;
  await deps.storage.setJSON(key, state);
}

// ============ 护栏 2：影子模式（中危只模拟不上报，先观察 Agent 决策质量） ============
export async function isShadowMode(storage: Storage, key = 'agent:shadow'): Promise<boolean> {
  return (await storage.getJSON<string>(key)) === '1';
}

export async function setShadowMode(storage: Storage, on: boolean, key = 'agent:shadow'): Promise<void> {
  await storage.setJSON(key, on ? '1' : '0');
}

// ============ 护栏执行包装：所有「自主 / 无人值守」执行都走这里 ============
export interface GuardDeps extends BreakerDeps {
  executor: ActionExecutor;
  logger?: ActionLogger;
  remediationTier?: TierPolicy; // 判断 action 子字段风险级；缺省视为 'mid'
}

export interface GuardResult {
  ok: boolean;
  summary: string;
  simulated: boolean;
  blocked?: boolean;
  data: unknown;
}

// ① 单日自动变更熔断：超上限即停并告警。
// ② 影子模式：中危动作只模拟上报、不真改。
// ③ 仅中危成功执行计入额度；低危自由自动；高危动作根本到不了执行器（由上层批准门拦截）。
export async function guardExecute(
  deps: GuardDeps,
  action: string,
  args: Record<string, any>,
  opts?: { tier?: ToolTier },
): Promise<GuardResult> {
  const tier: ToolTier = opts?.tier || deps.remediationTier?.[action] || 'mid';

  const gate = await checkDailyGate(deps);
  if (gate.blocked) {
    deps.logger?.log?.('guard', 'agent_guard_block', action, JSON.stringify({ cap: gate.cap, note: '单日自动变更额度耗尽，已暂停自动执行' }));
    return {
      ok: false,
      summary: `今日自动变更额度已用尽（上限 ${gate.cap}），已暂停自动执行并告警——请人工确认或次日再放开`,
      simulated: false,
      blocked: true,
      data: { gate },
    };
  }

  const shadow = await isShadowMode(deps.storage);
  if (shadow && tier === 'mid') {
    deps.logger?.log?.('guard', 'agent_shadow_sim', action, JSON.stringify({ action, args, note: '影子模式：仅模拟，未执行' }));
    return {
      ok: true,
      summary: `【影子模式·仅模拟】拟执行 ${action}（未真实改动），预期影响已记录待你复核`,
      simulated: true,
      data: { action, args },
    };
  }

  const r = await deps.executor.execute(action, args);
  if (r.ok && tier !== 'low') await bumpDailyGate(deps);
  return { ok: r.ok, summary: r.summary, simulated: false, data: r.data ?? null };
}
