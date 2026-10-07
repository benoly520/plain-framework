// Plain 异步：resource（自动 loading/data/error）+ 跨端 RPC

import { signal, effect, batch } from "./signal.js";

/**
 * resource(fn) —— 自动带 loading / data / error 的异步资源。
 * fn 内读取的 signal 变化会自动重新拉取（这就是 AI 最常写错的地方，这里免费给）。
 */
export function resource(promiseFn, owner) {
  const data = signal(undefined);
  const loading = signal(true);
  const error = signal(undefined);
  let seq = 0;

  effect(() => {
    const ticket = ++seq;
    batch(() => {
      loading.set(true);
      error.set(undefined);
    });
    // 关键点：必须「同步」调用 promiseFn，这样它内部读取的 signal 才会被
    // 收集为依赖；放进 .then() 里读就永远订阅不上。
    let p;
    try {
      p = promiseFn();
    } catch (e) {
      batch(() => {
        error.set(e);
        loading.set(false);
      });
      return;
    }
    Promise.resolve(p)
      .then((v) => {
        if (ticket !== seq) return; // 丢弃过期响应，避免竞态
        batch(() => {
          data.set(v);
          loading.set(false);
        });
      })
      .catch((e) => {
        if (ticket !== seq) return;
        batch(() => {
          error.set(e);
          loading.set(false);
        });
      });
  }, owner);

  const out = { data, loading, error };
  out.loading = loading;
  out.refetch = () => {
    // 强制重跑（暂用于手动刷新）
    batch(() => {
      loading.set(true);
      error.set(undefined);
    });
    return Promise.resolve()
      .then(() => promiseFn())
      .then((v) => {
        batch(() => {
          data.set(v);
          loading.set(false);
        });
        return v;
      });
  };
  return out;
}

let RPC_ENDPOINT = "/_plain/rpc";

/** 自定义 RPC 端点（例如部署在子路径下） */
export function setRpcEndpoint(url) {
  RPC_ENDPOINT = url;
}

/**
 * rpc(name, args) —— 客户端桩。
 * 编译器把 `const f = server(() => ...)` 替换为 `const f = (...a) => rpc('f', a)`，
 * 因此源码里 f 的调用方式不变，但函数体已经物理搬到服务端了。
 */
export async function rpc(name, args) {
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
  return body ? body.result : undefined;
}

/** server(fn) —— 标记只在服务端运行；客户端包里会被编译器替换成 rpc 桩 */
export function server(fn) {
  if (typeof fn === "function") fn.__server = true;
  return fn;
}
