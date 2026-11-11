// Plain 响应式内核：signal / computed / effect / 作用域回收 / 批处理
//
// 设计约束（面向 AI）：
//   1. 只有一个状态原语：signal。读 s()，写 s.set(v)。
//   2. 依赖自动收集，没有 deps 数组、没有 hook 顺序要求。
//   3. 每个 effect 都可回收（dispose），由 owner 作用域统一管理，杜绝泄漏。

import type { Signal, Effect, Owner } from "../types.js";

let activeEffect: any = null;
const effectStack: any[] = [];
let activeOwner: any = null; // Set<dispose fn>：当前所属作用域
const ownerStack: any[] = []; // withOwner 的嵌套栈，用于向上查找错误处理器

/** 挂在 owner Set 上的错误处理器标记 */
export const ERROR_HANDLER: unique symbol = Symbol("plain.errorHandler");

/** 在最近的 ErrorBoundary 里注册错误处理回调 */
export function onError(handler: (err: unknown) => void): void {
  if (activeOwner) (activeOwner as any)[ERROR_HANDLER] = handler;
}

export function getCurrentEffect(): any {
  return activeEffect;
}

/**
 * untracked(fn) —— 执行 fn 但「不建立依赖」。
 * 用于列表 key 计算这类「需要读值、但读值本身不该触发重算」的场景。
 * 仅框架内部使用，不进公开 API（见 runtime/index.ts）。
 */
export function untracked<T>(fn: () => T): T {
  const prev = activeEffect;
  activeEffect = null;
  try {
    return fn();
  } finally {
    activeEffect = prev;
  }
}

export function cleanup(effect: any): void {
  effect.deps.forEach((s: any) => s.subs.delete(effect));
  effect.deps.clear();
}

/**
 * effect(fn, owner?)
 * 返回值本身就是该 effect 对象，e.dispose() 可回收。
 */
export function effect(fn: () => unknown, owner?: Owner): Effect {
  // 创建时的 owner 快照：重跑期间新建的子 effect / 清理注册必须仍然归入
  // 同一个作用域，否则 dispose 外层 scope 后它们会继续响应（生命周期泄漏）。
  const ownerSet = owner || activeOwner || null;
  const e: any = {
    deps: new Set(),
    fn,
    disposed: false,
    ownerSet,
    // computed 的派生 effect：调度时先于普通 effect 运行（避免中间态）
    isComputed: false,
    // 创建时快照下来的 owner 链：运行期抛错时用它找最近的 ErrorBoundary
    // （不能用运行时的 ownerStack —— effect 重跑时那条栈早就空了）
    ownerChain: ownerStack.length ? ownerStack.slice() : null,
    run() {
      if (e.disposed) return;
      cleanup(e);
      const prevOwner = activeOwner;
      activeEffect = e;
      effectStack.push(e);
      // 重跑期间恢复「创建时」的 owner：子 effect / onCleanup 才不会逃出作用域
      activeOwner = e.ownerSet;
      try {
        return fn();
      } catch (err) {
        // 沿创建时的 owner 链向上找最近的 ErrorBoundary；
        // 没人接管就抛出 —— 静默失败对 AI 调试是灾难
        const chain = e.ownerChain || [];
        for (let i = chain.length - 1; i >= 0; i--) {
          const h = chain[i][ERROR_HANDLER];
          if (h) {
            try {
              h(err);
            } catch (_) {
              break;
            }
            return;
          }
        }
        throw err;
      } finally {
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1] || null;
        activeOwner = prevOwner;
      }
    },
    dispose() {
      if (e.disposed) return;
      e.disposed = true;
      cleanup(e);
      unqueue(e);
    },
  };
  if (owner) (owner as any).add(e.dispose);
  else if (activeOwner) activeOwner.add(e.dispose);
  e.run();
  if (e.disposed) return e; // 运行中 Dispose 了自己（例如 ErrorBoundary 回收旧分支）
  return e as Effect;
}

/** 批处理：batch(() => { a.set(1); b.set(2); }) 内的多次写入只触发一轮 effect */
let batchDepth = 0;
// 待运行 effect 队列：数组保序，Set 去重
const queue: any[] = [];
const queued = new Set<any>();
let flushing = false;
// 当前这一波（同一次 flush 内取出的一批）——用于「已在波内、尚未运行」时跳过重复入队
let currentWave: Set<any> | null = null;
let ranInWave: Set<any> | null = null;

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

function unqueue(e: any): void {
  queued.delete(e);
  const i = queue.indexOf(e);
  if (i >= 0) queue.splice(i, 1);
}

function enqueue(e: any): void {
  if (e.disposed || queued.has(e)) return;
  // 已在当前波内且还没跑：它会带着最新值跑，不必再排一次
  if (currentWave && currentWave.has(e) && !ranInWave!.has(e)) return;
  queued.add(e);
  queue.push(e);
}

/**
 * flush —— 按「波」推进：每一波先把 computed 派生 effect 跑完，再跑普通 effect。
 *
 * 为什么需要分波 + 排序：computed 是 eager effect。若在 computed A 更新后立刻
 * 同步运行读 A 的消费者，它会看到「A 新、B 旧」的中间态（菱形依赖）。
 * 把同一轮通知里的 effect 收集起来、computed 优先，消费者就只在派生值
 * 全部更新后运行一次。
 */
