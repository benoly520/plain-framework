// 认领式 document —— hydrate 期间拦截 document 的节点创建方法
//
// 编译产物里的 `document.createElement("div")` / `document.createTextNode(...)` /
// `document.createComment(...)` / `document.createDocumentFragment()` 会被这里接管：
//   - 处于 hydrate 上下文：不新建，而是按游标「认领」服务端已有节点（节点身份不变）
//   - 非 hydrate 上下文：原样透传给真实 document（保证 mount() 行为零变化）
//
// 浏览器里 window.document 是只读访问器，整体替换 globalThis.document 会抛错；
// 因此采用「在真实 document 实例上临时覆盖创建方法、用完恢复」的写法
// （installClaimDocument）。fallback 必须调用**覆盖前**保存的原始函数，否则会递归。
//
// 认领失败（类型不符）时，claimElement/claimText 返回 null —— 此处退回真实新建，
// 由 ctx 记录 mismatch 告警（就地修正）。

import {
  getHydrationCtx,
  claimElement,
  claimText,
  claimMarker,
} from "./hydration-context.js";

/**
 * 需要在 hydrate 期间被认领逻辑接管的 document 创建方法。
 * 顺序即 installClaimDocument 覆盖 / 恢复的顺序。
 */
const CLAIM_METHODS = [
  "createElement",
  "createElementNS",
  "createTextNode",
  "createComment",
  "createDocumentFragment",
] as const;

type ClaimMethod = (typeof CLAIM_METHODS)[number];

/** 覆盖前的原始方法 —— 认领失败时回退调用它，避免覆盖后递归 */
type Originals = Record<ClaimMethod, (...args: any[]) => any>;

/**
 * 构造认领式 document。
 *
 * @param realDoc 容器所属的真实 document
 * @param originals 覆盖前保存的原始创建方法；直接调用 makeClaimDocument 时从 realDoc 现场读取
 */
export function makeClaimDocument(realDoc: Document, originals?: Originals): Document {
  const orig: Originals = originals ?? (Object.fromEntries(
    CLAIM_METHODS.map((name) => [name, (realDoc as any)[name].bind(realDoc)])
  ) as Originals);
  const shim: any = {
    // 透传所有我们没覆盖的属性/方法（querySelector、body、nodeType 等）
    __plainClaimDoc: true,
  };

  shim.createElement = (tag: string, opts?: any) => {
    if (getHydrationCtx()) {
      const claimed = claimElement(tag);
      if (claimed) return claimed; // 认领成功：同一个节点对象
    }
    return orig.createElement(tag, opts);
  };

  shim.createElementNS = (ns: string, tag: string) => orig.createElementNS(ns, tag);

  shim.createTextNode = (v: any) => {
    if (getHydrationCtx()) {
      const claimed = claimText(String(v));
      if (claimed) return claimed;
    }
    return orig.createTextNode(v);
  };

  shim.createComment = (v: any) => {
    if (getHydrationCtx()) {
      const claimed = claimMarker(String(v));
      if (claimed) return claimed;
    }
    return orig.createComment(v);
  };

  shim.createDocumentFragment = () => orig.createDocumentFragment();

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

/**
 * 在真实 document 实例上临时安装认领方法，返回恢复函数（必须在 finally 中调用）。
 *
 * 浏览器 window.document 只读，不能整体替换 globalThis.document；但 document 实例的
 * 创建方法是可覆盖的普通属性。覆盖后编译产物里的 `document.createElement(...)` 会走认领，
 * 无需改动运行时内部或编译器，也不扩充任何公开 API。
 */
export function installClaimDocument(realDoc: Document): () => void {
  const target = realDoc as any;
  const originals = Object.fromEntries(
    CLAIM_METHODS.map((name) => [name, target[name].bind(realDoc)])
  ) as Originals;
  const descriptors = CLAIM_METHODS.map((name) => ({
    name,
    desc: Object.getOwnPropertyDescriptor(realDoc, name),
  }));
  const claimDoc = makeClaimDocument(realDoc, originals);
  for (const name of CLAIM_METHODS) {
    Object.defineProperty(realDoc, name, {
      configurable: true,
      writable: true,
      value: (claimDoc as any)[name],
    });
  }
  return () => {
    for (const { name, desc } of descriptors) {
      if (desc) Object.defineProperty(realDoc, name, desc);
      else delete target[name];
    }
  };
}
