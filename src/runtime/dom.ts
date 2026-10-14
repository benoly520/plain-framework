// Plain DOM 层：挂载 / 插入 / 条件渲染 / 列表渲染
//
// 关键设计：不在 Fragment 里换节点。
// Fragment 一旦被 append 到父节点就会被「抽干」，后续再往它里面写就全丢了
// （旧版本正是死在这里）。这里统一用两个注释锚点定位真实父节点，
// 并按「区间」更新内容：**区间之外**的节点保持身份不变（它们的焦点 / 滚动 / 输入原样留着）。
//
// 注意 syncRange 在非注水路径下**不复用节点**（旧的 remove、新的 insertBefore），
// 所以区间之内的 DOM 状态不保留：焦点 / 选区、未受控输入的值、局部滚动都会丢。
// 要复用节点只有注水那条路（reconcileHydrate 的 inPlaceUpdate）。
// 细粒度更新（insert / each 的 keyed 复用）不经过 syncRange，节点照旧复用。

import type { Renderable, Slot, Owner } from "../types.js";
import {
  signal,
  effect,
  rowProxy,
  withOwner,
  stringify,
  resolve,
  untracked,
} from "./signal.js";
import { getHydrationCtx, claimPair, suspendHydrate } from "./hydration-context.js";
import { hmrRegister } from "./hmr.js";
import { flushRefs } from "./ref.js";

export { resolve } from "./signal.js";

export function stringifySafe(v: unknown): string {
  return stringify(v);
}

export { stringifySafe as stringify };

