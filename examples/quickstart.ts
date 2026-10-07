/**
 * @mox/agent-core · 开发者快速上手示例
 *
 * 运行方式（任选其一）：
 *   npx tsx examples/quickstart.ts
 *   # 或先打包再跑：
 *   npm run build && node -e "require('./dist/index.cjs')"
 *
 * 演示：用零依赖的 MemoryStorage 在本地跑通「元认知闭环 + 分级护栏」，
 * 不依赖任何云平台——几行就能把「会思考 + 可控自治」装进你自己的 Agent。
 */
import {
  normalizeActions,
  buildThink,
  buildReflect,
  ReflectGate,
  guardExecute,
  defaultRemediationTier,
  MemoryStorage,
} from '../src/index';
import type { ActionExecutor } from '../src/index';

async function main(): Promise<void> {
  const storage = new MemoryStorage();

  const executor: ActionExecutor = {
    async execute(tool: string, args: Record<string, unknown>) {
      console.log(`  ↳ 执行工具 ${tool}`, args);
      return { ok: true, summary: `已执行 ${tool}`, data: { tool, args } };
    },
  };

  // 1) 模型输出常一次吐多个动作，先归一化成动作数组
  const modelOutput = [
    buildThink({
      goal: '给用户 42 号补偿 100 额度',
      assumptions: ['用户已实名'],
      checks: ['余额充足'],
      perspectives: {
        决策者: '提升留存',
        用户: '体验更好',
        安全: '额度可控',
        成本: '成本可忽略',
      },
    }),
    { action: 'call', tool: 'add_credits', args: { uid: 42, amount: 100 }, why: '补偿活动' },
  ];
  const actions = normalizeActions(modelOutput);
  console.log(`归一化出 ${actions.length} 个动作`);

  // 2) 变更类动作走护栏，并强制「先 reflect 再收尾」
  const gate = new ReflectGate();
  for (const a of actions) {
    if (a.action === 'call') {
      const res = await guardExecute(
        { storage, executor, remediationTier: defaultRemediationTier },
        a.tool,
        a.args,
      );
      console.log('  护栏结果:', res.summary);
      gate.afterMutation();
    }
  }

  // 3) 收尾前必须 reflect（闭环规则：先自检，再收尾）
  const reflect = buildReflect({
    verdict: '可行',
    side_effects: ['额度 +100'],
    better_way: '可加单用户风控上限',
    confidence: 0.9,
  });
  if (gate.isPending && reflect.action === 'reflect') gate.onReflect();
  console.log('闭环完成，可安全 answer。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
