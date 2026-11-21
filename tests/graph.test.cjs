/* @mox/agent-core 有状态图引擎测试
 * 覆盖：state-graph 路由 / reducer、checkpoint 链、HITL interrupt-resume、
 *       time-travel 分支、observability 事件、maxSteps 防循环、错误 checkpoint。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (=' + JSON.stringify(b) + ')', a === b, 'got ' + JSON.stringify(a)); }

(async () => {
  const m = require(path.join(__dirname, '..', '_bundle.cjs'));

  console.log('\n[G1] 线性 state-graph：reducer 浅合并 + 顺序执行');
  {
    const g = new m.StateGraph();
    g.addNode('a', (s) => ({ v: s.v + 1, log: [...(s.log || []), 'a'] }))
      .addNode('b', (s) => ({ v: s.v + 10, log: [...s.log, 'b'] }))
      .addEdge('a', 'b')
      .addEdge('b', '__end__')
      .setEntry('a');
    const run = await g.compile().invoke({ v: 0, log: [] });
    eq('status=done', run.status, 'done');
    eq('state.v = 11', run.state.v, 11);
    eq('log 顺序 a,b', run.state.log.join(','), 'a,b');
    eq('steps = 2', run.steps, 2);
  }

  console.log('\n[G2] 条件路由：根据 state 选分支');
  {
    const g = new m.StateGraph();
    g.addNode('route', (s) => ({ v: s.v }))
      .addNode('big', (s) => ({ path: 'big' }))
      .addNode('small', (s) => ({ path: 'small' }))
      .addConditionalEdge('route', (s) => (s.v > 5 ? 'big' : 'small'))
      .addEdge('big', '__end__')
      .addEdge('small', '__end__')
      .setEntry('route');
    const run1 = await g.compile().invoke({ v: 9 });
    eq('v=9 走 big', run1.state.path, 'big');
    const run2 = await g.compile().invoke({ v: 1 });
    eq('v=1 走 small', run2.state.path, 'small');
  }

  console.log('\n[G3] checkpoint 链：每步落盘、parentId 串联、可列出');
  {
    const g = new m.StateGraph();
    g.addNode('a', (s) => ({ v: s.v + 1 }))
      .addNode('b', (s) => ({ v: s.v + 1 }))
      .addEdge('a', 'b').addEdge('b', '__end__').setEntry('a');
    const cg = g.compile({ checkpointPrefix: 'test:g3:' });
    const run = await cg.invoke({ v: 0 });
    const cps = await cg.listCheckpoints();
    ok('checkpoint 数 >= 3（start 后每步 + done）', cps.length >= 3, 'got ' + cps.length);
    const last = await cg.getCheckpoint(run.checkpointId);
    eq('末态 checkpoint status=done', last.status, 'done');
    eq('末态 checkpoint state.v=2', last.state.v, 2);
    // parentId 链：除首节点外，每个 cp 的 parentId 都指向前一个
    let linked = true;
    for (let i = 1; i < cps.length; i++) if (cps[i].parentId !== cps[i - 1].id) linked = false;
    ok('parentId 串成完整链', linked);
  }

  console.log('\n[G4] HITL：interrupt 暂停 / resume 注入人工输入重跑');
  {
    const seen = [];
    const g = new m.StateGraph();
    g.addNode('ask', (s, ctx) => {
      seen.push({ step: ctx.step, resumed: ctx.resumed, resumeValue: ctx.resumeValue });
      if (!ctx.resumed) ctx.interrupt({ question: '批准加额度？' });
      return { approved: ctx.resumeValue, v: s.v + 1 };
    })
      .addNode('apply', (s) => ({ done: s.approved === true }))
      .addEdge('ask', 'apply').addEdge('apply', '__end__').setEntry('ask');
    const cg = g.compile({ checkpointPrefix: 'test:g4:' });
    const paused = await cg.invoke({ v: 0 });
    eq('暂停态 status=interrupted', paused.status, 'interrupted');
    eq('interrupt 载荷.question', paused.interrupt.payload.question, '批准加额度？');
    eq('暂停时未执行后续节点', paused.state.done, undefined);

    const resumed = await cg.resume(paused.checkpointId, true);
    eq('恢复后 status=done', resumed.status, 'done');
    eq('人工输入被节点读到', resumed.state.approved, true);
    eq('恢复后 v=1', resumed.state.v, 1);
    eq('apply 节点执行了', resumed.state.done, true);
    eq('首次 ctx.resumed=false', seen[0].resumed, false);
    eq('重跑 ctx.resumed=true', seen[1].resumed, true);
    eq('重跑读到 resumeValue=true', seen[1].resumeValue, true);
  }

  console.log('\n[G5] time-travel：从历史 checkpoint 用 stateOverride 分叉');
  {
    const g = new m.StateGraph();
    g.addNode('route', (s) => ({ v: s.v }))
      .addNode('left', () => ({ branch: 'left' }))
      .addNode('right', () => ({ branch: 'right' }))
      .addConditionalEdge('route', (s) => (s.v > 5 ? 'left' : 'right'))
      .addEdge('left', '__end__').addEdge('right', '__end__').setEntry('route');
    const cg = g.compile({ checkpointPrefix: 'test:g5:' });
    const first = await cg.invoke({ v: 9 });
    eq('原始走 left', first.state.branch, 'left');
    // 回到第一个 checkpoint（route 执行后），把 v 改小，应改走 right
    const cps = await cg.listCheckpoints();
    const forkBase = cps.find((c) => c.status === 'running' && c.node === 'route');
    ok('找到可回溯的 checkpoint', !!forkBase);
    const fork = await cg.invoke(undefined, { fromCheckpoint: forkBase.id, stateOverride: { v: 1 } });
    eq('分叉后走 right', fork.state.branch, 'right');
    eq('分叉 hold 原历史不变', first.state.branch, 'left');
  }

  console.log('\n[G6] observability：事件流完整且不因 observer 抛错中断');
  {
    const observed = [];
    const g = new m.StateGraph();
    g.addNode('a', (s) => ({ v: s.v + 1 })).addEdge('a', '__end__').setEntry('a');
    const cg = g.compile({
      checkpointPrefix: 'test:g6:',
      observer: (e) => { observed.push(e.type); if (e.type === 'node_start') throw new Error('observer boom'); },
    });
    const run = await cg.invoke({ v: 0 });
    eq('status=done（observer 抛错被吞）', run.status, 'done');
    ok('包含 start', run.events.some(e => e.type === 'start'));
    ok('包含 node_start / node_end', run.events.some(e => e.type === 'node_start') && run.events.some(e => e.type === 'node_end'));
    ok('包含 checkpoint', run.events.some(e => e.type === 'checkpoint'));
    ok('包含 end', run.events.some(e => e.type === 'end'));
    ok('observer 也收到事件（抛错前）', observed.includes('start'));
  }

  console.log('\n[G7] maxSteps 防自激循环');
  {
    const g = new m.StateGraph();
    g.addNode('loop', () => ({})).addEdge('loop', 'loop').setEntry('loop');
    const cg = g.compile({ checkpointPrefix: 'test:g7:', maxSteps: 3 });
    const run = await cg.invoke({});
    eq('status=error', run.status, 'error');
    ok('错误信息含 maxSteps', /maxSteps/.test(run.error), run.error);
    const cp = await cg.getCheckpoint(run.checkpointId);
    eq('错误也落了 checkpoint', cp.status, 'error');
  }

  console.log('\n[G8] 节点抛错 → 结构化 error checkpoint');
  {
    const g = new m.StateGraph();
    g.addNode('bad', () => { throw new Error('kaboom'); }).setEntry('bad');
    const cg = g.compile({ checkpointPrefix: 'test:g8:' });
    const run = await cg.invoke({});
    eq('status=error', run.status, 'error');
    eq('error 文案', run.error, 'kaboom');
  }

  console.log('\n[G9] checkpointer 可换 NodeStorage：跨实例恢复');
  {
    const os = require('os');
    const file = path.join(os.tmpdir(), 'agent-core-graph-' + Date.now() + '.json');
    const store1 = new m.NodeStorage({ file });
    const g = new m.StateGraph();
    g.addNode('a', (s) => ({ v: s.v + 1 })).addEdge('a', '__end__').setEntry('a');
    const cg1 = g.compile({ checkpointer: store1, checkpointPrefix: 'test:g9:' });
    const run = await cg1.invoke({ v: 0 });
    const store2 = new m.NodeStorage({ file });
    const cg2 = g.compile({ checkpointer: store2, checkpointPrefix: 'test:g9:' });
    const cp = await cg2.getCheckpoint(run.checkpointId);
    eq('新实例读到旧 checkpoint 的 state', cp.state.v, 1);
    const again = await cg2.invoke(undefined, { fromCheckpoint: run.checkpointId });
    eq('从 done checkpoint 续跑（无 next）仍 done', again.status, 'done');
    require('fs').rmSync(file, { force: true });
  }

  console.log('\n[G10] 构图期拦截静态边拼写错误（不再等 invoke 到一半才炸）');
  {
    const g = new m.StateGraph();
    g.addNode('a', () => ({})).addEdge('a', 'missing-node').setEntry('a');
    let msg = '';
    try { g.compile(); } catch (e) { msg = e.message; }
    ok('compile 抛错', !!msg, msg || '未抛错');
    ok('错误指出具体目标', /missing-node/.test(msg), msg);

    const g2 = new m.StateGraph();
    g2.addNode('a', () => ({})).addEdge('ghost', 'a').setEntry('a');
    let msg2 = '';
    try { g2.compile(); } catch (e) { msg2 = e.message; }
    ok('起点未注册也在构图期拦截', /ghost/.test(msg2), msg2 || '未抛错');

    const g3 = new m.StateGraph();
    g3.addNode('a', () => ({})).addEdge('a', '__end__').setEntry('a');
    ok('合法图仍可 compile', !!g3.compile());
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
