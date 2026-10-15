// Plain 异步：resource（自动 loading/data/error）+ 跨端 RPC

import type { Resource, Owner } from "../types.js";
import { signal, effect, batch } from "./signal.js";
import {
  isSSR,
  getSSRHandler,
  trackPending,
  openSSRSlot,
  takeSSRSeed,
} from "./ssr-context.js";

/**
 * resource(fn) —— 自动带 loading / data / error 的异步资源。
 * fn 内读取的 signal 变化会自动重新拉取（这就是 AI 最常写错的地方，这里免费给）。
 */
export function resource<T>(
  promiseFn: () => T | Promise<T>,
  owner?: Owner,
  /**
   * SSR 调用点 key —— **由编译器注入，不用手写**（见 docs/rfcs/ssr-data.md §3.3）。
   * 有它，服务端取到的值才会随 HTML 迁移、并在注水时种回来（首帧与 HTML 一致）。
   */
  ssrKey?: string
): Resource<T> {
  const data = signal<T | undefined>(undefined);
  const loading = signal<boolean>(true);
  const error = signal<Error | undefined>(undefined);
  let seq = 0;

  // ① 注水种入：服务端这次取到的值直接放进来，于是**首帧就与 HTML 一致**
  //    （不闪 loading，也不必为了对齐首屏先请求一次）。
  let seeded = false;
  if (ssrKey) {
    const seed = takeSSRSeed(ssrKey);
    if (seed && seed.ok) {
      data.set(seed.value as T);
      loading.set(false);
      seeded = true;
    }
  }

  // ② 服务端收集：按**创建序**开槽，settle 后把值填进去（序列化时取走）。
  //    注意「没拿到值」也要占位 —— 否则同 key 的多个实例在客户端会错位配对
  //    （第 2 个实例拿到第 3 个的值：静默串数据，比多一次请求糟得多）。
  const slot = ssrKey ? openSSRSlot(ssrKey) : null;

  effect(() => {
    const ticket = ++seq;
    if (seeded) {
      // 种入后的第一次：**不要翻回 loading**（否则注水首帧与 HTML 不一致、会闪一下）。
      // 但 promiseFn 照跑：依赖收集不能丢（丢了依赖变化就永不重取 -> 静默陈旧数据），
      // 顺便就是一次 stale-while-revalidate 的后台校验。
      seeded = false;
    } else {
      batch(() => {
        loading.set(true);
        error.set(undefined);
      });
    }
    // 关键点：必须「同步」调用 promiseFn，这样它内部读取的 signal 才会被
    // 收集为依赖；放进 .then() 里读就永远订阅不上。
    let p: T | Promise<T>;
    try {
      p = promiseFn();
    } catch (e) {
      batch(() => {
        error.set(e as Error);
        loading.set(false);
      });
      return;
    }
    // SSR 的「等静默」靠它：登记进 pending，settle 后自动摘掉（见 ssr-context.ts）
    trackPending(Promise.resolve(p as Promise<T>))
      .then((v: T) => {
        if (ticket !== seq) return; // 丢弃过期响应，避免竞态
        if (slot) {
          slot.settled = true;
          slot.value = v;
        }
        batch(() => {
          data.set(v);
          loading.set(false);
        });
      })
      .catch((e: unknown) => {
        if (ticket !== seq) return;
        batch(() => {
          error.set(e as Error);
          loading.set(false);
        });
      });
  }, owner);

  const out: any = { data, loading, error };
  out.data = data;
  out.loading = loading;
  out.error = error;
  out.refetch = () => {
    // 强制重跑（暂用于手动刷新）
    batch(() => {
      loading.set(true);
      error.set(undefined);
    });
    return Promise.resolve()
      .then(() => promiseFn())
      .then((v: T) => {
        batch(() => {
          data.set(v);
          loading.set(false);
        });
        return v;
      });
  };
  return out as Resource<T>;
}

let RPC_ENDPOINT = "/_plain/rpc";
/** RPC 请求合并开关：开启后，同一微任务内的多次 rpc 调用合并成一次批量请求 */
let RPC_BATCHING = false;

/** 自定义 RPC 端点（例如部署在子路径下） */
export function setRpcEndpoint(url: string): void {
  RPC_ENDPOINT = url;
}

