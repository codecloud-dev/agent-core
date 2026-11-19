// @mox/agent-core · 有状态图引擎（对标 LangGraph 的 state-graph / checkpoint /
// human-in-the-loop / time-travel / observability）。
//
// 设计目标：与现有元认知协议、护栏模块正交——它负责「编排」，那两者负责「内容与策略」。
// 核心不依赖任何平台：所有持久化走注入的 Storage，所有可观测事件走注入的 observer。

import type { Storage } from './types';

// ============ 公共类型 ============

export type GraphStatus = 'running' | 'interrupted' | 'done' | 'error';

/** 每一步执行后落盘的快照。parentId 串成一条可回溯的链，支撑 time-travel。 */
export interface Checkpoint<S = any> {
  id: string;
  parentId: string | null;
  step: number;
  /** 刚执行完的节点；起点为 null */
  node: string | null;
  /** 下一步待执行节点队列（中断时保留被中断节点自身） */
  next: string[];
  state: S;
  status: GraphStatus;
  /** HITL 暂停时携带的载荷 */
  interrupt?: { node: string; payload: unknown };
  error?: string;
  createdAt: string;
}

export type GraphEventType =
  | 'start' | 'node_start' | 'node_end' | 'checkpoint'
  | 'interrupt' | 'resume' | 'end' | 'error';

/** 可观测事件流：observer 与结果里的 events 都收到同一组事件。 */
export interface GraphEvent<S = any> {
  type: GraphEventType;
  step: number;
  node?: string;
  ts: string;
  state?: S;
  durationMs?: number;
  payload?: unknown;
  error?: string;
}

export interface NodeContext<S> {
  step: number;
  signal?: AbortSignal;
  /** 暂停图并把 payload 交给调用方；resume 后本节点会以 resumeValue 重跑 */
  interrupt(payload: unknown): never;
  /** 本次 resume 注入的人工输入；首次执行为 undefined */
  readonly resumeValue: unknown;
  /** 当前节点是否由中断恢复而来 */
  readonly resumed: boolean;
}

export type NodeFn<S> = (
  state: S,
  ctx: NodeContext<S>,
) => Partial<S> | void | Promise<Partial<S> | void>;

export type RouterFn<S> = (
  state: S,
  step: number,
) => string | string[] | Promise<string | string[]>;

export type Reducer<S> = (state: S, patch: Partial<S> | void) => S;

class InterruptSignal extends Error {
  constructor(public readonly payload: unknown) {
    super('graph:interrupt');
    this.name = 'InterruptSignal';
  }
}

// 默认 reducer：对象浅合并（LangGraph 的常见语义），原始值直接替换。
function defaultReducer<S>(state: S, patch: Partial<S> | void): S {
  if (patch == null) return state;
  if (
    typeof state === 'object' && state !== null && !Array.isArray(state) &&
    typeof patch === 'object' && patch !== null && !Array.isArray(patch)
  ) {
    return { ...(state as any), ...(patch as any) } as S;
  }
  return patch as S;
}

// ============ StateGraph：声明式构图 ============

export interface StateGraphOptions<S> {
  reducer?: Reducer<S>;
  /** 终止哨兵名，默认 '__end__'（不会被当节点执行） */
  finish?: string;
}

export class StateGraph<S = any> {
  private nodes = new Map<string, NodeFn<S>>();
  private edges = new Map<string, string[]>();
  private routers = new Map<string, RouterFn<S>>();
  private entry: string | null = null;
  private readonly finish: string;
  private readonly reducer: Reducer<S>;

  constructor(opts: StateGraphOptions<S> = {}) {
    this.finish = opts.finish ?? '__end__';
    this.reducer = opts.reducer ?? defaultReducer;
  }

  addNode(name: string, fn: NodeFn<S>): this {
    if (!name || name === this.finish) throw new Error(`StateGraph: 非法节点名 "${name}"`);
    if (this.nodes.has(name)) throw new Error(`StateGraph: 节点 "${name}" 重复注册`);
    this.nodes.set(name, fn);
    return this;
  }

