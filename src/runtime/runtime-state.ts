import { getSSRStore } from './ssr-context.js';
import type { PlainRootState, PlainRuntime } from '../types.js';

interface RuntimeStore {
  phase: 'idle' | 'hydrate' | 'client-render';
  roots: WeakMap<Element, Readonly<PlainRootState>>;
}

const key = Symbol.for('plain.runtime.v1');
const FRAMEWORK_VERSION = '0.7.0';
export const SSR_MARKER = 'plain-ssr:v1';

/** 获取跨运行时副本共享的内部槽；仅在查询或渲染时初始化。 */
function store(): RuntimeStore {
  const global = globalThis as any;
  if (!global[key]) {
    Object.defineProperty(global, key, {
      value: { phase: 'idle', roots: new WeakMap() },
    });
  }
  return global[key];
}

/** 返回调用时的运行时信息快照，不公开全局对象或请求私有数据。 */
export function getRuntimeInfo(): Readonly<PlainRuntime> {
  return Object.freeze({
    schemaVersion: 1 as const,
    frameworkVersion: FRAMEWORK_VERSION,
    environment: typeof process !== 'undefined' && process.versions?.node
      ? 'server' as const : 'browser' as const,
    phase: getSSRStore() ? 'server-render' as const : store().phase,
  });
}

/** 查询单根来源及接管状态，尚未挂载时只认实际 SSR 输出标记。 */
export function getRootInfo(root: Element): Readonly<PlainRootState> | undefined {
  const known = store().roots.get(root);
  if (known) return known;
  const marked = Array.from(root.childNodes).some(
    (node) => node.nodeType === 8 && node.nodeValue === SSR_MARKER,
  );
  return marked
    ? Object.freeze({ origin: 'ssr' as const, hydration: 'not-started' as const, warnings: 0 })
    : undefined;
}

/** 标记同步渲染作用域；嵌套和异常退出时恢复外层阶段。 */
export function withRenderPhase<T>(phase: RuntimeStore['phase'], fn: () => T): T {
  const state = store();
  const previous = state.phase;
  state.phase = phase;
  try {
    return fn();
  } finally {
    state.phase = previous;
  }
}

/** 为单个根保存冻结快照，返回令牌供卸载时防止误删新实例。 */
export function setRootState(root: Element, value: PlainRootState): Readonly<PlainRootState> {
  const snapshot = Object.freeze({ ...value });
  store().roots.set(root, snapshot);
  return snapshot;
}

/** 仅移除属于当前实例的根记录，旧卸载句柄不会影响新实例。 */
export function clearRootState(root: Element, token: Readonly<PlainRootState>): void {
  if (store().roots.get(root) === token) store().roots.delete(root);
}
