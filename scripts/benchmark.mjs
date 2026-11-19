// agent-core 真实基准：不依赖 mock 计时，全部跑 dist 里的真实实现。
// 用法：npm run build && node scripts/benchmark.mjs [steps]
// 输出：人类可读表格 + 一行 JSON，便于 CI / 文档引用。
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ac from '../dist/index.js';

const N = Math.max(10, parseInt(process.argv[2] || '200', 10) || 200);
const ms = (t) => Number((performance.now() - t).toFixed(2));
const rate = (n, ms) => Number((n / (ms / 1000)).toFixed(1));

// ---- 1) 有状态图：N 个节点的线性图，每步都落 checkpoint（MemoryStorage） ----
function buildChainGraph() {
  const g = new ac.StateGraph();
  for (let i = 0; i < N; i++) {
    g.addNode(`n${i}`, (s) => ({ v: s.v + 1 }));
    if (i < N - 1) g.addEdge(`n${i}`, `n${i + 1}`);
  }
  g.addEdge(`n${N - 1}`, '__end__').setEntry('n0');
  return g;
}

// 预热用独立前缀/独立实例，避免把预热产生的 checkpoint 混进被测统计
const warmup = buildChainGraph().compile({ checkpointPrefix: 'bench:warmup:', maxSteps: N + 5 });
await warmup.invoke({ v: 0 });
const chain = buildChainGraph().compile({ checkpointPrefix: 'bench:graph:', maxSteps: N + 5 });
let t = performance.now();
const graphRun = await chain.invoke({ v: 0 });
const graphMs = ms(t);
const cps = await chain.listCheckpoints();
const graphRate = rate(graphRun.steps, graphMs);

// ---- 2) checkpoint 原始吞吐：MemoryStorage 读写 N 个快照 ----
const mem = new ac.MemoryStorage();
t = performance.now();
for (let i = 0; i < N; i++) await mem.setJSON(`bench:cp:${i}`, { id: i, step: i, state: { v: i }, next: [] });
const memWriteMs = ms(t);
t = performance.now();
for (let i = 0; i < N; i++) await mem.getJSON(`bench:cp:${i}`);
const memReadMs = ms(t);

// ---- 3) NodeStorage（真实文件 IO）读写 N 个快照 ----
const dir = mkdtempSync(join(tmpdir(), 'agent-core-bench-'));
const node = new ac.NodeStorage({ file: join(dir, 'kv.json') });
t = performance.now();
for (let i = 0; i < N; i++) await node.setJSON(`bench:cp:${i}`, { id: i, step: i, state: { v: i } });
const nodeWriteMs = ms(t);
t = performance.now();
for (let i = 0; i < N; i++) await node.getJSON(`bench:cp:${i}`);
const nodeReadMs = ms(t);

// 同一文件后端，关闭逐条落盘、批量写完一次性 flush 的对比
const batchNode = new ac.NodeStorage({ file: join(dir, 'batch.json'), autosync: false });
t = performance.now();
for (let i = 0; i < N; i++) await batchNode.setJSON(`bench:cp:${i}`, { id: i, step: i, state: { v: i } });
await batchNode.flush();
const nodeBatchMs = ms(t);
rmSync(dir, { recursive: true, force: true });

// ---- 4) guardExecute（并发占位 + CAS）吞吐 ----
const gstore = new ac.MemoryStorage();
const deps = {
  storage: gstore, defaultCap: N * 2,
  executor: { async execute() { return { ok: true, summary: 'ok' }; } },
};
t = performance.now();
await Promise.all(Array.from({ length: N }, () => mGuard(deps)));
const guardMs = ms(t);
async function mGuard(d) { return ac.guardExecute(d, 'add_credits', { uid: 1 }); }

const result = {
  steps: N,
  graph: { ms: graphMs, stepsPerSec: graphRate, checkpoints: cps.length },
  memory: {
    writeMs: memWriteMs, readMs: memReadMs,
    writesPerSec: rate(N, memWriteMs), readsPerSec: rate(N, memReadMs),
  },
  nodeFile: {
    writeMs: nodeWriteMs, readMs: nodeReadMs, batchFlushMs: nodeBatchMs,
    writesPerSec: rate(N, nodeWriteMs), readsPerSec: rate(N, nodeReadMs),
    batchWritesPerSec: rate(N, nodeBatchMs),
  },
  guard: { ms: guardMs, opsPerSec: rate(N, guardMs) },
  node: process.version,
};

console.log('\n=== agent-core 真实基准 (dist, node ' + process.version + ', N=' + N + ') ===');
console.log(`StateGraph ${graphRun.steps} 步 / ${cps.length} checkpoint : ${graphMs} ms  (${graphRate} steps/s)`);
console.log(`MemoryStorage  写 ${memWriteMs} ms (${result.memory.writesPerSec}/s) · 读 ${memReadMs} ms (${result.memory.readsPerSec}/s)`);
console.log(`NodeStorage    写 ${nodeWriteMs} ms (${result.nodeFile.writesPerSec}/s) · 读 ${nodeReadMs} ms (${result.nodeFile.readsPerSec}/s)`);
console.log(`NodeStorage    批量写+flush ${nodeBatchMs} ms (${result.nodeFile.batchWritesPerSec}/s，比逐条落盘快 ${(nodeWriteMs / nodeBatchMs).toFixed(1)}x)`);
console.log(`guardExecute   ${guardMs} ms (${result.guard.opsPerSec} ops/s, 并发占位+CAS)`);
console.log('JSON ' + JSON.stringify(result));