  /** 固定后继：after 执行完总是走 to */
  addEdge(from: string, to: string): this {
    const list = this.edges.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    this.edges.set(from, list);
    return this;
  }

  /** 条件路由：根据当前 state 决定下一个（或一组）节点 */
  addConditionalEdge(from: string, router: RouterFn<S>): this {
    this.routers.set(from, router);
    return this;
  }

  setEntry(name: string): this {
    if (!this.nodes.has(name)) throw new Error(`StateGraph: 入口节点 "${name}" 未注册`);
    this.entry = name;
    return this;
  }

  compile(opts: CompileOptions<S> = {}): CompiledGraph<S> {
    if (!this.entry) throw new Error('StateGraph: 未设置入口节点（setEntry）');
    return new CompiledGraph(this, opts);
  }

  // 供 CompiledGraph 内部使用
  _internals() {
    return {
      nodes: this.nodes, edges: this.edges, routers: this.routers,
      entry: this.entry!, finish: this.finish, reducer: this.reducer,
    };
  }
}

// ============ CompiledGraph：执行 + checkpoint + 恢复 ============

export interface CompileOptions<S> {
  /** checkpoint 持久化后端；不传则使用进程内 MemoryStorage 语义（单实例内可回溯） */
  checkpointer?: Storage;
  /** checkpoint 键前缀，默认 'agent:graph:cp:' */
  checkpointPrefix?: string;
  /** 可观测回调；回调抛错会被吞掉，绝不影响图执行 */
  observer?: (event: GraphEvent<S>) => void | Promise<void>;
  /** 单步上限，防自激循环，默认 100 */
  maxSteps?: number;
  now?: () => Date;
}

export interface InvokeOptions<S> {
  /** 从某个 checkpoint 恢复（time-travel / 续跑）；此时 input 可省略 */
  fromCheckpoint?: string;
  /** 恢复时覆盖快照状态（用于从历史节点分叉出另一条路线） */
  stateOverride?: Partial<S>;
  /** 由 resume() 注入，供被中断节点读取的人工输入 */
  resumeValue?: unknown;
  signal?: AbortSignal;
}

export interface RunResult<S> {
  status: GraphStatus;
  state: S;
  /** 本轮最后一个 checkpoint 的 id，用于 resume / time-travel */
  checkpointId: string;
  interrupt?: { node: string; payload: unknown };
  error?: string;
  events: GraphEvent<S>[];
  steps: number;
}

const DEFAULT_PREFIX = 'agent:graph:cp:';
const INDEX_SUFFIX = 'index';

export class CompiledGraph<S = any> {
  private readonly storage: Storage;
  private readonly prefix: string;
  private readonly maxSteps: number;
  private readonly internals: ReturnType<StateGraph<S>['_internals']>;
  private seq = 0;

  constructor(graph: StateGraph<S>, private readonly opts: CompileOptions<S>) {
    this.internals = graph._internals();
    this.storage = opts.checkpointer ?? new InMemoryCheckpointer();
    this.prefix = opts.checkpointPrefix ?? DEFAULT_PREFIX;
    this.maxSteps = opts.maxSteps ?? 100;
  }

