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

// 「今天」必须是运行地的本地日期，而不是 UTC 日期。
// 用 toISOString().slice(0,10) 会让 UTC+8 用户在每天 08:00（而非 00:00）就跨到下一天的额度桶，
// 与文档承诺的「本地日期 / 每天午夜重置」不符。这里用本地年月日分量拼装。
function todayStr(now?: () => Date): string {
  const d = now ? now() : new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function freshGate(cap: number, t: string): GateState {
  return { date: t, count: 0, cap };
}

// 存储里的 gate 可能是脏数据（损坏 / 被外部改写 / 旧版本格式），
// 不校验会让 count/cap 参与比较时产生 NaN 或字符串运算，导致熔失效。
function readGate(raw: unknown, cap: number, t: string): GateState {
  if (raw && typeof raw === 'object') {
    const g = raw as Partial<GateState>;
    if (
      g.date === t &&
      typeof g.count === 'number' && Number.isFinite(g.count) &&
      typeof g.cap === 'number' && Number.isFinite(g.cap)
    ) {
      return { date: g.date, count: g.count, cap: g.cap };
    }
  }
  return freshGate(cap, t);
}

// ============ 并发安全的额度领取 ============
// 原来的 checkDailyGate → bumpDailyGate 两步非原子：多个并发请求可能同时读到
// count=cap-1、同时放行、同时执行，把「单日熔断」整个击穿（实测 cap=3 并发 10 次
// 全部执行、gate.count 只记到 1）。这里改为先「占位」再执行：
//   claimGateSlot 原子地读-判-加一，失败（已满）直接拦截；
//   执行失败再 releaseGateSlot 退回占位，保持「只有成功的中/高危才计费」的语义。
//
// 两层保障：
//   1) 进程内按 (storage, key) 的互斥锁 —— 对任何自定义 Storage 都生效；
//   2) Storage.compareAndSwapJSON（若适配器实现）—— 跨进程 / 跨 Worker 的原子性。
const gateLocks = new WeakMap<object, Map<string, Promise<unknown>>>();

function withGateLock<T>(storage: object, key: string, fn: () => Promise<T>): Promise<T> {
  let locks = gateLocks.get(storage);
  if (!locks) { locks = new Map(); gateLocks.set(storage, locks); }
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前一个失败也要继续，避免锁链被 rejected promise 毒化
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  // 链尾清理，防止长期运行下 Map 里堆积已完成的 key
  tail.then(() => { if (locks!.get(key) === tail) locks!.delete(key); });
  return run;
}

export interface GateClaim { blocked: boolean; gate: GateState; }

async function claimGateSlot(deps: BreakerDeps, t: string): Promise<GateClaim> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  return withGateLock(deps.storage, key, async () => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const raw = await deps.storage.getJSON<GateState>(key);
      const state = readGate(raw, cap, t);
      if (state.count >= state.cap) return { blocked: true, gate: state };
      const next: GateState = { ...state, count: state.count + 1 };
      if (deps.storage.compareAndSwapJSON) {
        if (await deps.storage.compareAndSwapJSON(key, raw, next)) {
          return { blocked: false, gate: next };
        }
        continue; // 别的写入者抢先了，重读再判
      }
      // 无 CAS 的自定义适配器：进程内锁已保证此读改写互斥
      await deps.storage.setJSON(key, next);
      return { blocked: false, gate: next };
    }
    throw new Error('agent-core: 额度领取 CAS 连续冲突，已放弃（请检查 Storage 实现）');
  });
}

// 执行失败时把占位退回。仍走同一把锁，且与 claim 一样用 CAS 重试避免丢更新。
async function releaseGateSlot(deps: BreakerDeps, t: string): Promise<void> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  await withGateLock(deps.storage, key, async () => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const raw = await deps.storage.getJSON<GateState>(key);
      const state = readGate(raw, cap, t);
      const next: GateState = { ...state, count: Math.max(0, state.count - 1) };
      if (deps.storage.compareAndSwapJSON) {
        if (await deps.storage.compareAndSwapJSON(key, raw, next)) return;
        continue;
      }
      await deps.storage.setJSON(key, next);
      return;
    }
  });
}

