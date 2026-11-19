// @mox/agent-core · 内存 Storage 适配器
// 零依赖、最快、最适合「本地开发 / 单测 / 演示 / 无状态 Serverless（每次冷启动独立）」。
// 进程内 Map 存储，进程退出即丢；需要持久化请看 NodeStorage（本地文件）或 D1Storage（Cloudflare D1）。

import type { Storage } from '../types';

export class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  // JS 单线程 + Map 的同步读改写本身即原子（没有 await），天然满足 CAS 语义。
  // 比较用 JSON 归一化后的字符串，容忍外部写入带空白的 JSON。
  async compareAndSwapJSON(key: string, expected: unknown, next: unknown): Promise<boolean> {
    const raw = this.store.get(key);
    let current: unknown = null;
    if (raw != null) {
      try { current = JSON.parse(raw); } catch { return false; } // 脏数据不参与 CAS
    }
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.store.set(key, JSON.stringify(next));
    return true;
  }

  /** 清空全部键值（仅供测试 / 重置场景使用） */
  clear(): void {
    this.store.clear();
  }
}