  /** 从输入启动一轮执行；fromCheckpoint 时忽略 input，从快照续跑。 */
  async invoke(input: S, opts: InvokeOptions<S> = {}): Promise<RunResult<S>> {
    const events: GraphEvent<S>[] = [];
    const emit = async (e: GraphEvent<S>) => {
      events.push(e);
      try { await this.opts.observer?.(e); } catch { /* 可观测失败不影响主流程 */ }
    };
    const nowIso = () => (this.opts.now ? this.opts.now() : new Date()).toISOString();

    let state: S;
    let pending: string[];
    let step = 0;
    let parentId: string | null = null;

    if (opts.fromCheckpoint) {
      const cp = await this.getCheckpoint(opts.fromCheckpoint);
      if (!cp) throw new Error(`CompiledGraph: checkpoint "${opts.fromCheckpoint}" 不存在`);
      state = opts.stateOverride ? this.internals.reducer(cp.state, opts.stateOverride) : cp.state;
      pending = [...cp.next];
      step = cp.step;
      parentId = cp.id;
      await emit({ type: 'resume', step, node: cp.node ?? undefined, ts: nowIso(), payload: opts.stateOverride });
      // time-travel 分叉：状态被覆盖后，必须按新状态重算上个节点的后继，
      // 否则 cp.next 里还留着旧状态算出的分支，分叉就失真了。
      if (opts.stateOverride && cp.node) {
        const router = this.internals.routers.get(cp.node);
        const r = router
          ? await router(state, step)
          : (this.internals.edges.get(cp.node) ?? []);
        const succ = Array.isArray(r) ? r : [r];
        pending = succ.filter((s) => s !== this.internals.finish);
      }
    } else {
      state = input;
      pending = [this.internals.entry];
    }

    // 只有从 interrupt 恢复时才把值交给节点；stateOverride 的续跑不注入。
    let resumeValue: unknown = undefined;
    let resumed = false;
    if (opts.fromCheckpoint && opts.stateOverride === undefined) {
      const cp = await this.getCheckpoint(opts.fromCheckpoint!);
      if (cp?.status === 'interrupted' && cp.interrupt) {
        resumeValue = opts.resumeValue;
        resumed = true;
        pending = [cp.interrupt.node, ...pending.filter((n) => n !== cp.interrupt!.node)];
      }
    }

    await emit({ type: 'start', step, ts: nowIso(), state });

    const save = async (partial: Omit<Checkpoint<S>, 'id' | 'parentId' | 'createdAt'>): Promise<Checkpoint<S>> => {
      const cp: Checkpoint<S> = {
        ...partial,
        id: this.nextId(),
        parentId,
        createdAt: nowIso(),
      };
      await this.storage.setJSON(this.prefix + cp.id, cp);
      await this.appendIndex(cp.id);
      parentId = cp.id;
      await emit({ type: 'checkpoint', step: cp.step, node: cp.node ?? undefined, ts: cp.createdAt, state: cp.state });
      return cp;
    };

    // 起点也落一个 checkpoint，作为 time-travel 可回退到「任何节点都没跑」的锚点。
    if (!opts.fromCheckpoint) {
      await save({ step: 0, node: null, next: [...pending], state, status: 'running' });
    }

    let final: RunResult<S> | null = null;
    while (pending.length) {
      if (step >= this.maxSteps) {
        const msg = `CompiledGraph: 超过 maxSteps=${this.maxSteps}，疑似自激循环`;
        const cp = await save({ step, node: null, next: [...pending], state, status: 'error', error: msg });
        await emit({ type: 'error', step, ts: nowIso(), error: msg });
        final = { status: 'error', state, checkpointId: cp.id, error: msg, events, steps: step };
        break;
      }
      const name = pending.shift()!;
      const node = this.internals.nodes.get(name);
      if (!node) {
        const msg = `CompiledGraph: 节点 "${name}" 未注册`;
        const cp = await save({ step, node: name, next: [...pending], state, status: 'error', error: msg });
        await emit({ type: 'error', step, node: name, ts: nowIso(), error: msg });
        final = { status: 'error', state, checkpointId: cp.id, error: msg, events, steps: step };
        break;
      }
      if (opts.signal?.aborted) {
        const msg = 'CompiledGraph: 已取消';
        const cp = await save({ step, node: name, next: [name, ...pending], state, status: 'error', error: msg });
        final = { status: 'error', state, checkpointId: cp.id, error: msg, events, steps: step };
        break;
      }

      const t0 = Date.now();
      await emit({ type: 'node_start', step, node: name, ts: nowIso(), state });
      const ctx: NodeContext<S> = {
        step,
        signal: opts.signal,
        resumeValue,
        resumed,
        interrupt: (payload) => { throw new InterruptSignal(payload); },
      };
      try {
        const patch = await node(state, ctx);
        state = this.internals.reducer(state, patch);
        await emit({ type: 'node_end', step, node: name, ts: nowIso(), state, durationMs: Date.now() - t0 });
        step += 1;
        resumeValue = undefined;
        resumed = false;

        let successors: string[] = [];
        const router = this.internals.routers.get(name);
        if (router) {
          const r = await router(state, step);
          successors = Array.isArray(r) ? r : [r];
        } else {
          successors = this.internals.edges.get(name) ?? [];
        }
        pending.push(...successors.filter((s) => s !== this.internals.finish));
        await save({ step, node: name, next: [...pending], state, status: 'running' });
      } catch (e) {
        if (e instanceof InterruptSignal) {
          const payload = e.payload;
          const cp = await save({
            step, node: name, next: [name, ...pending], state,
            status: 'interrupted', interrupt: { node: name, payload },
          });
          await emit({ type: 'interrupt', step, node: name, ts: nowIso(), payload });
          final = {
            status: 'interrupted', state, checkpointId: cp.id,
            interrupt: { node: name, payload }, events, steps: step,
          };
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          const cp = await save({
            step, node: name, next: [name, ...pending], state, status: 'error', error: msg,
          });
          await emit({ type: 'error', step, node: name, ts: nowIso(), error: msg });
          final = { status: 'error', state, checkpointId: cp.id, error: msg, events, steps: step };
        }
        break;
      }
    }

    if (!final) {
      const cp = await save({ step, node: null, next: [], state, status: 'done' });
      await emit({ type: 'end', step, ts: nowIso(), state });
      final = { status: 'done', state, checkpointId: cp.id, events, steps: step };
    }
    return final;
  }