export async function checkDailyGate(
  deps: BreakerDeps,
  today?: string,
): Promise<{ blocked: boolean; remain: number; cap: number }> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  const t = today || todayStr(deps.now);
  const raw = await deps.storage.getJSON<GateState>(key);
  const state = readGate(raw, cap, t);
  return { blocked: state.count >= state.cap, remain: Math.max(0, state.cap - state.count), cap: state.cap };
}

export async function bumpDailyGate(deps: BreakerDeps, today?: string): Promise<void> {
  const key = deps.gateKey || 'agent:gate';
  const cap = deps.defaultCap ?? 30;
  const t = today || todayStr(deps.now);
  const raw = await deps.storage.getJSON<GateState>(key);
  const state = readGate(raw, cap, t);
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

// 可观测回调（logger）失败不应中断护栏主流程——否则一次日志故障
// 会让熔断拦截 / 影子模拟分支抛错，调用方拿不到结构化结果。
function safeLog(deps: GuardDeps, level: string, kind: string, action: string, detail: string): void {
  try {
    const r = deps.logger?.log?.(level, kind, action, detail);
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch(() => {});
    }
  } catch {
    // 忽略日志回调异常
  }
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
  const t = todayStr(deps.now);

  // 先只读判一次，保持原有分支优先级（熔断优先于影子模拟）与日志语义。
  const gate = await checkDailyGate(deps, t);
  const blockedResult = (g: { cap: number; remain: number }): GuardResult => {
    safeLog(deps, 'guard', 'agent_guard_block', action, JSON.stringify({ cap: g.cap, note: '单日自动变更额度耗尽，已暂停自动执行' }));
    return {
      ok: false,
      summary: `今日自动变更额度已用尽（上限 ${g.cap}），已暂停自动执行并告警——请人工确认或次日再放开`,
      simulated: false,
      blocked: true,
      data: { gate: { blocked: true, remain: g.remain, cap: g.cap } },
    };
  };
  if (gate.blocked) return blockedResult(gate);

  const shadow = await isShadowMode(deps.storage);
  if (shadow && tier === 'mid') {
    safeLog(deps, 'guard', 'agent_shadow_sim', action, JSON.stringify({ action, args, note: '影子模式：仅模拟，未执行' }));
    return {
      ok: true,
      summary: `【影子模式·仅模拟】拟执行 ${action}（未真实改动），预期影响已记录待你复核`,
      simulated: true,
      data: { action, args },
    };
  }

  // 真正执行前原子占位：并发请求里只有抢到额度的才会调用执行器。
  // 低危动作不计费，也不需要占位。
  let claimed = false;
  if (tier !== 'low') {
    const claim = await claimGateSlot(deps, t);
    if (claim.blocked) {
      return blockedResult({ cap: claim.gate.cap, remain: Math.max(0, claim.gate.cap - claim.gate.count) });
    }
    claimed = true;
  }

  // 执行器抛错时转为结构化失败结果（与 ActionExecutor 契约的 {ok:false} 对齐），
  // 不让异常穿透护栏冒泡给调用方。失败则退回占位，保持「只有成功的中/高危才计费」。
  let r: Awaited<ReturnType<ActionExecutor['execute']>>;
  try {
    r = await deps.executor.execute(action, args);
  } catch (e) {
    if (claimed) await releaseGateSlot(deps, t);
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, summary: `执行 ${action} 时出错：${msg}`, simulated: false, data: null };
  }
  if (claimed && !r.ok) await releaseGateSlot(deps, t);
  return { ok: r.ok, summary: r.summary, simulated: false, data: r.data ?? null };
}
