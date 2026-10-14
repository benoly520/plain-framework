// Plain 官方测试工具包 —— `import { render, fireEvent } from "plain/testing"`
//
// 为什么要有它：Plain 的产物是**纯 DOM**（没有虚拟 DOM），所以「测一个组件」等于
// 「把它挂进一个真实容器、点它、读它产出的 DOM」。没有这套工具时，每份测试都要
// 手搓 container / 事件派发 / 挂载卸载收尾，既啰嗦又容易漏（比如忘了 unmount 导致
// 上一个用例的 effect 串到下一个）。这里把这几件事收成一组零依赖 API。
//
// 设计取舍：
//   - **不并入运行时 API 面**（`plain/testing` 独立子路径）。运行时导出是冻结的，
//     测试工具会随实践演进，两者节奏不同。
//   - **零依赖**：不引 @testing-library/*。它靠「可访问性角色 + 语义查询」，对
//     Plain 这种直接产出 DOM 的框架是过度设计；这里直接给 DOM 查询 + 事件派发。
//   - **同步优先**：signal.set 本就同步 flush（见 signal.ts 的 batch/flush），
//     所以 fireEvent 之后 DOM 已经是最终态，不需要 await。异步数据（resource）用
//     `await flush()` 让微任务跑完。

import { mount } from "../runtime/dom.js";
import { batch, createScope } from "../runtime/signal.js";
import type { Renderable } from "../types.js";

// ---------------------------------------------------------------------------
// DOM 环境
// ---------------------------------------------------------------------------

/** 拿到一个可用的 document：优先全局，没有就报清晰的错（引导装 jsdom） */
function requireDocument(): Document {
  const d =
    (globalThis as any).document ||
    ((globalThis as any).window && (globalThis as any).window.document);
  if (!d) {
    throw new Error(
      "[plain/testing] 找不到 DOM。测试环境请先装一个：\n" +
        "  npm i -D jsdom\n" +
        "  // 然后在跑测试前：\n" +
        "  import { JSDOM } from 'jsdom';\n" +
        "  const dom = new JSDOM('<!doctype html><html><body></body></html>');\n" +
        "  globalThis.window = dom.window; globalThis.document = dom.window.document;\n" +
        "（或直接用 node --test 时加 `--import ./test/setup-dom.mjs` 之类的预载脚本）"
    );
  }
  return d;
}

/** 让所有已排队的微任务跑完 —— 给 resource / await 这类异步用 */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export interface RenderResult {
  /** 承载组件的容器（已挂到 document.body） */
  container: HTMLElement;
  /** 容器当前的 HTML（含认领锚点注释 —— hydrate 测试会用到） */
  html(): string;
  /** 容器内的可见文本（把注释去掉后的 textContent 近似） */
  text(): string;
  /** 容器内查询单个元素；找不到抛错 */
  get(selector: string): Element;
  /** 容器内查询单个元素；找不到返回 null */
  query(selector: string): Element | null;
  /** 容器内查询全部匹配 */
  queryAll(selector: string): Element[];
  /** 按可见文本精确匹配（trim 后相等）找元素；找不到抛错 */
  getByText(text: string): Element;
  /** 按可见文本匹配；找不到返回 null */
  queryByText(text: string): Element | null;
  /** 解挂 + 回收该组件所有 effect，并从 document.body 移除容器 */
  unmount(): void;
}

/**
 * 把组件挂进一个全新的容器并返回查询/解挂 API。
 *
 *   const ui = render(App);
 *   assert.equal(ui.text(), "0");
 *   await fireEvent.click(ui.get("button"));
 *   assert.equal(ui.text(), "1");
 *   ui.unmount();
 *
 * component 可以是 `() => Renderable`（组件函数）、也可以直接是一个已建好的节点。
 */
