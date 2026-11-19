/* @mox/agent-core 可靠性回归测试
 * 覆盖：① 单日额度按「本地日期」分桶；② 并发下熔断不被击穿（占位原子性）；
 *       ③ 执行失败退回占位；④ CAS 在 MemoryStorage / NodeStorage / D1Storage 上的行为。
 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (=' + JSON.stringify(b) + ')', a === b, 'got ' + JSON.stringify(a)); }

(async () => {
  const m = require(path.join(__dirname, '..', '_bundle.cjs'));
  const bundlePath = path.join(__dirname, '..', '_bundle.cjs');

  console.log('\n[R1] 单日额度按本地日期分桶（非 UTC）');
  {
    // 注入时刻：UTC 2026-10-03 20:00，上海本地已是 2026-10-04 04:00
    const now = () => new Date('2026-10-03T20:00:00Z');
    const store = new m.MemoryStorage();
    await m.bumpDailyGate({ storage: store, now });
    const g = await store.getJSON('agent:gate');
    const d = now();
    const p = (n) => String(n).padStart(2, '0');
    const localExpected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    eq('gate.date 等于注入时刻的本地日期', g.date, localExpected);

    // 再起一个子进程，钉死 TZ=Asia/Shanghai，断言必须落到 10-04（而非 UTC 的 10-03）
    const snippet = `
      const m = require(${JSON.stringify(bundlePath)});
      (async () => {
        const s = new m.MemoryStorage();
        await m.bumpDailyGate({ storage: s, now: () => new Date('2026-10-03T20:00:00Z') });
        process.stdout.write((await s.getJSON('agent:gate')).date);
      })();
    `;
    const out = execFileSync(process.execPath, ['-e', snippet], {
      env: { ...process.env, TZ: 'Asia/Shanghai' }, encoding: 'utf8',
    });
    eq('TZ=Asia/Shanghai 子进程日期 = 2026-10-04', out.trim(), '2026-10-04');
  }

  console.log('\n[R2] 并发熔断：cap=3 / 10 个并发请求，只能执行 3 个');
  {
    class SlowStore {
      constructor() { this.m = new Map(); }
      async getJSON(k) { const v = this.m.get(k); await new Promise(r => setTimeout(r, 3)); return v == null ? null : JSON.parse(v); }
      async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); }
    }
    const store = new SlowStore();
    let executed = 0;
    const deps = { storage: store, defaultCap: 3, executor: { async execute() { executed++; return { ok: true, summary: 'ok' }; } } };
    const results = await Promise.all(Array.from({ length: 10 }, () => m.guardExecute(deps, 'run_migration', {})));
    eq('真实执行次数 = cap', executed, 3);
    const gate = await store.getJSON('agent:gate');
    eq('gate.count = cap（不再只记到 1）', gate.count, 3);
    eq('放行 3 个 / 拦截 7 个', results.filter(r => r.ok).length, 3);
    eq('被拦截数 = 7', results.filter(r => r.blocked).length, 7);
  }

  console.log('\n[R3] 并发 + 自带 CAS 的 MemoryStorage');
  {
    const store = new m.MemoryStorage();
    let executed = 0;
    const deps = { storage: store, defaultCap: 5, executor: { async execute() { executed++; return { ok: true, summary: 'ok' }; } } };
    const results = await Promise.all(Array.from({ length: 20 }, () => m.guardExecute(deps, 'add_credits', {})));
    eq('执行次数 = cap', executed, 5);
    eq('gate.count = cap', (await store.getJSON('agent:gate')).count, 5);
    eq('拦截 15 个', results.filter(r => r.blocked).length, 15);
  }

  console.log('\n[R4] 执行失败退回占位（只有成功才计费）');
  {
    const store = new m.MemoryStorage();
    let executed = 0;
    const deps = { storage: store, defaultCap: 10, executor: { async execute() { executed++; return { ok: false, summary: 'fail' }; } } };
    for (let i = 0; i < 3; i++) await m.guardExecute(deps, 'run_migration', {});
    eq('失败动作仍被尝试 3 次', executed, 3);
    const g = await store.getJSON('agent:gate');
    eq('失败后额度被退回，count = 0', g && g.count, 0);
  }

  console.log('\n[R5] 各适配器 CAS 语义');
  {
    const mem = new m.MemoryStorage();
    ok('Memory: 缺失键 expected=null 成功写入', await mem.compareAndSwapJSON('k', null, { v: 1 }) === true);
    ok('Memory: 旧值不匹配时失败', await mem.compareAndSwapJSON('k', { v: 99 }, { v: 2 }) === false);
    ok('Memory: 旧值匹配时成功', await mem.compareAndSwapJSON('k', { v: 1 }, { v: 2 }) === true);
    eq('Memory: CAS 后值正确', (await mem.getJSON('k')).v, 2);

    const file = path.join(os.tmpdir(), 'agent-core-cas-' + Date.now() + '.json');
    const node = new m.NodeStorage({ file });
    ok('Node: 缺失键 expected=null 成功写入', await node.compareAndSwapJSON('k', null, { v: 1 }) === true);
    ok('Node: 旧值不匹配时失败', await node.compareAndSwapJSON('k', { v: 9 }, { v: 3 }) === false);
    ok('Node: 旧值匹配时成功', await node.compareAndSwapJSON('k', { v: 1 }, { v: 2 }) === true);
    eq('Node: CAS 后值正确', (await node.getJSON('k')).v, 2);
    fs.rmSync(file, { force: true });

    // D1Storage：用 spy 验证生成的 SQL 形态与 changes 解析（不依赖真实 D1）
    const calls = [];
    const d1 = {
      prepare(sql) {
        return { bind(...vals) { calls.push({ sql, vals }); return { run: async () => ({ changes: 1 }) }; } };
      },
    };
    const ds = new m.D1Storage(d1, { table: 'agent_kv' });
    ok('D1: 缺失键走 INSERT OR IGNORE', await ds.compareAndSwapJSON('k', null, { v: 1 }) === true);
    ok('D1: INSERT SQL 含 OR IGNORE', /INSERT OR IGNORE INTO agent_kv/.test(calls[calls.length - 1].sql));
    ok('D1: 有旧值走条件 UPDATE', await ds.compareAndSwapJSON('k', { v: 1 }, { v: 2 }) === true);
    ok('D1: UPDATE SQL 带值比较条件', /UPDATE agent_kv SET value = \? WHERE key = \? AND value = \?/.test(calls[calls.length - 1].sql));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
