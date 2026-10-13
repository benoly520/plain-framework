// Plain 服务端最小 DOM 垫片
// 用途：让同一份编译产物能在 Node 里直接跑并序列化成 HTML（SSR），无需 jsdom。
// 只实现编译器会用到的那部分 API，保持极小。

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

  constructor(tag: any) {
    super(1);
    this.tagName = String(tag).toLowerCase();
    this.localName = this.tagName;
    this.attributes = Object.create(null);
    this.style = {};
    this._events = Object.create(null);
  }
  setAttribute(k: string, v: any): void {
    this.attributes[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attributes ? this.attributes[k] : null;
  }
  removeAttribute(k: string): void {
    delete this.attributes[k];
  }
  hasAttribute(k: string): boolean {
    return k in this.attributes;
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
  set className(v: any) {
    this.attributes.class = String(v);
  }
  get className(): string {
    return this.attributes.class || "";
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
}

export function createDocument(): ServerDocument {
  return {
    nodeType: 9,
    createElement: (tag) => new SElement(tag),
    createElementNS: (_ns, tag) => new SElement(tag),
    createTextNode: (v) => new SText(v),
    createComment: (v) => new SComment(v),
    createDocumentFragment: () => new SFragment(),
    querySelector: () => null,
    getElementById: () => null,
    body: new SElement("body"),
  };
}

/**
 * 安装到 globalThis.document / window，供编译产物在 Node 里直接运行。
 *
 * 返回的 document 上挂了一个 `__restore()`：SSR 结束后调用它可把全局
 * document / Node / window 还原成安装前的值。**务必还原**——否则 SSR 会污染
 * 宿主进程（典型后果：同进程里再做 hydrate / 无头 DOM 渲染时，全局 document
 * 仍是服务端垫片，运行时新建的节点会变成 shim 节点）。
 */
export function installServerDOM(): ServerDocument {
  const doc = createDocument();
  const g = globalThis as any;
  const prev = {
    document: g.document,
    Node: g.Node,
    window: g.window,
    hasWindow: "window" in g,
  };
  g.document = doc;
  g.Node = SNode;
  if (!g.window) g.window = undefined;
  (doc as any).__restore = () => {
    g.document = prev.document;
    g.Node = prev.Node;
    if (prev.hasWindow) g.window = prev.window;
    else delete g.window;
  };
  return doc;
}
