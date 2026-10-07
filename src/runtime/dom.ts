// Plain DOM 层：挂载 / 插入 / 条件渲染 / 列表渲染
//
// 关键设计：不在 Fragment 里换节点。
// Fragment 一旦被 append 到父节点就会被「抽干」，后续再往它里面写就全丢了
// （旧版本正是死在这里）。这里统一用两个注释锚点定位真实父节点，
// 并通过「最小重排」更新兄弟区间，尽可能不动已有节点（保住焦点/滚动位置）。

import type { Renderable, Slot, Owner } from "../types.js";
import {
  signal,
  effect,
  rowProxy,
  withOwner,
  stringify,
  resolve,
} from "./signal.js";

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
  const n = typeof node === "function" ? node() : node;
  toNodes(n).forEach((x: Node) => el.appendChild(x));
  return () => toNodes(n).forEach((x: Node) => (x as any).remove && (x as any).remove());
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
  const start = document.createComment(open);
  const end = document.createComment(close);
  parent.appendChild(start);
  parent.appendChild(end);
  return [start, end];
}

/**
 * createSlot —— 带锚点的插槽。
 * 组件如果需要「事后整体替换自己的内容」（典型：ErrorBoundary、路由容器、
 * 懒加载），就必须返回 Slot 而不是 Fragment：Fragment 一旦被 append 就会被
 * 抽干，之后往里写就全丢了。Slot 用两个注释锚点动态定位真实父节点。
 */
export function createSlot(label = ""): Slot {
  const start = document.createComment(label ? `[${label}]` : "[");
  const end = document.createComment(label ? `[/${label}]` : "[/]");
  const fragment = document.createDocumentFragment();
  fragment.appendChild(start);
  fragment.appendChild(end);
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
}

// ---------------------------------------------------------------------------
// insert —— 任意表达式的响应式插入
// ---------------------------------------------------------------------------
export function insert(parent: Node, get: () => unknown, owner?: Owner): void {
  const [start, end] = markers(parent, "[", "]");
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
    withOwner(set, () => {
      v = get();
    });
    cleanups = set;
    syncRange(start, end, toNodes(v));
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
  const [start, end] = markers(parent, "?", "/?");
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
    withOwner(set, () => {
      const branch = cond ? thenFn : elseFn;
      node = branch ? branch() : null;
    });
    cleanups = set;
    syncRange(start, end, toNodes(node));
  }, owner);
}

// ---------------------------------------------------------------------------
// each —— 列表渲染：行级响应式 + 完整回收
// ---------------------------------------------------------------------------
export function each(
  parent: Node,
  getter: () => readonly any[] | null,
  itemFn: (item: any, index: number) => Renderable,
  owner?: Owner
): void {
  const [start, end] = markers(parent, "#", "/#");
  const rows: any[] = [];

  effect(() => {
    const arr = getter() || [];

    while (rows.length < arr.length) {
      const rowSignal = signal(arr[rows.length]);
      const cleanups = new Set<() => void>();
      let built: any = null;
      withOwner(cleanups, () => {
        built = itemFn(rowProxy(() => rowSignal()), rows.length);
      });
      rows.push({ rowSignal, cleanups, nodes: toNodes(built) });
    }

    while (rows.length > arr.length) {
      const r = rows.pop();
      r.cleanups.forEach((f: () => void) => f());
      r.cleanups.clear();
      r.nodes.forEach((n: any) => n.remove && n.remove());
      r.nodes = [];
    }

    for (let i = 0; i < arr.length; i++) rows[i].rowSignal.set(arr[i]);

    const next: Node[] = [];
    rows.forEach((r: any) => r.nodes.forEach((n: Node) => next.push(n)));
    syncRange(start, end, next);
  }, owner);
}

/** 收集一个节点/Fragment 的真实子节点 */
export function nodesOf(node: any): Node[] {
  return toNodes(node);
}
