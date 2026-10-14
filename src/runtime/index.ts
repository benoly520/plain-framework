// Plain 运行时统一入口 —— 对外 API 面恒定，新增即 breaking change

export {
  signal,
  computed,
  effect,
  batch,
  cleanup,
  createScope,
  onCleanup,
  withOwner,
  getOwner,
  resolve,
  stringify,
  getCurrentEffect,
  rowProxy,
  ERROR_HANDLER,
  onError,
} from "./signal.js";

export {
  mount,
  insert,
  when,
  each,
  nodesOf,
  place,
  createSlot,
  syncRange,
  toNodes,
} from "./dom.js";
export { resource, rpc, server, setRpcEndpoint } from "./async.js";
export { ErrorBoundary } from "./error.js";
export { createRouter } from "./router.js";
export { hydrate } from "./hydrate.js";
export type { HydrateOptions, HydrateResult } from "./hydrate.js";
export {
  hmrApply,
  snapshotSignals,
  restoreSignals,
  hmrScope,
  getHmrModuleId,
  __plainBeginModule,
  __clearHmrRegistry,
  __hmrIds,
} from "./hmr.js";

// 命令式 DOM 逃逸口：内建元素 ref={fn} 的运行时支撑（编译器生成 __ref 调用）。
// 归入内部符号（同 __plainBeginModule），不在对外 API 面里。
export { __ref } from "./ref.js";

// 公共类型 + 全局 JSX 命名空间（由 tsc 一并产出到 dist/index.d.ts）
export * from "../types.js";
