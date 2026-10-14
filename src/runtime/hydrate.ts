// Plain SSR 注水：hydrate(container, App)
//
// 与 SSR 同源 —— 都靠「换掉 globalThis.document」让同一份编译产物跑起来：
//   - SSR：认领式 document = 零依赖的服务端 DOM 垫片（产出 HTML）
//   - hydrate：认领式 document = 从服务端已渲染的 DOM 里「按游标取节点」
//
// 结果：编译产物里的 createElement/createTextNode/createComment 拿到的都是
// 服务端真实节点，**节点对象身份保持不变**（不整树重建）。
//
// 未注水时 mount() 完全不碰这条路径，行为零变化。

import type { Renderable } from "../types.js";
import { withOwner } from "./signal.js";
import {
  beginHydrate,
  endHydrate,
  assertConsumed,
  type HydrationWarning,
} from "./hydration-context.js";
import { makeClaimDocument } from "./claim-document.js";
import { hmrRegister, getHmrModuleId } from "./hmr.js";
import { syncRange, toNodes } from "./dom.js";
import { flushRefs } from "./ref.js";

export interface HydrateOptions {
  /**
   * 服务端/客户端不一致时是否「就地修正」（默认 true）。
   * false 时保留服务端节点、只记录告警，适合对首屏稳定性要求极高的场景。
   */
  recover?: boolean;
  /** 是否把告警打印到控制台（默认 true，dev 下建议开启） */
  warn?: boolean;
  /** HMR 模块标识（vite 插件注入；提供后该子树支持热替换） */
  moduleId?: string;
}

export interface HydrateResult {
  /** 回收整棵注水子树（effect / 事件等） */
  dispose: () => void;
  /** 注水过程中收集到的告警（mismatch / extra / unclaimed） */
  warnings: HydrationWarning[];
}

/**
 * hydrate(container, App) —— 复用 container 里服务端已渲染的 DOM，绑定响应式与事件。
 *
 * 用法：
 *   const { dispose } = hydrate(document.getElementById("app")!, App);
 */
export function hydrate(
  container: Element,
  App: () => Renderable,
  options: HydrateOptions = {}
): HydrateResult {
  const { recover = true, warn: doWarn = true, moduleId } = options;
  // 以容器所属 document 为准（而非可能被 SSR 垫片污染的 globalThis.document）
  const realDoc: Document = (container.ownerDocument || (globalThis as any).document) as Document;
  const win: any = (realDoc as any).defaultView || (globalThis as any).window;
  // 记录进入前的全局，认领结束后**恢复到容器所属文档**——
  // 若此前 globalThis.document 是服务端垫片（SSR 未清理），还原成垫片会让
  // 后续 hydration 之外的新建操作产出 shim 节点（节点挂父级时报只读错）。
  const prevDoc = (globalThis as any).document;

  // 根锚点：包住「整个 App 的输出区间」。它们是普通注释，不参与认领游标
  // （游标在 root 子树里走，锚点插在区间的两端之外），因此不会干扰认领。
  const startMark = realDoc.createComment("plain-root]");
  const endMark = realDoc.createComment("plain-/root]");

  let warnings: HydrationWarning[] = [];
  let cleanups = new Set<() => void>();
  let live: Node[] = [];

  /**
   * 首次认领：进入认领模式 → 跑 App（其 createElement 等就地认领服务端节点）
   * → 把认领到的节点收进容器（保持身份）→ 两端插锚点。
   */
  const claim = (comp: () => Renderable): void => {
    beginHydrate(container, { recover });
    (globalThis as any).document = makeClaimDocument(realDoc);
    let node: Renderable = null;
    try {
      withOwner(cleanups, () => {
        node = comp();
      });
      assertConsumed(container);
    } finally {
      warnings = endHydrate();
      // 恢复到「容器所属文档」，而不是进入前的值：进入前可能被 SSR 垫片占用
      (globalThis as any).document = realDoc;
      // 全局 Node/Element 等构造器同样指向容器所属 window（SSR 垫片会覆盖它们）
      if (win) {
        (globalThis as any).Node = win.Node;
        (globalThis as any).Element = win.Element;
        (globalThis as any).HTMLElement = win.HTMLElement;
        (globalThis as any).Event = win.Event;
        (globalThis as any).window = win;
      }
      void prevDoc;
    }

    // 把 App 产出的节点安放好：认领到的节点可能已被 append 进一个 fragment，
    // 这里统一取出来按顺序放到容器里（节点对象身份不变）。已在容器中的则不动。
    const nodes = toNodes(node);
    // 先插起始锚点，再放内容，最后放结束锚点 —— 顺序即文档顺序
    container.insertBefore(startMark, container.firstChild);
    let ref: Node | null = startMark.nextSibling;
    const inserted: Node[] = [];
    for (const n of nodes) {
      if (n === startMark || n === endMark) continue;
      if ((n as any).parentNode !== container) {
        container.insertBefore(n, ref);
      }
      inserted.push(n);
      ref = n.nextSibling;
    }
    container.insertBefore(endMark, ref);
    live = inserted;
    // 清掉认领后可能残留的、未被认领的服务端节点（它们在 startMark 之前）
    pruneBefore(container, startMark);
    // 认领完成、节点已归位 -> 跑掉这一棵注水子树的 ref 回调（见 ref.ts）
    flushRefs();
  };

  /**
   * 热替换：用新的 comp 重建子树 —— 走非认领模式（正常 build DOM），
   * 再经 syncRange 替换锚点区间内的内容（区间之内整段重建、不复用节点；
   * 区间之外的节点身份不变）。
   */
  const rebuild = (comp: () => Renderable): void => {
    cleanups = new Set<() => void>();
    let node: Renderable = null;
    withOwner(cleanups, () => {
      node = comp();
    });
    const nodes = toNodes(node);
    syncRange(startMark, endMark, nodes);
    live = nodes;
  };

  claim(App);

  if (doWarn && warnings.length) {
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[plain hydrate] ${w.message}`);
    }
  }

  const dispose = () => {
    cleanups.forEach((f) => f());
    cleanups.clear();
    live.forEach((n) => (n as any).remove && (n as any).remove());
  };

  hmrRegister({
    // 显式 moduleId 优先；否则取当前模块作用域 id（vite 插件注入）；再兜底固定名
    id: moduleId ?? getHmrModuleId() ?? "__hydrate__",
    container,
    comp: App,
    // 热替换：只回收旧 effect 与旧节点（DOM 由 rebuild 的 syncRange 做最小重排）
    dispose: dispose,
    rebuild,
  });

  return { dispose, warnings };
}

/** 移除容器里位于 beforeMark 之前的节点（认领后未被采用的残留） */
function pruneBefore(container: Element, beforeMark: Node): void {
  let n = container.firstChild;
  while (n && n !== beforeMark) {
    const next = n.nextSibling;
    const cur = n;
    n = next;
    // 只清理元素 / 文本 / 注释；锚点本身已在边界之外
    (cur as any).remove && (cur as any).remove();
  }
}
