// Plain 顶层入口：让 package 的 "types" 指向 dist/index.d.ts
// 运行时的默认入口仍在 dist/runtime/index.js（见 package.json exports）。

export * from "./runtime/index.js";
// 错误目录 —— 工具链（IDE / CI / MCP / 自定义 lint 报告）查询码与短名映射
export {
  ERROR_CATALOG,
  LINT_RULE_CODES,
  ruleNameOf,
  codeOfRule,
  legacyCode,
} from "./errors.js";
export type {
  PlainErrorCode as PlainErrorCodeId,
  LintRuleName,
  ErrorEntry,
} from "./errors.js";