export function render(
  component: Renderable | (() => Renderable),
  options: { container?: HTMLElement } = {}
): RenderResult {
  const doc = requireDocument();
  const container =
    options.container || doc.createElement("div");

  if (!options.container) {
    // 挂到 body：mount() 需要一个已在文档里的目标（querySelector 语义）
    doc.body.appendChild(container);
  }

  // 用一个 scope 兜住卸载：组件里所有 effect / cleanup 会被一起回收，
  // 避免上一个用例的响应式副作用串进下一个用例（测试间最常见的脏状态来源）。
  // mount() 返回的 unmount 负责移除 DOM 锚点，scope.dispose() 负责回收响应式副作用，
  // 两者都要调用才是干净的卸载。
  let mountUnmount: (() => void) | null = null;
  const scope = createScope(() => {
    mountUnmount = mount(container, component as any);
  });

  const inner = () => container;

  const byText = (text: string): Element | null => {
    const want = text.trim();
    const all = container.querySelectorAll("*");
    for (const el of Array.from(all)) {
      // 只看「自身直接文本」匹配，避免父元素因为包含子元素文本而被误命中
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue || "")
        .join("")
        .trim();
      if (own === want) return el;
      // 叶子节点（没有元素子节点）时允许整段文本匹配
      if (!el.children.length && (el.textContent || "").trim() === want) return el;
    }
    return null;
  };

  return {
    container,
    // 读 innerHTML 只是为了给断言 / 快照用（测试工具是只读消费者，不写 innerHTML）。
    // 契约规则 PLAIN_E1104 对任何 .innerHTML 访问都报 —— 这里是确认过的合法用途，
    // 用行级抑制指令点名豁免（这正是该指令存在的意义）。
    html: () => inner().innerHTML, // plain-ignore-line PLAIN_E1104
    text: () => (inner().textContent || "").trim(),
    get: (selector: string) => {
      const el = inner().querySelector(selector);
      if (!el) throw new Error(`[plain/testing] 找不到元素：${selector}`);
      return el;
    },
    query: (selector: string) => inner().querySelector(selector),
    queryAll: (selector: string) => Array.from(inner().querySelectorAll(selector)),
    getByText: (text: string) => {
      const el = byText(text);
      if (!el) throw new Error(`[plain/testing] 找不到文本为 "${text}" 的元素`);
      return el;
    },
    queryByText: (text: string) => byText(text),
    unmount() {
      scope.dispose();
      // mount 的 unmount 负责移除它插入的锚点 / 节点
      mountUnmount?.();
      // 有些 mount 实现把锚点留在容器里；整容器移除最干净
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

// ---------------------------------------------------------------------------
// fireEvent
// ---------------------------------------------------------------------------

/** 给元素设值（input / textarea / select）并派发对应事件 */
function setValue(el: any, value: any): void {
  // React 风格的值 setter 拦截在 Plain 里不存在，直接写 value 即可；
  // 但 select 要按 option 值选中。
  if (el.tagName === "SELECT") {
    el.value = value;
  } else if (el.type === "checkbox" || el.type === "radio") {
    el.checked = !!value;
  } else {
    el.value = value;
  }
}

function dispatch(el: Element, type: string, init: any = {}): boolean {
  const doc = requireDocument();
  const EventCtor =
    (globalThis as any).Event ||
    (doc as any).defaultView?.Event ||
    Event;
  const ev = new EventCtor(type, { bubbles: true, cancelable: true, ...init });
  // 把常用字段搬上去（jsdom 的 Event 不认 target 之外的任意属性，手动挂）
  for (const k of ["value", "checked", "key", "code"]) {
    if (init[k] !== undefined) (ev as any)[k] = init[k];
  }
  // 事件里跑到的 signal 写入合并成一轮刷新，减少中间态
  return batch(() => el.dispatchEvent(ev));
}

/**
 * 派发真实 DOM 事件。事件回调里对 signal 的写入会被 batch 合并成一轮刷新，
 * 所以调用方**不需要**手动 await —— 返回时 DOM 已是最终态。
 *
 *   await fireEvent.click(button);
 *   await fireEvent.input(input, "hello");
 *   await fireEvent.keyDown(input, { key: "Enter" });
 *
 * 返回一个 thenable（也支持同步调用），方便 `await fireEvent.click(...)` 与
 * `fireEvent.click(...)` 两种写法。
 */
export const fireEvent = {
  click(el: Element) {
    return dispatch(el, "click");
  },
  input(el: Element, value?: any) {
    if (value !== undefined) setValue(el, value);
    return dispatch(el, "input");
  },
  change(el: Element, value?: any) {
    if (value !== undefined) setValue(el, value);
    return dispatch(el, "change");
  },
  submit(el: Element) {
    return dispatch(el, "submit");
  },
  focus(el: Element) {
    // .focus() 本身就会派发 focus 事件（jsdom / 浏览器一致），不要再手动 dispatch
    (el as any).focus?.();
    return undefined;
  },
  blur(el: Element) {
    (el as any).blur?.();
    return undefined;
  },
  keyDown(el: Element, init: { key?: string; code?: string } = {}) {
    return dispatch(el, "keydown", init);
  },
  keyUp(el: Element, init: { key?: string; code?: string } = {}) {
    return dispatch(el, "keyup", init);
  },
  /** 通用逃生口：派发任意事件类型 */
  fire(el: Element, type: string, init: any = {}) {
    return dispatch(el, type, init);
  },
};

// ---------------------------------------------------------------------------
// 便捷断言（可选）
// ---------------------------------------------------------------------------

/** `expectText(ui, "1")` —— 失败信息带实际文本，省得每次手写 */
export function expectText(ui: RenderResult, expected: string): void {
  const actual = ui.text();
  if (actual !== expected) {
    throw new Error(
      `[plain/testing] 文本不匹配\n  期望：${JSON.stringify(expected)}\n  实际：${JSON.stringify(actual)}\n  当前 HTML：${ui.html()}`
    );
  }
}
