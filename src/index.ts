// Plain 顶层入口：让 package 的 "types" 指向 dist/index.d.ts
// 运行时的默认入口仍在 dist/runtime/index.js（见 package.json exports）。

export * from "./runtime/index.js";
