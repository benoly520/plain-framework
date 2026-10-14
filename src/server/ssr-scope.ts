// 一次 SSR 的作用域（服务端侧）：垫片文档 + handlers + 本轮的 pending 资源
//
// 为什么需要它：渲染过程里有 await（等静默 / 数据迁移），而
// 「当前这次的垫片 / handlers / pending」都是**按渲染**的状态。
// 放在模块作用域里会被并发请求互相踩，于是放进 AsyncLocalStorage ——
// 异步上下文贯穿 await，每个请求各自一份，互不影响。
//
// runtime 侧（要进浏览器包）不能 import node:async_hooks，所以方向是
// **服务端提供实现、runtime 只留一个「读当前上下文」的钩子**
// （`__setSSRStoreReader`，见 runtime/ssr-context.ts）。
// 设计与根因见 docs/rfcs/ssr-data.md §3.4。

import { AsyncLocalStorage } from "node:async_hooks";
import type { SSRStore } from "../runtime/ssr-context.js";
import { __setSSRStoreReader } from "../runtime/ssr-context.js";
import { createDocument, installDocumentAccessor } from "./dom-shim.js";

/** 本次渲染的完整状态：垫片 + handlers + pending + 数据收集槽 */
export interface SSRRenderStore extends SSRStore {
  doc: any;
}

const als = new AsyncLocalStorage<SSRRenderStore>();
let ready = false;

function ensureReady(): void {
  if (ready) return;
  ready = true;
  // globalThis.document 取值时**先问当前渲染上下文** —— 不再「换全局、用完换回来」
  installDocumentAccessor(() => als.getStore()?.doc ?? null);
  __setSSRStoreReader(() => als.getStore() ?? null);
}

/**
 * 在「本次渲染自己的垫片 + handlers」作用域里执行 fn（**含 await 全程**）。
 * 并发渲染各自看到自己的一份。
 */
export function runSSR<T>(
  handlers: Record<string, (...args: any[]) => any> | null,
  fn: (store: SSRRenderStore) => T,
  /** 本次请求的路径（router 在服务端靠它知道该渲染哪一页） */
  url: string | null = null
): T {
  ensureReady();
  const store: SSRRenderStore = {
    doc: createDocument(),
    handlers,
    pending: new Set(),
    slots: [],
    url,
  };
  return als.run(store, () => fn(store));
}

/** 当前渲染尚未 settle 的 resource 数量（不在渲染上下文里则为 0） */
export function pendingCount(): number {
  const store = als.getStore();
  return store ? store.pending.size : 0;
}

/**
 * 等当前这一批 pending settle。用 `allSettled`：**资源出错不该炸掉 SSR** ——
 * 错误已经落在 resource 的 error 态里，由组件决定怎么渲染。
 */
export async function settlePending(): Promise<void> {
  const store = als.getStore();
  if (!store || store.pending.size === 0) return;
  await Promise.allSettled(Array.from(store.pending));
}
