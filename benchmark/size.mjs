// benchmark/size.mjs —— 框架 + 最小应用 的打包体积对比（raw + gzip）
//
// 这是「企业选型最关心的硬指标之一」的起步件：同样做一个最小化应用，
// Plain 的运行时被编译进产物后的体积，对比 React + ReactDOM 的体积。
//
// 注意：这里对比的是「框架自身 + 一个极小的计数器应用」的体积，
// 不是运行时渲染性能（后者需要真实浏览器，见 benchmark/README.md 的「运行时基准」）。
//
// 用法：
//   pnpm run build            # 先把框架源码编译进 dist/
//   node benchmark/size.mjs
import esbuild from "esbuild";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeEntry = path.resolve("dist/runtime/index.js");
if (!fs.existsSync(runtimeEntry)) {
  console.error("找不到 dist/runtime/index.js，请先 `pnpm run build` 编译框架。");
  process.exit(1);
}

// 两个「最小计数器应用」：UI 等价，只换框架。
const plainApp = `
import { signal, computed, mount } from ${JSON.stringify(runtimeEntry)};
const count = signal(0);
const double = computed(() => count() * 2);
function App() {
  const el = document.createElement("button");
  el.textContent = "加一";
  el.addEventListener("click", () => count.set(count() + 1));
  const p = document.createElement("p");
  p.textContent = String(double());
  return [el, p];
}
mount(document.body, App());
`;

const reactApp = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
function App() {
  const [count, setCount] = useState(0);
  return null;
}
createRoot(document.body).render(null);
`;

// 临时文件必须放在仓库根目录下：否则 esbuild 从 /tmp 解析不到 node_modules 里的 react
const tmp = fs.mkdtempSync(path.join(process.cwd(), ".plain-bench-"));
const plainFile = path.join(tmp, "plain.mjs");
const reactFile = path.join(tmp, "react.mjs");
fs.writeFileSync(plainFile, plainApp);
fs.writeFileSync(reactFile, reactApp);

async function bundle(file, external) {
  const out = await esbuild.build({
    entryPoints: [file],
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    external,
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const raw = Buffer.byteLength(code, "utf8");
  const gzip = zlib.gzipSync(code).length;
  return { raw, gzip };
}

const plain = await bundle(plainFile, []);
// React 走 node_modules 打包（不 external，真实反映「应用产物里要带多少框架」）
const react = await bundle(reactFile, []);

const kb = (n) => (n / 1024).toFixed(1) + " KB";
const ratio = ((react.gzip / plain.gzip) * 100).toFixed(0);

console.log("\n最小应用（计数器）+ 框架 —— 打包体积对比（minify + gzip）");
console.log("=".repeat(60));
console.log(`${"方案".padEnd(14)}${"raw".padStart(12)}${"gzip".padStart(12)}`);
console.log("-".repeat(60));
console.log(`${"Plain".padEnd(14)}${kb(plain.raw).padStart(12)}${kb(plain.gzip).padStart(12)}`);
console.log(`${"React".padEnd(14)}${kb(react.raw).padStart(12)}${kb(react.gzip).padStart(12)}`);
console.log("-".repeat(60));
console.log(`React 的 gzip 体积约为 Plain 的 ${ratio}%（越小越好）。`);
console.log("注意：本脚本只量体积，不量运行时性能；运行时基准见 benchmark/README.md。\n");

fs.rmSync(tmp, { recursive: true, force: true });