function flush(): void {
  if (flushing) return; // 外层 flush 会把新入队的 effect 继续排空
  flushing = true;
  try {
    let guard = 0;
    while (queue.length) {
      if (++guard > 10000) {
        queue.length = 0;
        queued.clear();
        throw new Error("[plain] 检测到响应式死循环（effect 反复自触发）");
      }
      const wave = queue.splice(0, queue.length);
      wave.forEach((e: any) => queued.delete(e));
      // computed 是派生值：同一波里必须先更新，普通 effect 才读不到中间态
      wave.sort((a: any, b: any) =>
        a.isComputed === b.isComputed ? 0 : a.isComputed ? -1 : 1
      );
      currentWave = new Set(wave);
      ranInWave = new Set();
      for (const e of wave) {
        if (e.disposed || ranInWave.has(e)) continue;
        ranInWave.add(e);
        e.run();
      }
      currentWave = null;
      ranInWave = null;
    }
  } finally {
    flushing = false;
    currentWave = null;
    ranInWave = null;
  }
}

/** 创建一个可整体回收的作用域 */
export function createScope<T>(fn: (dispose: () => void) => T): {
  value: T;
  dispose(): void;
} {
  const cleanups = new Set<() => void>();
  const dispose = () => {
    cleanups.forEach((c) => c());
    cleanups.clear();
  };
  const prev = activeOwner;
  activeOwner = cleanups;
  try {
    const value = fn(dispose);
    return { value, dispose };
  } finally {
    activeOwner = prev;
  }
}

/** 注册清理回调（组件 / 节点卸载时执行） */
export function onCleanup(fn: () => void): void {
  if (activeOwner) activeOwner.add(fn);
}

/**
 * signal —— 唯一状态原语
 * 读取 s()，写入 s.set(x)；也支持 s.set(x => next) 函数式更新。
 */
export function signal<T>(initial: T): Signal<T> {
  const s = { value: initial, subs: new Set<any>() };
  const read: any = function () {
    if (activeEffect) {
      s.subs.add(activeEffect);
      activeEffect.deps.add(s);
    }
    return s.value;
  };
  read.peek = () => s.value;
  read.set = function (next: T | ((prev: T) => T)): T {
    const v =
      typeof next === "function" ? (next as (prev: T) => T)(s.value) : next;
    if (Object.is(v, s.value)) return v;
    s.value = v;
    const subs = Array.from(s.subs);
    // 统一入队：即使不在 batch 里，也先收齐这一轮的所有通知再按波运行，
    // 保证 computed 派生值先于消费者更新（见 flush 注释）。
    subs.forEach((e: any) => enqueue(e));
    if (batchDepth === 0) flush();
    return v;
  };
  read.subs = s.subs;
  return read as Signal<T>;
}

/** computed(fn) —— 派生值，读法与 signal 完全一致 */
export function computed<T>(fn: () => T, owner?: Owner): Signal<T> {
  const out = signal<T>(undefined as unknown as T);
  const e: any = effect(() => out.set(fn()), owner);
  // 标记派生 effect：调度时先于普通 effect 运行（见 flush）
  e.isComputed = true;
  return out;
}

export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 在指定 owner（Set of dispose fn）下执行，把子树的 effect 归入可回收作用域 */
export function withOwner<T>(ownerSet: Owner, fn: () => T): T {
  const prev = activeOwner;
  activeOwner = ownerSet;
  ownerStack.push(ownerSet);
  try {
    return fn();
  } finally {
    ownerStack.pop();
    activeOwner = prev;
  }
}

export function getOwner(): Owner | null {
  return activeOwner;
}

/**
 * 当前作用域链（从外到内）。context 靠它「从内到外找最近的 Provider」。
 * 创建期用 ownerStack；effect 重跑期 ownerStack 已空，改用其创建时快照的 ownerChain
 * （与 ErrorBoundary 查最近边界的做法一致）。
 */
export function getOwnerChain(): readonly any[] {
  if (activeEffect && activeEffect.ownerChain) return activeEffect.ownerChain;
  return ownerStack;
}

/**
 * rowProxy(getRow) —— 列表行代理。
 * 任何属性读取都会先读该行的 signal，从而让行内绑定自动订阅 —— 这是
 * “勾选待办 UI 不更新” 这个致命 bug 的根治手段，也让 AI 不必手写 key / memo。
 */
export function rowProxy<T extends object>(getRow: () => T | null | undefined): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const row = getRow();
      if (row === null || row === undefined) return undefined;
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => String(row);
      }
      return (row as any)[prop];
    },
    set(_t, prop, value) {
      const row = getRow();
      if (row) (row as any)[prop] = value;
      return true;
    },
    has(_t, prop) {
      const row = getRow();
      return row ? prop in row : false;
    },
    ownKeys() {
      const row = getRow();
      return row ? Reflect.ownKeys(row) : [];
    },
    getOwnPropertyDescriptor(_t, prop) {
      const row = getRow();
      if (!row) return undefined;
      return { configurable: true, enumerable: true, value: (row as any)[prop] };
    },
  });
}
