// @mox/agent-core · Cloudflare D1 适配器
// 用 Cloudflare D1 实现 Storage 接口。其余护栏 / 元认知逻辑完全平台无关。
//
// 设计：核心包不规定表结构——表名与列名由调用方在构造时传入，
// 避免把某个业务库的私有 schema 写死在通用包里。

import type { Storage } from '../types';

// 最小 D1 类型声明（避免强制依赖 @cloudflare/workers-types）。
interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement;
  first<T = any>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1PreparedStatement;
}

export interface D1StorageOptions {
  /** 键值表名，默认 'kv_store'（中立名，调用方可传自己的表） */
  table?: string;
  /** 键列名，默认 'key' */
  keyColumn?: string;
  /** 值列名，默认 'value' */
  valueColumn?: string;
}

/**
 * 基于一张 (key TEXT PRIMARY KEY, value TEXT) 键值表实现 Storage。
 *
 * 期望表结构（可用 migrations.sql 自建）：
 *   CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
 *
 * @example
 *   const storage = new D1Storage(env.DB, { table: 'agent_kv' });
 */
export class D1Storage implements Storage {
  private readonly table: string;
  private readonly keyCol: string;
  private readonly valCol: string;

  constructor(private db: D1Like, opts: D1StorageOptions = {}) {
    this.table = opts.table || 'kv_store';
    this.keyCol = opts.keyColumn || 'key';
    this.valCol = opts.valueColumn || 'value';
  }

  async getJSON<T = unknown>(key: string): Promise<T | null> {
    const sql = `SELECT ${this.valCol} FROM ${this.table} WHERE ${this.keyCol} = ?`;
    const row = await this.db.prepare(sql).bind(key).first<Record<string, unknown>>();
    if (!row) return null;
    const raw = row[this.valCol];
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    const sql =
      `INSERT INTO ${this.table} (${this.keyCol}, ${this.valCol}) VALUES (?, ?) ` +
      `ON CONFLICT(${this.keyCol}) DO UPDATE SET ${this.valCol} = excluded.${this.valCol}`;
    await this.db.prepare(sql).bind(key, JSON.stringify(value)).run();
  }
}
