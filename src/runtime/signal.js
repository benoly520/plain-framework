// Plain 响应式内核：signal / computed / effect / 作用域回收 / 批处理
//
// 设计约束（面向 AI）：
//   1. 只有一个状态原语：signal。读 s()，写 s.set(v)。
//   2. 依赖自动收集，没有 deps 数组、没有 hook 顺序要求。
//   3. 每个 effect 都可回收（dispose），由 owner 作用域统一管理，杜绝泄漏。

let activeEffect = null;
const effectStack = [];
let activeOwner = null; // Set<dispose fn>：当前所属作用域
const ownerStack = []; // withOwner 的嵌套栈，用于向上查找错误处理器

/** 挂在 owner Set 上的错误处理器标记 */
export const ERROR_HANDLER = Symbol("plain.errorHandler");

/** 在最近的 ErrorBoundary 里注册错误处理回调 */
export function onError(handler) {
  if (activeOwner) activeOwner[ERROR_HANDLER] = handler;
}

export function getCurrentEffect() {
  return activeEffect;
}

export function cleanup(effect) {
  effect.deps.forEach((s) => s.subs.delete(effect));
  effect.deps.clear();
}

/**
 * effect(fn, owner?)
 * 返回值本身就是该 effect 对象，e.dispose() 可回收。
 */
export function effect(fn, owner) {
  const e = {
    deps: new Set(),
    fn,
    disposed: false,
    // 创建时快照下来的 owner 链：运行期抛错时用它找最近的 ErrorBoundary
    // （不能用运行时的 ownerStack —— effect 重跑时那条栈早就空了）
    ownerChain: ownerStack.length ? ownerStack.slice() : null,
    run() {
      if (e.disposed) return;
      cleanup(e);
      activeEffect = e;
      effectStack.push(e);
      try {
        return fn();
      } catch (err) {
        // 沿创建时的 owner 链向上找最近的 ErrorBoundary；
        // 没人接管就抛出 —— 静默失败对 AI 调试是灾难
        const chain = e.ownerChain || [];
        for (let i = chain.length - 1; i >= 0; i--) {
          const h = chain[i][ERROR_HANDLER];
          if (h) {
            try {
              h(err);
            } catch (_) {
              break;
            }
            return;
          }
        }
        throw err;
      } finally {
        effectStack.pop();
        activeEffect = effectStack[effectStack.length - 1] || null;
      }
    },
    dispose() {
      if (e.disposed) return;
      e.disposed = true;
      cleanup(e);
      queue.delete(e);
    },
  };
  if (owner) owner.add(e.dispose);
  else if (activeOwner) activeOwner.add(e.dispose);
  e.run();
  if (e.disposed) return e; // 运行中 Dispose 了自己（例如 ErrorBoundary 回收旧分支）
  return e;
}

/** 批处理：batch(() => { a.set(1); b.set(2); }) 内的多次写入只触发一轮 effect */
let batchDepth = 0;
const queue = new Set();

export function batch(fn) {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flush();
  }
}

function flush() {
  let guard = 0;
  while (queue.size) {
    if (++guard > 10000) {
      queue.clear();
      throw new Error("[plain] 检测到响应式死循环（effect 反复自触发）");
    }
    const effects = Array.from(queue);
    queue.clear();
    effects.forEach((e) => {
      if (!e.disposed) e.run();
    });
  }
}

/** 创建一个可整体回收的作用域 */
export function createScope(fn) {
  const cleanups = new Set();
  const dispose = () => {
    cleanups.forEach((c) => c());
    cleanups.clear();
  };
  const prev = activeOwner;
  activeOwner = cleanups;
  try {
    const value = fn(dispose);
    return { value, dispose };
  } finally {
    activeOwner = prev;
  }
}

/** 注册清理回调（组件 / 节点卸载时执行） */
export function onCleanup(fn) {
  if (activeOwner) activeOwner.add(fn);
}

/**
 * signal —— 唯一状态原语
 * 读取 s()，写入 s.set(x)；也支持 s.set(x => next) 函数式更新。
 */
export function signal(initial) {
  const s = { value: initial, subs: new Set() };
  const read = function () {
    if (activeEffect) {
      s.subs.add(activeEffect);
      activeEffect.deps.add(s);
    }
    return s.value;
  };
  read.peek = () => s.value;
  read.set = function (next) {
    const v = typeof next === "function" ? next(s.value) : next;
    if (Object.is(v, s.value)) return v;
    s.value = v;
    const subs = Array.from(s.subs);
    if (batchDepth > 0) {
      subs.forEach((e) => queue.add(e));
      return v;
    }
    subs.forEach((e) => {
      if (!e.disposed) e.run();
    });
    return v;
  };
  read.subs = s.subs;
  return read;
}

/** computed(fn) —— 派生值，读法与 signal 完全一致 */
export function computed(fn, owner) {
  const out = signal(undefined);
  effect(() => out.set(fn()), owner);
  return out;
}

export function stringify(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** 在指定 owner（Set of dispose fn）下执行，把子树的 effect 归入可回收作用域 */
export function withOwner(ownerSet, fn) {
  const prev = activeOwner;
  activeOwner = ownerSet;
  ownerStack.push(ownerSet);
  try {
    return fn();
  } finally {
    ownerStack.pop();
    activeOwner = prev;
  }
}

export function getOwner() {
  return activeOwner;
}

/**
 * resolve(v) —— 编译器对动态 props 一律传 getter；组件里统一用 resolve 取值。
 * （on* 开头的事件类 prop 编译器不包 getter，直接使用。）
 */
export function resolve(v) {
  return typeof v === "function" ? v() : v;
}

/**
 * rowProxy(getRow) —— 列表行代理。
 * 任何属性读取都会先读该行的 signal，从而让行内绑定自动订阅 —— 这是
 * “勾选待办 UI 不更新” 这个致命 bug 的根治手段，也让 AI 不必手写 key / memo。
 */
export function rowProxy(getRow) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const row = getRow();
        if (row === null || row === undefined) return undefined;
        if (prop === Symbol.toPrimitive || prop === "toString") {
          return () => String(row);
        }
        return row[prop];
      },
      set(_t, prop, value) {
        const row = getRow();
        if (row) row[prop] = value;
        return true;
      },
      has(_t, prop) {
        const row = getRow();
        return row ? prop in row : false;
      },
      ownKeys() {
        const row = getRow();
        return row ? Reflect.ownKeys(row) : [];
      },
      getOwnPropertyDescriptor(_t, prop) {
        const row = getRow();
        if (!row) return undefined;
        return { configurable: true, enumerable: true, value: row[prop] };
      },
    }
  );
}
