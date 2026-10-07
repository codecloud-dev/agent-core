// @mox/agent-core · Node 文件 Storage 适配器
// 用 node:fs 把键值持久化到本地 JSON 文件——零三方依赖，适合 Node 服务 / CLI / 自托管。
//
// 兼容性说明：本适配器**只在方法被调用时才动态 `import('node:fs')`**，因此即使你在不支持
// Node 的运行环境（如 Cloudflare Workers）里 `import` 本包，只要不 `new NodeStorage()`，
// 就不会拉入 node:fs，原包在无 Node 环境下依旧可用。

import type { Storage } from '../types';

export interface NodeStorageOptions {
  /** JSON 文件路径，默认 ./agent-core.kv.json */
  file?: string;
  /** 是否每条 setJSON 都立即落盘（默认 true）。大量写入时可关掉并手动 flush() */
  autosync?: boolean;
}

export class NodeStorage implements Storage {
  private file: string;
  private autosync: boolean;
  private cache = new Map<string, string>();
  private loaded = false;
  private writing: Promise<void> | null = null;

  constructor(opts: NodeStorageOptions = {}) {
    this.file = opts.file ?? './agent-core.kv.json';
    this.autosync = opts.autosync ?? true;
  }

  // 动态加载 node:fs，避免在无 Node 环境（Workers）中静态引入导致加载失败。
  private async fsMod(): Promise<any> {
    return import('node:fs');
  }

  private dirOf(f: string): string {
    const i = f.lastIndexOf('/');
    return i >= 0 ? f.slice(0, i) : '.';
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const mod = await this.fsMod();
      const raw = await mod.promises.readFile(this.file, 'utf8');
      const obj = JSON.parse(raw) as Record<string, string>;
      this.cache = new Map(Object.entries(obj));
    } catch {
      this.cache = new Map();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const mod = await this.fsMod();
    const obj = Object.fromEntries(this.cache);
    // 串行化写，避免并发覆盖
    this.writing = (this.writing ?? Promise.resolve()).then(async () => {
      await mod.promises.mkdir(this.dirOf(this.file), { recursive: true });
      await mod.promises.writeFile(this.file, JSON.stringify(obj, null, 2), 'utf8');
    });
    return this.writing;
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    await this.ensureLoaded();
    const raw = this.cache.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    await this.ensureLoaded();
    this.cache.set(key, JSON.stringify(value));
    if (this.autosync) await this.persist();
  }

  /** 手动落盘（autosync=false 时使用），确保退出前数据已写入文件 */
  async flush(): Promise<void> {
    await this.persist();
  }
}
