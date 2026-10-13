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
  untracked,
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
  const [start, end] = markers(parent, "#", "/#");
  let rows: Row[] = [];

  /** 建立一行：独立 signal 承载该行数据，effect 归入该行自己的 owner */
  const buildRow = (item: any, index: number): Row => {
    const rowSignal = signal(item);
    const cleanups = new Set<() => void>();
    let built: any = null;
    withOwner(cleanups, () => {
      built = itemFn(rowProxy(() => rowSignal()), index);
    });
    return { key: undefined, rowSignal, cleanups, nodes: toNodes(built) as any[] };
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
