// SSR 上下文（运行时侧）：服务端渲染期间的三件事（见 docs/rfcs/ssr-data.md）
//
//   1. server() 直调 —— 同进程、同一份 .plain/server.mjs，直接调用 handler，
//      不走 HTTP（fetch 自己需要猜 host / port / 子路径，而且构建期根本没有服务在听）；
//   2. resource 的 pending 登记 —— 让「等异步渲染完」是**可判定的**，
//      而不是 `wait: 50` 这种猜出来的毫秒数；
//   3. 首屏数据的**收集**（服务端）与**种入**（客户端注水）—— 配对键由编译器注入。
//
// ★ 状态**不放模块作用域**：handlers / pending / 收集槽都是「按渲染」的，
//   放模块级变量在并发渲染下会互相踩（A 的 handlers 被 B 看到、B 去等 A 的 promise）。
//   真正的存放处由**服务端**提供（AsyncLocalStorage，见 server/ssr-scope.ts），
//   这里只保留一个「读当前渲染上下文」的钩子 ——
//   于是这份要进浏览器包的代码**不需要 import node:async_hooks**，
//   而没注册钩子时 `isSSR()` 恒为 false（浏览器语义 ✓）。
//
// 客户端侧的「种子队列」是模块级的 —— 但那是**每页一份**，不是跨请求状态 ✓。

export interface SSRStore {
  /** 服务端函数表（来自 .plain/server.mjs）；null = 没注入 */
  handlers: Record<string, (...args: any[]) => any> | null;
  /** 本次渲染尚未 settle 的 resource —— **按渲染隔离**，不跨请求 */
  pending: Set<Promise<unknown>>;
  /** 本次渲染的数据收集槽，**按创建序**（服务端序列化用） */
  slots: SSRSlot[];
  /**
   * 本次请求的路径（如 `/todo/3`）。服务端没有 `window`，router 靠它才知道
   * 「这次要渲染哪一页」—— 否则 SSR 只能渲染 `/`（多路由就白做了）。
   */
  url?: string | null;
}

/** 一个 resource 在本次渲染里的收集槽 */
export interface SSRSlot {
  /** 编译器注入的调用点 key */
  key: string;
  /** 是否已经 settle 出值 */
  settled: boolean;
  value?: unknown;
}

/**
 * 「读当前渲染上下文」的钩子放在**进程级共享槽**上，而不是模块局部变量。
 *
 * 原因很实际：SSR 构建如果把框架运行时**打包进产物**（alias / `ssr.noExternal` /
 * 依赖树里出现两份），进程里就会有两个 runtime 副本 —— 模块局部的钩子跨不过去，
 * 应用那一份会以为「不在 SSR」，`server()` 于是退回 HTTP（或报「没注入 handlers」）。
 * 这种失败极难查。共享一个槽位，两份副本就认同一份上下文。
 *
 * 只影响服务端进程；浏览器里这个槽位永远是空的（`isSSR()` 恒为 false ✓）。
 */
const SHARED_KEY = "__plainSSRContext";

interface SharedSlot {
  read: (() => SSRStore | null) | null;
}

function sharedSlot(): SharedSlot {
  const g = globalThis as any;
  if (!g[SHARED_KEY]) {
    Object.defineProperty(g, SHARED_KEY, {
      value: { read: null } as SharedSlot,
      writable: true,
      configurable: true,
    });
  }
  return g[SHARED_KEY] as SharedSlot;
}

/**
 * 注册「读当前渲染上下文」的实现；由服务端在初始化时调用一次。
 * 不注册 = 不在 SSR 里（浏览器 / 纯 CSR）。
 */
export function __setSSRStoreReader(reader: (() => SSRStore | null) | null): void {
  sharedSlot().read = reader;
}

/** 当前渲染上下文；不在 SSR 期间返回 null */
export function getSSRStore(): SSRStore | null {
  const read = sharedSlot().read;
  return read ? read() : null;
}

/** 是否处于 SSR 期间 */
export function isSSR(): boolean {
  return getSSRStore() !== null;
}

/**
 * 取 SSR 期间要直调的 handler；拿不到返回 null（调用方负责报错，不静默降级）。
 */
export function getSSRHandler(
  name: string
): ((...args: any[]) => any) | null {
  const handlers = getSSRStore()?.handlers;
  const fn = handlers ? handlers[name] : null;
  return typeof fn === "function" ? fn : null;
}

/**
 * 把一个 promise 记入**本次渲染**的 pending，settle 后自动摘掉。
 * 成功后返回原 promise（调用方照常 await），**不改变其拒绝语义**。
 * 不在 SSR 里则不追踪 —— 客户端不需要，也省掉一个常驻 Set。
 */
export function trackPending<T>(p: Promise<T>): Promise<T> {
  const store = getSSRStore();
  if (!store) return p;
  store.pending.add(p);
  const done = () => {
    store.pending.delete(p);
  };
  // 单独挂一条分支摘除自己，避免污染调用方的 then/catch 链
  p.then(done, done);
  return p;
}

// ---------------------------------------------------------------------------
// 数据迁移：服务端收集
// ---------------------------------------------------------------------------

/**
 * 服务端：为某个调用点 key 开一个收集槽（**按创建序** push）。
 * 不在 SSR 里（客户端）返回 null。
 *
 * 为什么按创建序而不是按 settle 序：`value` 什么时候到位是不确定的，
 * 但「同一个 key 的第几个实例」在两端都是确定的 —— 客户端就按这个顺序配对种入。
 */
export function openSSRSlot(key: string): SSRSlot | null {
  const store = getSSRStore();
  if (!store) return null;
  const slot: SSRSlot = { key, settled: false };
  store.slots.push(slot);
  return slot;
}

// ---------------------------------------------------------------------------
// 数据迁移：客户端种入
// ---------------------------------------------------------------------------

/** 服务端载荷里的一条 */
export interface SSREntry {
  key: string;
  /** false = 这次在服务端没拿到值（出错 / 没 settle）；客户端照常自己去取 */
  ok: boolean;
  value?: unknown;
}

/** 按 key 排成的队列：同 key 的多个实例按**创建序**消费 */
const seedQueues = new Map<string, SSREntry[]>();

/**
 * 注入页面载荷（hydrate 前调用）。重复调用会**整体替换**队列 ——
 * 同一个页面只该有一份载荷。
 */
export function __loadSSRPayload(entries: SSREntry[] | null | undefined): void {
  seedQueues.clear();
  if (!entries) return;
  for (const entry of entries) {
    if (!entry || typeof entry.key !== "string") continue;
    const q = seedQueues.get(entry.key);
    if (q) q.push(entry);
    else seedQueues.set(entry.key, [entry]);
  }
}

/**
 * 取一个种子；**取到就消费掉**（所以同 key 的多个实例会依次拿到各自的值）。
 * 返回 null = 这个调用点没有种子（纯 CSR / 服务端那次没取到 …）。
 */
export function takeSSRSeed(key: string): SSREntry | null {
  const q = seedQueues.get(key);
  if (!q || !q.length) return null;
  return q.shift() as SSREntry;
}

/** 仅供测试：清空种子队列 */
export function __clearSSRPayload(): void {
  seedQueues.clear();
}
