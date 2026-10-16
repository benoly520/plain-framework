// Plain 服务端最小 DOM 垫片
// 用途：让同一份编译产物能在 Node 里直接跑并序列化成 HTML（SSR），无需 jsdom。
// 只实现编译器会用到的那部分 API，保持极小。
//
// ⚠️ 这个垫片与浏览器是「同一语义的两份实现」，两者必须给出**一致的可观测结果**：
//   1. 属性名规则一致（HTML 小写 / SVG 保留大小写，见 src/attrs.ts 的 canonicalAttrName）；
//   2. 编译产物赋的 DOM property 必须反射回 attributes，否则 SSR 序列化会整条丢掉
//      （历史 bug：SSR 下动态 href / value / checked 全部消失）。

import { REFLECTED_ATTRS } from "../attrs.js";

const HTML_NS = "http://www.w3.org/1999/xhtml";

const TEXT_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};
const VOID_TAGS = new Set<string>([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

class SNode {
  nodeType: number;
  childNodes: any[];
  parentNode: any;

  constructor(nodeType: number) {
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
  }
  get firstChild(): any {
    return this.childNodes[0] || null;
  }
  get lastChild(): any {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling(): any {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i >= 0 && i + 1 < p.childNodes.length ? p.childNodes[i + 1] : null;
  }
  get previousSibling(): any {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i > 0 ? p.childNodes[i - 1] : null;
  }
  appendChild(n: any): any {
    if (n.parentNode) n.parentNode.removeChild(n);
    // 文档片段：把子节点搬进来（与浏览器行为一致）
    if (n.nodeType === 11) {
      for (const c of Array.from(n.childNodes)) this.appendChild(c);
      return n;
    }
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  insertBefore(n: any, ref: any): any {
    if (n.parentNode) n.parentNode.removeChild(n);
    if (n.nodeType === 11) {
      for (const c of Array.from(n.childNodes)) this.insertBefore(c, ref);
      return n;
    }
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n: any): any {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes: any[]): void {
    const old = this.childNodes.slice();
    this.childNodes = [];
    old.forEach((c) => (c.parentNode = null));
    nodes.forEach((n) => this.appendChild(n));
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(n: any): boolean {
    let cur = n;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

class SElement extends SNode {
  tagName: string;
  localName: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  _events: Record<string, Function[]>;
  /** 是否 HTML 命名空间 —— 决定属性名是否小写（与浏览器一致） */
  _html: boolean;

  constructor(tag: any, ns?: string) {
    super(1);
    this.tagName = String(tag).toLowerCase();
    this.localName = this.tagName;
    this.attributes = Object.create(null);
    this.style = {};
    this._events = Object.create(null);
    // 浏览器只对 HTML 命名空间小写属性名；SVG / MathML 属性名大小写敏感（viewBox…）
    this._html = !ns || ns === HTML_NS;
  }
  /** 属性名规范化：与浏览器保持一致（HTML 小写、SVG / MathML 原样） */
  private _name(k: string): string {
    return this._html ? String(k).toLowerCase() : String(k);
  }
  setAttribute(k: string, v: any): void {
    this.attributes[this._name(k)] = String(v);
  }
  getAttribute(k: string): string | null {
    const n = this._name(k);
    return n in this.attributes ? this.attributes[n] : null;
  }
  removeAttribute(k: string): void {
    delete this.attributes[this._name(k)];
  }
  hasAttribute(k: string): boolean {
    return this._name(k) in this.attributes;
  }
  addEventListener(type: string, fn: Function): void {
    (this._events[type] = this._events[type] || []).push(fn);
  }
  removeEventListener(type: string, fn: Function): void {
    const list = this._events[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  get children(): any[] {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  set innerHTML(_v: any) {
    throw new Error("[plain] 禁止在服务端（以及客户端）使用 innerHTML");
  }
  set textContent(v: any) {
    this.childNodes = [];
    if (v !== "" && v != null) this.appendChild(new SText(String(v)));
  }
  get textContent(): string {
    return this.childNodes
      .map((c) => (c.nodeType === 3 ? c.nodeValue : serializeNode(c)))
      .join("");
  }
}

class SText extends SNode {
  nodeValue: string;
  constructor(v: any) {
    super(3);
    this.nodeValue = String(v);
  }
  get textContent(): string {
    return this.nodeValue;
  }
}

class SComment extends SNode {
  nodeValue: string;
  constructor(v: any) {
    super(8);
    this.nodeValue = String(v == null ? "" : v);
  }
  get textContent(): string {
    return "";
  }
}

class SFragment extends SNode {
  constructor() {
    super(11);
  }
}

// ---------------------------------------------------------------------------
// DOM property -> 属性 的反射
//
// 编译产物对**响应式**属性用 `el.<prop> = v`（setAttribute 改不动已脏的表单状态，
// 比如用户输入过的 input，设 value 属性不会改变当前值）。服务端垫片必须把这个赋值
// 落到 attributes 里，否则 serializeNode 遍历 attributes 时会整条丢掉 ——
// 历史 bug：SSR 下动态 href / value / checked 全部消失。
//
// 表与客户端共用 src/attrs.ts 的 REFLECTED_ATTRS：一端加属性，两端同时生效，
// 不会再出现「客户端一套、服务端一套」的漂移。
// ---------------------------------------------------------------------------
for (const [attr, reflected] of Object.entries(REFLECTED_ATTRS)) {
  const { prop, bool } = reflected;
  Object.defineProperty(SElement.prototype, prop, {
    configurable: true,
    /** 布尔属性读「在不在」，字符串属性读属性值（无则空串，与 DOMString 反射一致） */
    get(this: any): any {
      return bool ? attr in this.attributes : this.attributes[attr] ?? "";
    },
    set(this: any, v: any): void {
      if (bool) {
        if (v) this.attributes[attr] = "";
        else delete this.attributes[attr];
        return;
      }
      // 对齐 DOMString 的转换（含 null -> "null"），保证 SSR 与客户端产物一致
      this.attributes[attr] = String(v);
    },
  });
}

/**
 * 认领锚点前缀。运行时用注释锚点定位动态区间（insert / when / each / slot），
 * 这些锚点必须在 SSR 输出里保留，客户端 hydrate 才能按锚点认领已有 DOM。
 * 其余注释（如用户或第三方插入的）仍然丢弃 —— 只输出我们自己的锚点。
 */
export const CLAIM_PREFIX = "plain-";

function isClaimMarker(value: any): boolean {
  return typeof value === "string" && value.startsWith(CLAIM_PREFIX);
}

function escapeText(s: any): string {
  return String(s).replace(/[&<>"]/g, (c) => TEXT_ESCAPE[c]);
}

function escapeAttr(s: any): string {
  return String(s).replace(/[&<>"]/g, (c) => TEXT_ESCAPE[c]);
}

export function serializeNode(node: any): string {
  if (!node) return "";
  if (node.nodeType === 3) return escapeText(node.nodeValue);
  // 认领锚点必须原样输出（客户端 hydrate 按它定位动态区间）；普通注释丢弃
  if (node.nodeType === 8)
    return isClaimMarker(node.nodeValue) ? `<!--${node.nodeValue}-->` : "";
  if (node.nodeType === 11) return node.childNodes.map(serializeNode).join("");
  if (node.nodeType !== 1) return "";

  const el = node;
  let attrs = "";
  for (const k of Object.keys(el.attributes)) {
    attrs += ` ${k}="${escapeAttr(el.attributes[k])}"`;
  }
  const style = el.style && Object.keys(el.style).length
    ? ` style="${Object.entries(el.style)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
        .join(";")}"`
    : "";
  if (VOID_TAGS.has(el.tagName)) return `<${el.tagName}${attrs}${style}>`;
  return `<${el.tagName}${attrs}${style}>${el.childNodes
    .map(serializeNode)
    .join("")}</${el.tagName}>`;
}

export interface ServerDocument {
  nodeType: number;
  createElement: (tag: any) => SElement;
  createElementNS: (_ns: any, tag: any) => SElement;
  createTextNode: (v: any) => SText;
  createComment: (v: any) => SComment;
  createDocumentFragment: () => SFragment;
  querySelector: () => null;
  getElementById: () => null;
  body: SElement;
  /** 标记：让全局访问器认出「当前 document 是服务端垫片」 */
  __plainShim: true;
}

export function createDocument(): ServerDocument {
  return {
    nodeType: 9,
    createElement: (tag) => new SElement(tag),
    // 命名空间要带下去：SVG / MathML 的属性名大小写敏感，不能小写化
    createElementNS: (ns, tag) => new SElement(tag, ns),
    createTextNode: (v) => new SText(v),
    createComment: (v) => new SComment(v),
    createDocumentFragment: () => new SFragment(),
    querySelector: () => null,
    getElementById: () => null,
    body: new SElement("body"),
    __plainShim: true,
  };
}

// ---------------------------------------------------------------------------
// 全局安装：**只装一次、不再换入换出**
//
// ⚠️ 为什么不能沿用它以前的写法（换 globalThis.document → 用完换回来）：
// 渲染过程中有 await（等静默 / `wait` / 数据迁移），隐含假设「渲染是同步的、恢复是 LIFO」
// 就不成立了 —— 并发渲染会互相覆盖「上一个 document」，最后全局**永久停在废弃的垫片**上
// （根因分析见 docs/rfcs/ssr-data.md §3.4）。
//
// 现在 `document` 是「取值时查当前渲染上下文」的访问器：每个渲染各自
// `als.run(自己的垫片, …)`，全程（含 await 之后）看到自己的 document，
// 也不存在换入换出的窗口。
// `Node` 不需要按渲染隔离 —— 它每次都是同一个值（SNode），不存在跨渲染串味。
// ---------------------------------------------------------------------------

/** 取当前渲染上下文的 document（由 server/ssr-scope.ts 注入）；不在渲染中返回 null */
let getContextDoc: (() => any) | null = null;
/** 不在渲染上下文里时 `document` 取什么（纯 Node 是 undefined；jsdom 测试里是真实文档） */
let fallbackDoc: any = undefined;
/** 同上，`Node` 的兜底值（谁给 globalThis.Node 赋过值就是谁） */
let fallbackNode: any = undefined;
let globalsInstalled = false;

/** 当前是否跑在服务端垫片上（按渲染上下文，或旧的全局安装方式） */
export function isServerShimActive(): boolean {
  if (getContextDoc && getContextDoc()) return true;
  return !!(fallbackDoc && fallbackDoc.__plainShim);
}

/**
 * 把 `globalThis.document` / `globalThis.Node` 装成访问器（**幂等，只装一次**）。
 * provider 提供「当前渲染的垫片」；不传则保留已有 provider
 * （旧入口直接调用时不该把渲染路径的 provider 带坏）。
 */
export function installDocumentAccessor(provider?: () => any): void {
  if (provider) getContextDoc = provider;
  if (globalsInstalled) return;
  globalsInstalled = true;
  const g = globalThis as any;
  fallbackDoc = g.document;
  fallbackNode = g.Node;
  Object.defineProperty(g, "document", {
    configurable: true,
    get: () => (getContextDoc && getContextDoc()) || fallbackDoc,
    // 兼容既有用法：测试与 hydrate 会直接给 globalThis.document 赋值
    set: (v: any) => {
      fallbackDoc = v;
    },
  });
  Object.defineProperty(g, "Node", {
    configurable: true,
    get: () => (isServerShimActive() ? SNode : fallbackNode),
    set: (v: any) => {
      fallbackNode = v;
    },
  });
}

/**
 * 旧入口：把垫片装成「全局默认 document」（**同步**用法 / 测试）。
 *
 * 新代码请走 `server/ssr-scope.ts` 的 `runSSR()` —— 那条路按渲染隔离、并发安全。
 * 这里保留是为了不改动既有调用与测试的语义：返回的 document 上挂 `__restore()`，
 * 把全局默认 document / window 还原成安装前的值。
 */
export function installServerDOM(): ServerDocument {
  const doc = createDocument();
  const g = globalThis as any;
  const prev = {
    document: g.document,
    window: g.window,
    hasWindow: "window" in g,
  };
  installDocumentAccessor();
  fallbackDoc = doc;
  if (!g.window) g.window = undefined;
  (doc as any).__restore = () => {
    fallbackDoc = prev.document;
    if (prev.hasWindow) g.window = prev.window;
    else delete g.window;
  };
  return doc;
}