/** mount(selectorOrEl, component | node) —— 挂载到页面 */
export function mount(
  target: string | Element | null,
  node: Renderable | (() => Renderable)
): () => void {
  const el =
    typeof target === "string" ? document.querySelector(target) : target;
  if (!el) throw new Error(`[plain] mount 找不到目标：${target}`);
  const isComp = typeof node === "function";
  // 用 Slot 锚点承载，使挂载点可被 HMR 整树替换：只动锚点区间，区间之外的节点不受影响。
  const startMark = document.createComment(`${A}root]`);
  const endMark = document.createComment(`${A}/root]`);
  el.appendChild(startMark);
  el.appendChild(endMark);
  let current: Node[] = [];
  // 组件渲染产生的一切 effect 归入 cleanups：HMR 热替换只需回收它们（不动 DOM）
  let cleanups = new Set<() => void>();
  const render = () => {
    const n = isComp
      ? withOwner(cleanups, () => (node as () => Renderable)())
      : node;
    const nodes = toNodes(n);
    syncRange(startMark, endMark, nodes);
    current = nodes; // 记录「已插入的实际节点」，卸载时按它们移除（fragment 已被抽干）
  };
  render();

  const unmount = () => {
    // 回收该挂载点作用域内的一切副作用（effect / onCleanup 等），
    // 再移除 DOM —— 此前只移除 DOM，这些副作用会随挂载点一起泄漏。
    cleanups.forEach((f) => f());
    cleanups.clear();
    current.forEach((x: any) => x.remove && x.remove());
    startMark.remove && startMark.remove();
    endMark.remove && endMark.remove();
  };

  // HMR：仅对「组件形式」的挂载注册热替换（普通节点无可替换的 comp）
  if (isComp) {
    const unregister = hmrRegister({
      container: el,
      comp: node as () => Renderable,
      // 热替换时只回收旧 effect（DOM 交给 rebuild 的 syncRange 做最小重排）
      dispose: () => {
        cleanups.forEach((f) => f());
        cleanups.clear();
        cleanups = new Set<() => void>();
      },
      rebuild: (comp) => {
        (node as any) = comp;
        render();
      },
    });
    return () => {
      unregister();
      unmount();
    };
  }
  return unmount;
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 把任意值归一化为可直接插入的 DOM 节点数组 */
export function toNodes(v: any): Node[] {
  if (v === null || v === undefined || typeof v === "boolean") return [];
  if (Array.isArray(v)) return v.flatMap(toNodes);
  if (v.nodeType === 11) return Array.from(v.childNodes).flatMap(toNodes);
  if (v.nodeType) return [v];
  return [document.createTextNode(stringify(v))];
}

function markers(parent: any, open: string, close: string): [any, any] {
  // hydrate：认领服务端已有的一对锚点，并把锚点之间的内容原样放回两者之间。
  // 这样 syncRange 计算 cur 时看到的就是同一批被认领的服务端节点 ——
  // 配合 hydrate 期启用的「同类型就地更新」，即可做到不改节点身份、零重建。
  const ctx = getHydrationCtx();
  if (ctx) {
    const pair = claimPair(open, close);
    if (pair) {
      // 认领成功：把锚点与内容按原顺序重新挂回父级（content 已从服务端父级摘下）。
      // 顺序严格保持 start → content… → end，与「新建」路径一致。
      parent.appendChild(pair.start);
      for (const c of pair.content) parent.appendChild(c);
      parent.appendChild(pair.end);
      return [pair.start, pair.end];
    }
    // 锚点对不匹配：退化为新建锚点（recover 语义）
  }
  // 用父节点的 ownerDocument 新建锚点，而非全局 document：
  // 这样即使在 SSR 垫片污染全局、或跨文档（iframe/多窗口）场景下也不会串文档。
  const doc: Document = parent?.ownerDocument || (globalThis as any).document;
  const start = doc.createComment(open);
  const end = doc.createComment(close);
  parent.appendChild(start);
  parent.appendChild(end);
  return [start, end];
}

/**
 * 认领锚点前缀：所有运行时注释锚点都带这个前缀，SSR 序列化时才保留它们
 * （见 server/dom-shim.ts 的 serializeNode）。hydrate 靠锚点定位动态区间。
 */
const A = "plain-";

/**
 * createSlot —— 带锚点的插槽。
 * 组件如果需要「事后整体替换自己的内容」（典型：ErrorBoundary、路由容器、
 * 懒加载），就必须返回 Slot 而不是 Fragment：Fragment 一旦被 append 就会被
 * 抽干，之后往里写就全丢了。Slot 用两个注释锚点动态定位真实父节点。
 */
export function createSlot(label = ""): Slot {
  const open = label ? `${A}${label}]` : `${A}[`;
  const close = label ? `${A}/${label}]` : `${A}/]`;
  let start: any;
  let end: any;
  const fragment = document.createDocumentFragment();

  // hydrate：认领服务端已有的锚点对（及其间内容），把锚点与内容按原顺序放进 fragment
  const ctx = getHydrationCtx();
  const pair = ctx ? claimPair(open, close) : null;
  if (pair) {
    start = pair.start;
    end = pair.end;
    fragment.appendChild(start);
    for (const c of pair.content) fragment.appendChild(c);
    fragment.appendChild(end);
  } else {
    const doc: Document =
      (fragment as any).ownerDocument || (globalThis as any).document || document;
    start = doc.createComment(open);
    end = doc.createComment(close);
    fragment.appendChild(start);
    fragment.appendChild(end);
  }
  return {
    __plainSlot: true,
    fragment,
    start,
    end,
    set(nodes: Renderable): Slot {
      syncRange(start, end, toNodes(nodes));
      return this;
    },
    clear(): Slot {
      syncRange(start, end, []);
      return this;
    },
  };
}

/**
 * place(parent, node) —— 编译器调用组件时的统一入口。
 * 兼容三种返回值：普通 Node / Fragment / Slot。
 */
export function place(parent: Node, node: any): unknown {
  if (!node) return node;
  const list = node.__plainSlot ? toNodes(node.fragment) : toNodes(node);
  list.forEach((n: Node) => parent.appendChild(n));
  // 组件子树可能刚接入文档 -> 把连入的 ref 回调跑掉（见 ref.ts）
  flushRefs();
  return node;
}

/**
 * 把 start/end 之间的兄弟节点同步为 next —— 最小重排：
 * 已就位的节点不做任何 DOM 操作，只删除多余的、插入缺失/错位的。
 */
export function syncRange(start: any, end: any, next: Node[]): void {
  const parent = start.parentNode;
  if (!parent) return;
  const cur: any[] = [];
  let n = start.nextSibling;
  while (n && n !== end) {
    cur.push(n);
    n = n.nextSibling;
  }

  // hydrate 期：把「被认领的服务端节点」与「新算出的节点」按位置对齐，
  // 同类型则把新内容就地并入旧节点（保住节点对象身份），只对多出/缺失的做增删。
  // 这是「复用服务端已有节点」的核心；普通更新不启用（保持既有语义）。
  if (getHydrationCtx()) {
    reconcileHydrate(start, end, cur, next);
    flushRefs();
    return;
  }

  cur.forEach((x: any) => {
    if (next.indexOf(x) === -1 && x.remove) x.remove();
  });
  let ref = start.nextSibling;
  for (const want of next) {
    if (ref === want) {
      ref = want.nextSibling;
      continue;
    }
    parent.insertBefore(want, ref === null ? end : ref);
  }
  // 区间已同步：新接入文档的节点上的 ref 回调在这里跑（见 ref.ts）
  flushRefs();
}

/**
 * hydrate 期的区间对齐：把服务端已有节点与客户端新节点按位置配对。
 * - 同类型 → 就地更新（复用旧节点，节点身份不变）
 * - 多余的旧节点 → 摘除；多余的新节点 → 插入
 */
function reconcileHydrate(start: any, end: any, cur: any[], next: Node[]): void {
  const parent = start.parentNode;
  if (!parent) return;
  const n = Math.min(cur.length, next.length);
  for (let i = 0; i < n; i++) {
    if (sameKind(cur[i], next[i])) {
      inPlaceUpdate(cur[i], next[i]);
    } else {
      // 类型不符：用新节点替换旧节点（就地修正）
      parent.insertBefore(next[i], cur[i]);
      if (cur[i].remove) cur[i].remove();
    }
  }
  // 多出的旧节点摘除
  for (let i = n; i < cur.length; i++) {
    if (cur[i].remove) cur[i].remove();
  }
  // 多出的新节点追加到 end 之前
  for (let i = n; i < next.length; i++) {
    parent.insertBefore(next[i], end);
  }
}

/** 两个节点是否可视为「同类型」而做就地更新（文本 vs 文本、同名元素 vs 同名元素） */
function sameKind(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.nodeType === 3 && b.nodeType === 3) return true;
  if (
    a.nodeType === 1 &&
    b.nodeType === 1 &&
    String(a.tagName).toLowerCase() === String(b.tagName).toLowerCase()
  ) {
    return true;
  }
  return false;
}

