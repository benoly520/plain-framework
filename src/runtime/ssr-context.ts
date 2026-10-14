// SSR 上下文：服务端渲染期间的两件事（见 docs/rfcs/ssr-data.md）
//
//   1. server() 直调 —— 同进程、同一份 .plain/server.mjs，直接调用 handler，
//      不走 HTTP（fetch 自己需要猜 host / port / 子路径，而且构建期根本没有服务在听）；
//   2. resource 的 pending 追踪 —— 让「等异步渲染完」是**可判定的**，
//      而不是 `wait: 50` 这种猜出来的毫秒数。
//
// 为什么单独一个文件：runtime/async.ts 与 server/render.ts 都要用它，
// 而 runtime 不该 import server 的入口（会形成方向错误的依赖）。

/** 一次 SSR 期间的上下文 */
interface SsrScope {
  /** 服务端函数表（来自 .plain/server.mjs）；null = 没注入 */
  handlers: Record<string, (...args: any[]) => any> | null;
}

let current: SsrScope | null = null;

/**
 * 进入 SSR 上下文。返回**恢复函数**（成对使用，支持嵌套渲染）。
 * handlers 没注入时，SSR 期间调用 server() 会抛带指引的错，而不是静默去 fetch 自己。
 */
export function beginSSR(
  handlers: Record<string, (...args: any[]) => any> | null = null
): () => void {
  const prev = current;
  current = { handlers };
  return () => {
    current = prev;
  };
}

/** 是否处于 SSR 期间 */
export function isSSR(): boolean {
  return current !== null;
}

/**
 * 取 SSR 期间要直调的 handler；拿不到返回 null（调用方负责报错，不静默降级）。
 */
export function getSSRHandler(
  name: string
): ((...args: any[]) => any) | null {
  const handlers = current && current.handlers;
  const fn = handlers ? handlers[name] : null;
  return typeof fn === "function" ? fn : null;
}

// ---------------------------------------------------------------------------
// pending 追踪：确定性等待的依据
// ---------------------------------------------------------------------------

const pending = new Set<Promise<unknown>>();

/**
 * 把一个 promise 记入 pending，settle 后自动摘掉。
 * 成功后返回原 promise（调用方照常 await），**不改变其拒绝语义**。
 */
export function trackPending<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  const done = () => {
    pending.delete(p);
  };
  // 单独挂一条分支摘除自己，避免污染调用方的 then/catch 链
  p.then(done, done);
  return p;
}

/** 当前未 settle 的 resource 数量 */
export function pendingCount(): number {
  return pending.size;
}

/**
 * 等当前这一批 pending settle（用 allSettled：**资源出错不该炸掉 SSR**，
 * 错误已经落在 resource 的 error 态里，由组件决定怎么渲染）。
 */
export async function settlePending(): Promise<void> {
  await Promise.allSettled(Array.from(pending));
}

/** 仅供测试：清空 pending 登记 */
export function __clearPending(): void {
  pending.clear();
}
