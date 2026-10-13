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

/** 建立浏览器环境（所有任务共用一份） */
export function setupDom() {
  if (dom) return dom;
  if (!fs.existsSync(path.join(ROOT, "dist/runtime/index.js"))) {
    throw new Error("请先 `pnpm run build`（eval 跑的是 dist/，不是 src/）");
  }
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
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
    err.lintWouldFailBuild = true;
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

  const name = `${path.basename(file, path.extname(file))}-${Date.now()}`;
  const target = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(target, code);
  const mod = await import(pathToFileURL(target).href);
  return { mod, code, out };
}

/** 造一个干净的挂载容器（每个任务一个，互不污染） */
export function mountBox() {
  const box = document.createElement("div");
  document.body.appendChild(box);
  return { box };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
