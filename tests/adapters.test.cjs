/* @mox/agent-core 适配器测试：MemoryStorage / NodeStorage 往返 + 命名空间隔离
 * 运行：随 tests/run.sh 一起执行（会先 esbuild 打包出 _bundle.cjs）
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name + ' (=' + JSON.stringify(b) + ')', a === b, 'got ' + JSON.stringify(a)); }

(async () => {
  const m = require(path.join(__dirname, '..', '_bundle.cjs'));

  console.log('\n[A] MemoryStorage —— 内存往返');
  const mem = new m.MemoryStorage();
  eq('初始 getJSON → null', await mem.getJSON('k'), null);
  await mem.setJSON('k', { a: 1, b: [1, 2] });
  const v = await mem.getJSON('k');
  ok('存入对象可取回', v && v.a === 1, JSON.stringify(v));
  ok('数组结构保持', v && v.b.length === 2);
  await mem.setJSON('k', null);
  eq('可存 null 并取回 null', await mem.getJSON('k'), null);

  console.log('\n[B] NodeStorage —— 文件持久化往返');
  const file = path.join(os.tmpdir(), 'agent-core-kv-' + Date.now() + '.json');
  const n1 = new m.NodeStorage({ file });
  eq('初始 null', await n1.getJSON('x'), null);
  await n1.setJSON('x', { ok: true, n: 42 });
  eq('写入可取回', (await n1.getJSON('x')).n, 42);
  const n2 = new m.NodeStorage({ file });
  eq('跨实例读取持久化值', (await n2.getJSON('x')).ok, true);
  await n2.setJSON('y', 'hello');
  const n3 = new m.NodeStorage({ file });
  eq('持久化的第二个键可取回', (await n3.getJSON('y')), 'hello');
  fs.rmSync(file, { force: true });

  console.log('\n[C] 命名空间隔离');
  const a = new m.MemoryStorage();
  const b = new m.MemoryStorage();
  await a.setJSON('same', 1);
  eq('不同实例互不干扰', await b.getJSON('same'), null);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
