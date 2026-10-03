/* @mox/agent-core 单元测试（node 直接跑，无需任何运行时）
 * 覆盖：① normalizeActions 动作数组归一化；② getToolTier；③ 单日熔断；
 *       ④ 影子模式；⑤ guardExecute（熔断拦截 / 影子模拟 / 低危免额度 / 正常执行）；
 *       ⑥ ReflectGate 闭环门；⑦ think/reflect 构造与校验。
 */
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (=' + JSON.stringify(b) + ')', a === b, 'got ' + JSON.stringify(a)); }

// —— 内存 Storage（测试用，不依赖任何平台）——
class MemStorage {
  constructor() { this.m = new Map(); }
  async getJSON(k) { const v = this.m.get(k); return v == null ? null : JSON.parse(v); }
  async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); }
}

// 用一个可控的执行器记录调用
function makeExecutor() {
  const calls = [];
  const executor = {
    calls,
    async execute(tool, args) {
      calls.push({ tool, args });
      return { ok: true, summary: `已执行 ${tool}`, data: { tool, args } };
    },
  };
  return executor;
}

const today = '2026-10-03';

(async () => {
  const m = require(path.join(__dirname, '..', '_bundle.cjs'));

  console.log('\n[1] normalizeActions —— 动作数组归一化');
  eq('单对象 → [对象]', m.normalizeActions({ action: 'think' }).length, 1);
  const batched = m.normalizeActions([{ action: 'think' }, { action: 'call', tool: 'diagnose', args: {} }]);
  eq('数组 [think,call] 解析出 2 个', batched.length, 2);
  eq('数组第1个 think', batched[0].action, 'think');
  eq('数组第2个 call（之前会被兜底吞掉）', batched[1].action, 'call');
  const mixed = m.normalizeActions([{ action: 'reflect' }, null, { action: 'answer', text: 'x' }]);
  eq('数组混 null 被过滤，保留 2 个', mixed.length, 2);
  eq('空数组 → []', m.normalizeActions([]).length, 0);
  eq('纯文本 → []（走兜底）', m.normalizeActions('不按协议来').length, 0);
  eq('null → []', m.normalizeActions(null).length, 0);

  console.log('\n[2] getToolTier —— 工具风险分级');
  eq('publish_notice → low', m.getToolTier(m.defaultToolTier, 'publish_notice'), 'low');
  eq('add_credits → mid', m.getToolTier(m.defaultToolTier, 'add_credits'), 'mid');
  eq('ban_user → high', m.getToolTier(m.defaultToolTier, 'ban_user'), 'high');
  eq('未知工具 → 默认 mid', m.getToolTier(m.defaultToolTier, 'something_new'), 'mid');
  eq('remediation: run_migration → mid', m.getToolTier(m.defaultRemediationTier, 'run_migration'), 'mid');
  eq('remediation: enable_fallback → low', m.getToolTier(m.defaultRemediationTier, 'enable_fallback'), 'low');

  console.log('\n[3] 单日熔断 checkDailyGate / bumpDailyGate');
  const store = new MemStorage();
  const bd = { storage: store, defaultCap: 30, now: () => new Date(today + 'T00:00:00Z') };
  let g = await m.checkDailyGate(bd, today);
  ok('初始未熔断', g.blocked === false, JSON.stringify(g));
  eq('初始剩余 = 上限 30', g.remain, 30);
  await m.bumpDailyGate(bd, today);
  g = await m.checkDailyGate(bd, today);
  eq('计数 +1 后剩余 = 29', g.remain, 29);
  for (let i = 0; i < 29; i++) await m.bumpDailyGate(bd, today);
  g = await m.checkDailyGate(bd, today);
  ok('达到上限后熔断', g.blocked === true, JSON.stringify(g));
  eq('熔断时剩余 = 0', g.remain, 0);

  console.log('\n[4] 影子模式 isShadowMode / setShadowMode');
  const store2 = new MemStorage();
  ok('默认非影子', (await m.isShadowMode(store2)) === false);
  await m.setShadowMode(store2, true);
  ok('开启后为影子', (await m.isShadowMode(store2)) === true);
  await m.setShadowMode(store2, false);
  ok('关闭后非影子', (await m.isShadowMode(store2)) === false);

  console.log('\n[5] guardExecute —— 熔断拦截分支');
  const store3 = new MemStorage();
  await store3.setJSON('agent:gate', { date: today, count: 30, cap: 30 });
  const exec3 = makeExecutor();
  const logs3 = [];
  const r1 = await m.guardExecute({ storage: store3, executor: exec3, logger: { log: (...a) => logs3.push(a) }, remediationTier: m.defaultRemediationTier }, 'disable_channel', { id: 5 });
  ok('熔断 blocked=true', r1.blocked === true, JSON.stringify(r1));
  ok('熔断不模拟、不成功执行', r1.simulated === false && r1.ok === false);
  ok('未调用执行器', exec3.calls.length === 0);
  ok('熔断分支记日志 agent_guard_block', logs3.length && logs3[0][1] === 'agent_guard_block', JSON.stringify(logs3));

  console.log('\n[6] guardExecute —— 影子模拟分支（中危只模拟不上报）');
  const store4 = new MemStorage();
  await m.setShadowMode(store4, true);
  const exec4 = makeExecutor();
  const r2 = await m.guardExecute({ storage: store4, executor: exec4, remediationTier: m.defaultRemediationTier }, 'disable_channel', { id: 7 });
  ok('影子模式 simulated=true', r2.simulated === true, JSON.stringify(r2));
  ok('影子模式 ok=true（仅模拟成功）', r2.ok === true);
  ok('影子模式未调用真执行器', exec4.calls.length === 0);
  const gate4 = await store4.getJSON('agent:gate');
  eq('影子模式不消耗熔断额度', (gate4 && gate4.count) || 0, 0);

  console.log('\n[7] guardExecute —— 低危自由自动（不消耗额度）+ 正常执行');
  const store5 = new MemStorage();
  const exec5 = makeExecutor();
  const r3 = await m.guardExecute({ storage: store5, executor: exec5, remediationTier: m.defaultRemediationTier }, 'enable_fallback', {});
  ok('低危执行返回结构化结果', typeof r3 === 'object' && 'ok' in r3);
  ok('低危调用了执行器', exec5.calls.length === 1);
  const gate5 = await store5.getJSON('agent:gate');
  eq('低危不消耗熔断额度', (gate5 && gate5.count) || 0, 0);

  const store6 = new MemStorage();
  const exec6 = makeExecutor();
  const r4 = await m.guardExecute({ storage: store6, executor: exec6, remediationTier: m.defaultRemediationTier }, 'run_migration', { id: 9 });
  ok('中危正常执行', r4.ok === true && r4.simulated === false);
  const gate6 = await store6.getJSON('agent:gate');
  eq('中危成功执行消耗 1 额度', gate6.count, 1);

  console.log('\n[8] ReflectGate —— 元认知闭环门');
  const gate = new m.ReflectGate();
  ok('初始不 pending', gate.isPending === false);
  gate.afterMutation();
  ok('变更后 pending=true', gate.isPending === true);
  gate.onReflect();
  ok('reflect 后 pending=false', gate.isPending === false);
  ok('低危不算变更', m.isMutationTier('low') === false);
  ok('中危算变更', m.isMutationTier('mid') === true);

  console.log('\n[9] think / reflect 构造与校验');
  const think = m.buildThink({ goal: 'g', assumptions: ['a'], checks: ['c'], perspectives: { 站长: 's', 用户: 'u', 安全: 'sec', 成本: 'c' } });
  eq('buildThink 类型', think.action, 'think');
  ok('isThink 识别', m.isThink(think));
  ok('isThink 拒绝非 think', m.isThink({ action: 'call' }) === false);
  eq('缺少视角检测出 0 个', m.missingPerspectives(think.reasoning).length, 0);
  eq('缺视角被检出', m.missingPerspectives({ goal: 'g', assumptions: [], checks: [], perspectives: { 站长: '', 用户: 'u', 安全: 's', 成本: 'c' } }).length, 1);
  const refl = m.buildReflect({ verdict: '可行', side_effects: ['x'], better_way: 'y', confidence: 1.5 });
  eq('confidence 夹紧到 1', refl.confidence, 1);
  ok('isReflect 识别', m.isReflect(refl));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
