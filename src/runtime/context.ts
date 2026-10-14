// Plain Context：跨层传值（依赖注入）+ SSR 请求级隔离
//
// 设计见 docs/rfcs/context-and-ssr-isolation.md。
//
// 机制复用既有的「owner 作用域链」（ErrorBoundary 挂 ERROR_HANDLER 的先例）：
//   - Provider 用 withOwner 开一个嵌套作用域，把「ctx -> value getter」挂在作用域上；
//   - useContext 沿作用域链（从内到外）找最近的注册点，找不到就给默认值。
// 因为「组件一定创建在其父级作用域内」，作用域链天然等于组件树位置；
// 而作用域是**每次渲染现建现收**的 —— 这就是 SSR 请求级隔离的来源：
// 下一个请求拿到的是全新作用域，不可能读到上一个请求的 Provide 值。

import type { Context } from "../types.js";
import { getOwner, getOwnerChain, withOwner, resolve } from "./signal.js";

/** Context 对象上承载「作用域查找键」的私有字段（不进公开类型） */
interface ContextInternal<T> extends Context<T> {
  __key: symbol;
}

/**
 * createContext(defaultValue) —— 创建一个 Context。
 * 必须给默认值：没有 Provider 时读到它，而不是静默的 undefined。
 */
export function createContext<T>(defaultValue: T): Context<T> {
  const key: symbol = Symbol("plain.context");
  const ctx: ContextInternal<T> = {
    __plainContext: true,
    defaultValue,
    __key: key,
    Provider(props: { value: T; children?: any }): Node {
      const parent: any = getOwner();
      const scope = new Set<() => void>();
      // 值以 getter 形式随作用域走：读它时才求值，于是 value 里读到的 signal 变化
      // 能被消费者订阅（消费者在 effect / JSX 里调用 getter）。
      (scope as any)[key] = () => resolve(props.value);
      // 作用域挂在父 owner 上：父卸载 / 行回收 / 分支切换 -> 子树 effect 一并回收，不悬挂。
      if (parent && typeof parent.add === "function") {
        parent.add(() => {
          scope.forEach((f) => f());
          scope.clear();
        });
      }
      let node: any = null;
      withOwner(scope, () => {
        node = props.children ? props.children() : null;
      });
      // children() 由编译器产出一个 Fragment（Node）；无 children 时给个空 Fragment，
      // 保证返回值恒为 Node（满足 JSX.Element）。
      return node || document.createDocumentFragment();
    },
  };
  return ctx;
}

/**
 * useContext(Ctx) -> () => T
 *
 * 返回一个**可调用 getter**，读法与 signal 完全一致：`useContext(Ctx)()`。
 * 之所以不直接返回 T：那样会出现「组件体里存进变量 → 快照住旧值」的静默失败
 * （Plain 最想消灭的东西）。返回 getter 让「快照」在结构上不可能发生。
 */
export function useContext<T>(ctx: Context<T>): () => T {
  const key = (ctx as ContextInternal<T>).__key;
  const chain = getOwnerChain();
  for (let i = chain.length - 1; i >= 0; i--) {
    const owner: any = chain[i];
    if (owner && typeof owner === "object" && key in owner) {
      return owner[key] as () => T;
    }
  }
  return () => ctx.defaultValue;
}
