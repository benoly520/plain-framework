// Plain 命令式 DOM 逃逸口：内建元素 ref={fn} 的运行时支撑（编译器生成 __ref 调用）
//
// 语义对齐平台的 connectedCallback / disconnectedCallback：
//   元素**连入 document 之后**调用一次 fn(el)；fn 返回的清理函数随 owner 回收。
// 设计与验收见 docs/rfcs/ref-escape-hatch.md。
//
// 为什么不在元素创建时立刻调用：`dialog.showModal()` 在游离节点上会抛
// InvalidStateError —— 必须是「已连接」语义。因此这里先登记待办，由运行时在所有
// 「节点接入文档」的出口（syncRange / place / router / hydrate）统一 flush。
//
// SSR：服务端 DOM 垫片没有 isConnected，待办永远不会被 flush —— 服务端不跑副作用，
// 正是我们要的。

import { getOwner, withOwner } from "./signal.js";

interface RefEntry {
  el: any;
  fn: (el: any) => unknown;
  /** 登记时的 owner：清理函数归它回收；owner 先于连接被回收时用它摘掉待办 */
  owner: any;
}

let pending: RefEntry[] = [];

/**
 * __ref(el, fn) —— 编译器为内建元素的 `ref={fn}` 生成，一般无需手写。
 * 登记「元素连入文档后调用 fn(el)」。编译期已拦住明显的非函数，这里再兜底运行期
 * （例如把 signal 当函数传进来），不做静默降级。
 */
export function __ref(el: any, fn: (el: any) => unknown): void {
  if (typeof fn !== "function") {
    throw new TypeError(
      "[plain] ref 需要一个函数：ref={(el) => { … }}；" +
        "元素连入文档后会用该元素调用它一次"
    );
  }
  const owner: any = getOwner();
  const entry: RefEntry = { el, fn, owner };
  pending.push(entry);
  // owner 先于连接被回收（元素从未接入文档）：把待办摘掉，避免悬挂/泄漏
  if (owner && typeof owner.add === "function") {
    owner.add(() => {
      const i = pending.indexOf(entry);
      if (i >= 0) pending.splice(i, 1);
    });
  }
}

/**
 * flushRefs() —— 把「已连入 document」的待办 ref 回调跑掉。
 * 由运行时在所有「节点接入文档」的出口调用（见 dom.ts / router.ts / hydrate.ts）。
 * 未连接的元素留在队列里，等它被接入时再跑。
 *
 * 回调抛错不静默：本轮**全部跑完**后再抛第一个错误 —— 这样既能被最近的
 * ErrorBoundary 接住（在 effect 内时），又不会因为一个回调出错就跳过其余的 ref。
 *
 * 回调在**该元素的 owner 作用域内**执行：回调里创建的 effect / onCleanup 归这个
 * 元素的生命周期（随它一起回收）。这也让「把依赖节点的 effect 写进 ref 回调」
 * 成为官方推荐写法 —— 组件体先于 DOM 构建执行，那时节点还不存在。
 */
export function flushRefs(): void {
  if (!pending.length) return;
  const run: RefEntry[] = [];
  const rest: RefEntry[] = [];
  for (const entry of pending) {
    if (entry.el && entry.el.isConnected) run.push(entry);
    else rest.push(entry);
  }
  // 先更新队列再跑回调：回调抛错也不会污染队列状态（不会重复触发）
  pending = rest;
  let firstError: unknown = null;
  for (const entry of run) {
    try {
      const call = () => entry.fn(entry.el);
      const cleanup = entry.owner ? withOwner(entry.owner, call) : call();
      if (typeof cleanup === "function") {
        if (entry.owner && typeof entry.owner.add === "function") {
          entry.owner.add(cleanup);
        }
      }
    } catch (err) {
      if (firstError === null) firstError = err;
    }
  }
  if (firstError !== null) throw firstError;
}