/**
 * 开启 / 关闭 RPC 请求合并（默认关闭，零行为变化）。
 *
 * 开启后，同一微任务内连续发起的 `rpc()` 会被合并成一次 `POST /_plain/rpc/batch`
 * （单次调用仍走普通端点）。这对「一次渲染里并发拉多个 `resource`」这类高频小请求
 * 特别有效，能把 N 次往返压成 1 次。服务端需支持批量端点（本框架 `rpcMiddleware`
 * 已内置）；若批量端点不可用（老服务端 / 网络错误），客户端会**自动退化**成逐条请求，
 * 不会让调用失败。
 */
export function setRpcBatching(enabled: boolean): void {
  RPC_BATCHING = enabled;
}

interface PendingCall {
  name: string;
  args?: unknown[];
  // 用 any 兜底：rpc 的 resolve 带泛型 R，推入队列时与 unknown 存在函数参数逆变冲突
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

// 批量队列：同一微任务内堆积，下一个 tick 一次性 flush
let queue: PendingCall[] | null = null;
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushQueue);
}

async function flushQueue(): Promise<void> {
  flushScheduled = false;
  const batch = queue;
  queue = null;
  if (!batch || batch.length === 0) return;
  // 只有一次调用就不必走批量协议，直接单发
  if (batch.length === 1) {
    const c = batch[0];
    singleFetch(c.name, c.args).then(c.resolve, c.reject);
    return;
  }
  try {
    const res = await fetch(RPC_ENDPOINT + "/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        calls: batch.map((c) => ({ name: c.name, args: c.args || [] })),
      }),
    });
    if (!res.ok) throw new Error(`RPC batch 失败: ${res.status} ${res.statusText}`);
    const body = await res.json();
    const results = (body && body.results) || [];
    batch.forEach((c, i) => {
      const r = results[i];
      if (!r) return c.reject(new Error(`RPC batch 缺少第 ${i} 项的返回`));
      if (r.error) c.reject(new Error(r.error));
      else c.resolve(r.result);
    });
  } catch (e) {
    // 批量端点不可用 / 网络错误：退化成逐条请求，保证调用不失败
    for (const c of batch) singleFetch(c.name, c.args).then(c.resolve, c.reject);
  }
}

/** 单次 RPC 请求（批量模式的退化路径与默认路径共用） */
async function singleFetch<R = unknown>(
  name: string,
  args?: unknown[]
): Promise<R> {
  const res = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${name} 失败: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body && body.error) throw new Error(body.error);
  return body ? (body.result as R) : (undefined as unknown as R);
}

/**
 * rpc(name, args) —— 客户端桩。
 * 编译器把 `const f = server(() => ...)` 替换为 `const f = (...a) => rpc('f', a)`，
 * 因此源码里 f 的调用方式不变，但函数体已经物理搬到服务端了。
 */
export async function rpc<R = unknown>(
  name: string,
  args?: unknown[]
): Promise<R> {
  // SSR 期间：**直调服务端实现**（同进程、同一份 .plain/server.mjs），不走 HTTP。
  // 取不到 handler 就明确报错 —— 绝不静默退回 fetch 自己（那需要猜 host / port，
  // 构建期更没有服务在监听）。见 docs/rfcs/ssr-data.md §3.1。
  if (isSSR()) {
    const fn = getSSRHandler(name);
    if (!fn) {
      throw new Error(
        `[plain] SSR 期间调用了服务端函数 "${name}"，但这次渲染没有注入 handlers。` +
          `服务端请这样渲染：renderToString(App, { handlers: await loadHandlers() })`
      );
    }
    return (await fn(...(args || []))) as R;
  }
  // 合并模式：把调用堆进队列，下一微任务一次性批量发出
  if (RPC_BATCHING) {
    return new Promise<R>((resolve, reject) => {
      if (!queue) queue = [];
      queue.push({ name, args, resolve, reject });
      scheduleFlush();
    });
  }
  return singleFetch<R>(name, args);
}

/** server(fn) —— 标记只在服务端运行；客户端包里会被编译器替换成 rpc 桩 */
export function server<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>
): (...args: A) => Promise<R> {
  if (typeof fn === "function") (fn as any).__server = true;
  return fn as (...args: A) => Promise<R>;
}
