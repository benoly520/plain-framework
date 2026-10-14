// Plain 服务端渲染：把组件渲染成 HTML 字符串
//
// 因为 Plain 编译产物是「直接建 DOM」，且 effect 在首次执行时同步写入，
// 所以 SSR 不需要独立的渲染器 —— 换个 document 实现即可。

import { installServerDOM, serializeNode } from "./dom-shim.js";
import { createScope } from "../runtime/signal.js";
import { beginSSR, pendingCount, settlePending } from "../runtime/ssr-context.js";

export type RenderableNode = any;

/** 「等静默」的最多轮数：每轮等一批 pending；settle 后新建的 resource 由下一轮接住 */
const MAX_SETTLE_ROUNDS = 20;

export interface RenderOptions {
  /**
   * 额外等待的毫秒数（**兼容旧调用**）。
   * 主要手段是「等 resource 静默」，不是这个猜出来的毫秒数 —— 见 docs/rfcs/ssr-data.md §3.2。
   */
  wait?: number;
  /** 是否套一层容器 div，默认 true */
  container?: boolean;
  /**
   * 服务端函数表（`await loadHandlers()`）。
   * 注入后，SSR 期间的 `server()` 调用**直调**这份实现，不走 HTTP（见 RFC §3.1）；
   * 不注入却在 SSR 里调 `server()` -> 明确报错，不静默去 fetch 自己。
   */
  handlers?: Record<string, (...args: any[]) => any> | null;
}

/**
 * renderToString(component | node, options)
 *
 * 与同步版的区别只有一条：**异步资源会被等到 settle 为止**。
 * 不是 `wait: 50` 那种猜出来的毫秒数 —— 后端慢一点 SSR 就会渲染骨架屏，
 * 而这件事静态发现不了，所以改成「等静默」这条可判定的规则。
 */
export async function renderToString(
  component: (() => any) | any,
  options: RenderOptions = {}
): Promise<string> {
  const { wait = 0, container = true, handlers = null } = options || {};
  const doc: any = installServerDOM();
  // SSR 上下文：server() 直调 + resource 的 pending 追踪
  const restoreSSR = beginSSR(handlers);
  // 在独立作用域里渲染：SSR 期间创建的 effect（insert/when/each/组件）会在
  // 序列化完成后被整体回收。否则它们会继续订阅全局 signal —— 同一进程里随后
  // 做 hydrate 时，点击等更新会同时触发「SSR 残留 effect（锚点是服务端垫片节点）
  // + hydrate effect（锚点是真实 DOM 节点）」，导致在 shim 节点上做 DOM 操作而报错。
  const scope = createScope(() => {
    const root = doc.createElement(container ? "div" : "div");
    const node = typeof component === "function" ? component() : component;
    if (node) root.appendChild(node);
    return root;
  });
  try {
    await settleResources();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const html = scope.value.childNodes.map(serializeNode).join("");
    return container ? `<div>${html}</div>` : html;
  } finally {
    restoreSSR();
    scope.dispose();
    // 还原宿主全局，避免污染同进程后续的 hydrate / DOM 操作
    if (typeof doc.__restore === "function") doc.__restore();
  }
}

/**
 * 循环等 resource 静默：settle 之后触发的 effect 可能**又创建新的 resource**，
 * 所以一直等到 pending 为空。等满上限仍有剩的 -> 显式告警（绝不静默少渲染数据）。
 */
async function settleResources(): Promise<void> {
  let rounds = 0;
  while (pendingCount() > 0) {
    if (rounds++ >= MAX_SETTLE_ROUNDS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[plain ssr] 等满 ${MAX_SETTLE_ROUNDS} 轮，仍有 ${pendingCount()} 个 resource 未 settle，` +
          `已按当前状态序列化（是不是有循环依赖，或有 promise 一直不返回？）`
      );
      return;
    }
    await settlePending();
  }
}

/** 同步版本：不含异步资源（resource 会停在 loading 态） */
export function renderToStringSync(
  component: (() => any) | any,
  options: { handlers?: Record<string, (...args: any[]) => any> | null } = {}
): string {
  const doc: any = installServerDOM();
  // 同样进 SSR 上下文：SSR 里调 server() 一律直调，绝不尝试 fetch 自己
  const restoreSSR = beginSSR(options.handlers ?? null);
  const scope = createScope(() => {
    const node = typeof component === "function" ? component() : component;
    return node;
  });
  try {
    return serializeNode(scope.value);
  } finally {
    restoreSSR();
    scope.dispose();
    if (typeof doc.__restore === "function") doc.__restore();
  }
}
