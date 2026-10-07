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
