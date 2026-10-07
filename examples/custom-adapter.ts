/**
 * @mox/agent-core · 如何写自己的 Storage 适配器（以 Redis 为例）
 *
 * 核心只认 Storage 接口（getJSON / setJSON）。你用任何后端
 * （Redis / Prisma / DynamoDB / 你自己的 KV）实现它即可，无需改一行核心代码。
 * 这是给开发者的「照猫画虎」模板。
 */
import type { Storage } from '../src/index';

// 假设你项目里已有 ioredis 客户端：
//   import Redis from 'ioredis';
//   const redis = new Redis(process.env.REDIS_URL!);

class RedisStorage implements Storage {
  // private redis: Redis;
  // constructor(redis: Redis) { this.redis = redis; }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    // const raw = await this.redis.get(key);
    const raw: string | null = null; // ← 替换为真实读取：const raw = await this.redis.get(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    // await this.redis.set(key, JSON.stringify(value));
    void key;
    void value;
  }
}

export { RedisStorage };