/**
 * 把 b（新算出的节点）的内容同步进 a（已就位的节点），不替换 a 本身。
 * - 文本节点：把 a.nodeValue 改成 b 的值
 * - 元素节点：把 b 的属性/子节点搬进 a（a 保持自身身份）
 */
function inPlaceUpdate(a: any, b: any): void {
  if (a === b) return;
  if (a.nodeType === 3 && b.nodeType === 3) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeType === 1 && b.nodeType === 1) {
    // 属性：以 b 为准（先删 a 上多余的，再补 b 的）
    const aAttrs = a.attributes || [];
    const bAttrs = b.attributes || [];
    const bNames = new Set<string>();
    for (const at of Array.from(bAttrs) as any[]) {
      bNames.add(at.name);
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    }
    for (const at of Array.from(aAttrs) as any[]) {
      if (!bNames.has(at.name)) a.removeAttribute(at.name);
    }
    // 子节点：用 syncRange 的最小重排把 b 的子节点同步进 a
    syncChildren(a, b);
  }
}

/** 用最小重排把 b 的子节点同步进 a（a 自身保留） */
function syncChildren(a: any, b: any): void {
  const want = Array.from(b.childNodes) as Node[];
  const cur = Array.from(a.childNodes) as Node[];
  cur.forEach((c) => {
    if (want.indexOf(c) === -1 && (c as any).remove) (c as any).remove();
  });
  let ref = a.firstChild;
  for (const w of want) {
    if (ref === w) {
      ref = w.nextSibling;
      continue;
    }
    a.insertBefore(w, ref);
  }
}

// ---------------------------------------------------------------------------
// insert —— 任意表达式的响应式插入
// ---------------------------------------------------------------------------
export function insert(parent: Node, get: () => unknown, owner?: Owner): void {
  const [start, end] = markers(parent, `${A}[`, `${A}]`);
  let cleanups: Set<() => void> | null = null;
  effect(() => {
    // 每次重算都换一个新的 owner：这样「动态组件」的结果被替换时，
    // 它自己创建的 effect 会被整体回收（路由切换 / 列表重建时不会泄漏）
    if (cleanups) {
      cleanups.forEach((f) => f());
      cleanups.clear();
    }
    const set = new Set<() => void>();
    let v: any;
    let built: Node[] = [];
    // hydrate：锚点对已认领，内部内容应由运行时新建，再与已认领内容对齐 ——
    // 故 `get()` 与 `toNodes()` 全程挂起认领（否则新建会重复消费游标）。
    const resume = suspendHydrate();
    try {
      withOwner(set, () => {
        v = get();
      });
      built = toNodes(v);
    } finally {
      resume();
    }
    cleanups = set;
    syncRange(start, end, built);
  }, owner);
}

// ---------------------------------------------------------------------------
// when —— 条件渲染，分支切换回收上一分支 effect
// ---------------------------------------------------------------------------
export function when(
  parent: Node,
  getCond: () => unknown,
  thenFn: () => Renderable,
  elseFn?: (() => Renderable) | null,
  owner?: Owner
): void {
  const [start, end] = markers(parent, `${A}?`, `${A}/?`);
  let currentKey: string | null = null;
  let cleanups: Set<() => void> | null = null;

  effect(() => {
    const cond = getCond();
    const key = cond ? "then" : "else";
    if (currentKey === key) return;
    if (cleanups) {
      cleanups.forEach((f) => f());
      cleanups.clear();
    }
    currentKey = key;
    const set = new Set<() => void>();
    let node: Renderable = null;
    let built: Node[] = [];
    // hydrate：锚点对已认领，分支节点应新建后与已认领内容对齐（挂起认领）
    const resume = suspendHydrate();
    try {
      withOwner(set, () => {
        const branch = cond ? thenFn : elseFn;
        node = branch ? branch() : null;
      });
      built = toNodes(node);
    } finally {
      resume();
    }
    cleanups = set;
    syncRange(start, end, built);
  }, owner);
}

