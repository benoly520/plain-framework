// eval/harness.mjs —— 评测用最小加载器：把一个 candidate.tsx 变成可运行模块
//
// 关键点：这里**刻意复刻真实构建链路**（契约检查 → 编译），
// 所以「AI 写错了会不会被拦下」在这里和在实际项目里是同一件事。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";
import { check, formatIssues } from "../dist/lint.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-eval-"));

let dom = null;
let seq = 0;

// 需要装到 globalThis 上的浏览器环境（React 也要用，所以比 Plain 需要的多一些）
const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

/** 建立浏览器环境（所有任务共用一份，切勿建第二份 —— 两份 document 会互相看不见） */
export function setupDom() {
  if (dom) return dom;
  if (!fs.existsSync(path.join(ROOT, "dist/runtime/index.js"))) {
    throw new Error("请先 `pnpm run build`（eval 跑的是 dist/，不是 src/）");
  }
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const key of DOM_GLOBALS) {
    const value = dom.window[key];
    if (value === undefined) continue;
    try {
      globalThis[key] = value;
    } catch {
      // Node 21+ 把 navigator 定义成了只读 getter，直接赋值会抛；用 defineProperty 覆盖
      try {
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      } catch {
        // 实在覆盖不了就跳过 —— 缺它不影响 jsdom 下的渲染
      }
    }
  }
  // React 的 act() 需要这个开关，否则会打警告 / 不 flush
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

/**
 * loadCandidate(file) -> { mod, code, out }
 * 与 `plaindev build` 同一条路径：契约检查不过就直接失败。
 */
export async function loadCandidate(file) {
  const source = fs.readFileSync(file, "utf8");

  const issues = check(source, path.basename(file));
  if (issues.length) {
    const err = new Error(
      `契约检查未通过（${issues.length} 处）：\n${formatIssues(
        issues,
        path.basename(file)
      )}`
    );
    // 与 vite 插件保持一致：契约检查失败 = PLAIN_E2001
    err.code = "PLAIN_E2001";
    throw err;
  }

  const stripped = await esbuild.transform(source, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, path.basename(file));
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);

  // 带序号：不同用例的同一个文件名（如两个 plain.tsx）不能撞到同一个模块 URL
  const name = `${path.basename(file, path.extname(file))}-${Date.now()}-${++seq}`;
  const target = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(target, code);
  const mod = await import(pathToFileURL(target).href);
  return { mod, code, out };
}

/**
 * evalServerFn(entry) —— 把编译器物理剥离出来的服务端函数**单独执行**。
 *
 * 这与 vite 插件 dev 模式下的 `evalFn` 是同一条路径（都是 `new Function`），
 * 所以断言到的是「服务端真正会跑的那段代码」，而不是客户端产物里的 RPC 桩。
 * 能这么干的前提，正是编译器保证函数体自包含（`PLAIN_E1006`）。
 */
export function evalServerFn(entry) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${entry.body});`)();
}

/** 造一个干净的挂载容器（每个任务一个，互不污染） */
export function mountBox() {
  const box = document.createElement("div");
  document.body.appendChild(box);
  return { box };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