  /**
   * 从中断处恢复：把人工输入 resumeValue 交给被中断节点，让它重新执行。
   * 语义等价 invoke(undefined, { fromCheckpoint: id })，但强制走 HITL 分支。
   */
  async resume(cpId: string, resumeValue: unknown, opts: { signal?: AbortSignal } = {}): Promise<RunResult<S>> {
    const cp = await this.getCheckpoint(cpId);
    if (!cp) throw new Error(`CompiledGraph: checkpoint "${cpId}" 不存在`);
    if (cp.status !== 'interrupted' || !cp.interrupt) {
      throw new Error(`CompiledGraph: checkpoint "${cpId}" 不在中断态，无法 resume`);
    }
    return this.invoke(undefined as S, {
      fromCheckpoint: cpId,
      resumeValue,
      signal: opts.signal,
    });
  }

  /** 列出全部 checkpoint（按创建顺序），供 time-travel 选点。 */
  async listCheckpoints(): Promise<Checkpoint<S>[]> {
    const idx = await this.readIndex();
    const out: Checkpoint<S>[] = [];
    for (const id of idx.ids) {
      const cp = await this.storage.getJSON<Checkpoint<S>>(this.prefix + id);
      if (cp) out.push(cp);
    }
    return out;
  }

  async getCheckpoint(id: string): Promise<Checkpoint<S> | null> {
    return this.storage.getJSON<Checkpoint<S>>(this.prefix + id);
  }

  private nextId(): string {
    const ms = this.opts.now ? this.opts.now().getTime() : Date.now();
    return `cp-${ms.toString(36)}-${(this.seq++).toString(36)}`;
  }

  private async readIndex(): Promise<{ ids: string[] }> {
    return (await this.storage.getJSON<{ ids: string[] }>(this.prefix + INDEX_SUFFIX)) ?? { ids: [] };
  }

  private async appendIndex(id: string): Promise<void> {
    const idx = await this.readIndex();
    idx.ids.push(id);
    await this.storage.setJSON(this.prefix + INDEX_SUFFIX, idx);
  }
}

// 未注入 checkpointer 时用的进程内实现：只依赖 Storage 接口，保持平台无关。
class InMemoryCheckpointer implements Storage {
  private m = new Map<string, string>();
  async getJSON<T>(key: string): Promise<T | null> {
    const v = this.m.get(key);
    return v == null ? null : JSON.parse(v);
  }
  async setJSON(key: string, value: unknown): Promise<void> {
    this.m.set(key, JSON.stringify(value));
  }
}