/** each 内部的行记录：keyed 模式下 key 用来认领同一行 */
interface Row {
  key: unknown;
  rowSignal: any;
  cleanups: Set<() => void>;
  nodes: any[];
}

// ---------------------------------------------------------------------------
// each —— 列表渲染：行级响应式 + 完整回收
//
// 两种复用策略：
//   1) index 模式（默认，兼容旧行为）：行按位置复用，数据变化就地更新；
//   2) keyed 模式：编译器在 JSX 顶层元素上发现 key={...} 时传入 keyFn，
//      按 key 复用行 —— 头部插入/重排不会重建已有行，节点的 DOM 身份跟着数据走。
//
// 为什么 keyed 模式要禁用 index：keyed 下行只构建一次，回调里捕获的 index
// 无法随位置更新。所以编译器在「回调用到了 index」时会自动放弃 key（退回
// index 模式），保证 index 永远准确 —— 见 compiler/index.ts 的 detectMap。
// ---------------------------------------------------------------------------
export function each(
  parent: Node,
  getter: () => readonly any[] | null,
  itemFn: (item: any, index: number) => Renderable,
  keyFn?: ((item: any, index: number) => unknown) | null,
  owner?: Owner
): void {
  const [start, end] = markers(parent, `${A}#`, `${A}/#`);
  let rows: Row[] = [];

  /** 建立一行：独立 signal 承载该行数据，effect 归入该行自己的 owner */
  const buildRow = (item: any, index: number): Row => {
    const rowSignal = signal(item);
    const cleanups = new Set<() => void>();
    let built: any = null;
    let nodes: Node[] = [];
    // hydrate：列表锚点对已认领、其内容被放回锚点之间 —— 因此行节点应新建，
    // 由 syncRange 与已认领的服务端行做对齐复用（挂起认领）。
    const resume = suspendHydrate();
    try {
      withOwner(cleanups, () => {
        built = itemFn(rowProxy(() => rowSignal()), index);
      });
      nodes = toNodes(built) as any[];
    } finally {
      resume();
    }
    return { key: undefined, rowSignal, cleanups, nodes };
  };

  /** 回收一行：先跑清理回调（回收该行的 effect），再摘除它的 DOM 节点 */
  const dropRow = (row: any) => {
    row.cleanups.forEach((f: () => void) => f());
    row.cleanups.clear();
    row.nodes.forEach((n: any) => n.remove && n.remove());
    row.nodes = [];
  };

  effect(() => {
    const arr = getter() || [];

    if (typeof keyFn !== "function") {
      // ---- index 模式 ----
      while (rows.length < arr.length) rows.push(buildRow(arr[rows.length], rows.length));
      while (rows.length > arr.length) {
        const r = rows.pop();
        if (r) dropRow(r);
      }
      for (let i = 0; i < arr.length; i++) rows[i].rowSignal.set(arr[i]);
    } else {
      // ---- keyed 模式 ----
      // key 在 untracked 里算：读值但不订阅，避免 key 字段变化引起额外重算
      const keys = untracked(() => arr.map((item, i) => (keyFn as any)(item, i)));
      const pool = new Map<unknown, any>();
      for (const row of rows) if (!pool.has(row.key)) pool.set(row.key, row);

      const next: any[] = [];
      for (let i = 0; i < arr.length; i++) {
        const key = keys[i];
        const reused = pool.get(key);
        if (reused) {
          pool.delete(key);
          reused.rowSignal.set(arr[i]); // 同一 key：只换数据，节点与 effect 都留着
          next.push(reused);
        } else {
          const row = buildRow(arr[i], i);
          row.key = key;
          next.push(row);
        }
      }
      pool.forEach((row) => dropRow(row)); // 消失的 key：整行回收
      rows = next;
    }

    const flat: Node[] = [];
    rows.forEach((r: any) => r.nodes.forEach((n: Node) => flat.push(n)));
    syncRange(start, end, flat);
  }, owner);
}

/** 收集一个节点/Fragment 的真实子节点 */
export function nodesOf(node: any): Node[] {
  return toNodes(node);
}
