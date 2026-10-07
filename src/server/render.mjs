// Plain 服务端渲染：把组件渲染成 HTML 字符串
//
// 因为 Plain 编译产物是「直接建 DOM」，且 effect 在首次执行时同步写入，
// 所以 SSR 不需要独立的渲染器 —— 换个 document 实现即可。

import { installServerDOM, serializeNode } from "./dom-shim.mjs";

/**
 * renderToString(component | node, { wait = 0 })
 * wait: 等待的毫秒数（用于让 resource 的 promise tick 完成）
 */
export async function renderToString(component, options = {}) {
  const { wait = 0, container = true } = options || {};
  const doc = installServerDOM();
  const root = doc.createElement(container ? "div" : "div");
  const node = typeof component === "function" ? component() : component;
  if (node) root.appendChild(node);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const html = root.childNodes.map(serializeNode).join("");
  return container ? `<div>${html}</div>` : html;
}

/** 同步版本：不含异步资源（resource 会停在 loading 态） */
export function renderToStringSync(component) {
  const doc = installServerDOM();
  const node = typeof component === "function" ? component() : component;
  return serializeNode(node);
}
