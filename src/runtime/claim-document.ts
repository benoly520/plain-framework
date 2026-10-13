// 认领式 document —— hydrate 期间替换 globalThis.document
//
// 编译产物里的 `document.createElement("div")` / `document.createTextNode(...)` /
// `document.createComment(...)` / `document.createDocumentFragment()` 会被这里接管：
//   - 处于 hydrate 上下文：不新建，而是按游标「认领」服务端已有节点（节点身份不变）
//   - 非 hydrate 上下文：原样透传给真实 document（保证 mount() 行为零变化）
//
// 认领失败（类型不符）时，claimElement/claimText 返回 null —— 此处退回真实新建，
// 由 ctx 记录 mismatch 告警（就地修正）。

import {
  getHydrationCtx,
  claimElement,
  claimText,
  claimMarker,
} from "./hydration-context.js";

/** 认领式 document 只需要实现编译产物会用到的那几个 API */
export function makeClaimDocument(realDoc: Document): Document {
  const shim: any = {
    // 透传所有我们没覆盖的属性/方法（querySelector、body、nodeType 等）
    __plainClaimDoc: true,
  };

  shim.createElement = (tag: string, opts?: any) => {
    if (getHydrationCtx()) {
      const claimed = claimElement(tag);
      if (claimed) return claimed; // 认领成功：同一个节点对象
    }
    return realDoc.createElement(tag, opts);
  };

  shim.createElementNS = (ns: string, tag: string) => realDoc.createElementNS(ns, tag);

  shim.createTextNode = (v: any) => {
    if (getHydrationCtx()) {
      const claimed = claimText(String(v));
      if (claimed) return claimed;
    }
    return realDoc.createTextNode(v);
  };

  shim.createComment = (v: any) => {
    if (getHydrationCtx()) {
      const claimed = claimMarker(String(v));
      if (claimed) return claimed;
    }
    return realDoc.createComment(v);
  };

  shim.createDocumentFragment = () => realDoc.createDocumentFragment();

  // 其余访问一律转发到真实 document（getter 动态求值，避免快照过期）
  return new Proxy(shim, {
    get(t, prop) {
      if (prop in t) return (t as any)[prop];
      const v = (realDoc as any)[prop];
      return typeof v === "function" ? v.bind(realDoc) : v;
    },
    has(t, prop) {
      return prop in t || prop in realDoc;
    },
  }) as unknown as Document;
}
