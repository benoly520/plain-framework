// Plain 服务端渲染：把组件渲染成 HTML 字符串
//
// 因为 Plain 编译产物是「直接建 DOM」，且 effect 在首次执行时同步写入，
// 所以 SSR 不需要独立的渲染器 —— 换个 document 实现即可。

import { installServerDOM, serializeNode } from "./dom-shim.js";
import { createScope } from "../runtime/signal.js";

export type RenderableNode = any;

/**
 * renderToString(component | node, { wait = 0 })
 * wait: 等待的毫秒数（用于让 resource 的 promise tick 完成）
 */
export async function renderToString(
  component: (() => any) | any,
  options: { wait?: number; container?: boolean } = {}
): Promise<string> {
  const { wait = 0, container = true } = options || {};
  const doc: any = installServerDOM();
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
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const html = scope.value.childNodes.map(serializeNode).join("");
    return container ? `<div>${html}</div>` : html;
  } finally {
    scope.dispose();
    // 还原宿主全局，避免污染同进程后续的 hydrate / DOM 操作
    if (typeof doc.__restore === "function") doc.__restore();
  }
}

/** 同步版本：不含异步资源（resource 会停在 loading 态） */
export function renderToStringSync(component: (() => any) | any): string {
  const doc: any = installServerDOM();
  const scope = createScope(() => {
    const node = typeof component === "function" ? component() : component;
    return node;
  });
  try {
    return serializeNode(scope.value);
  } finally {
    scope.dispose();
    if (typeof doc.__restore === "function") doc.__restore();
  }
}
