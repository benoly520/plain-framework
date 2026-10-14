// SSR 上下文（运行时侧）：服务端渲染期间的两件事（见 docs/rfcs/ssr-data.md）
//
//   1. server() 直调 —— 同进程、同一份 .plain/server.mjs，直接调用 handler，
//      不走 HTTP（fetch 自己需要猜 host / port / 子路径，而且构建期根本没有服务在听）；
//   2. resource 的 pending 登记 —— 让「等异步渲染完」是**可判定的**，
//      而不是 `wait: 50` 这种猜出来的毫秒数。
//
// ★ 状态**不放模块作用域**：handlers 与 pending 都是「按渲染」的，
//   放模块级变量在并发渲染下会互相踩（A 的 handlers 被 B 看到、B 去等 A 的 promise）。
//   真正的存放处由**服务端**提供（AsyncLocalStorage，见 server/ssr-scope.ts），
//   这里只保留一个「读当前渲染上下文」的钩子 ——
//   于是这份要进浏览器包的代码**不需要 import node:async_hooks**，
//   而没注册钩子时 `isSSR()` 恒为 false（浏览器语义 ✓）。

export interface SSRStore {
  /** 服务端函数表（来自 .plain/server.mjs）；null = 没注入 */
  handlers: Record<string, (...args: any[]) => any> | null;
  /** 本次渲染尚未 settle 的 resource —— **按渲染隔离**，不跨请求 */
  pending: Set<Promise<unknown>>;
}

let readStore: (() => SSRStore | null) | null = null;

/**
 * 注册「读当前渲染上下文」的实现；由服务端在初始化时调用一次。
 * 不注册 = 不在 SSR 里（浏览器 / 纯 CSR）。
 */
export function __setSSRStoreReader(reader: (() => SSRStore | null) | null): void {
  readStore = reader;
}

/** 当前渲染上下文；不在 SSR 期间返回 null */
export function getSSRStore(): SSRStore | null {
  return readStore ? readStore() : null;
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
