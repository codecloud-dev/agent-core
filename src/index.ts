// @mox/agent-core · 公共出口
export * from './types';
export * from './metacognition';
export * from './guardrails';
// 适配器（平台相关，按需引入；核心逻辑本身不依赖任何平台）
export { D1Storage, type D1Like, type D1StorageOptions } from './adapters/cloudflare';
