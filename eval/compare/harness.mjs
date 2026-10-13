// eval/compare/harness.mjs —— 框架对比用的两个适配器
//
// 设计目标只有一个：**让同一个 check.mjs 能同时跑 Plain 与 React 的候选实现**。
// 所以框架差异全部收在适配器里，check.mjs 只依赖 DOM 与四个统一方法：
//
//   render(name) —— 渲染候选模块导出的组件，返回 { box }
//   act(cb)      —— 提交一次交互（React 需要它来 flush；Plain 是同步的，直接执行）
//   type(el, s)  —— 往输入框里打字（两个框架都用同一条原生 input 事件路径）
//   byText(...)  —— 按可见文本找元素（找不到就报出实际有哪些，便于定位）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { loadCandidate, mountBox } from "../harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, ".tmp");

let seq = 0;

/** 按可见文本找元素；找不到时把实际文本列出来 */
export function byText(box, selector, text) {
  const all = Array.from(box.querySelectorAll(selector));
  const hit = all.find((el) => el.textContent.trim() === text);
  if (hit) return hit;
  const seen = all.map((el) => JSON.stringify(el.textContent.trim())).join(", ");
  throw new Error(`找不到 ${selector}（文本应为 "${text}"）；实际有：${seen || "（一个都没有）"}`);
}

/**
 * 往输入框里打字。
 * 必须走原型上的 value setter —— 直接 `el.value = x` 会被 React 的 value tracker
 * 认为「值没变」，onChange 不触发（这是 React 的经典坑，也是两边共用同一条路径的原因）。
 */
export function typeInto(el, text) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  desc.set.call(el, text);
  el.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
}

/** 写一个临时模块，放在 .tmp/ 里，好让裸导入（react / react-dom）能正常解析 */
function writeTemp(label, code) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${label}-${Date.now()}-${++seq}.mjs`);
  fs.writeFileSync(file, code);
  return pathToFileURL(file).href;
}

// ---------------------------------------------------------------------------
// Plain 侧
// ---------------------------------------------------------------------------

/**
 * Plain 适配器：走与 `plaindev build` 同一条路径（契约检查 + 编译 + 剥离），
 * 所以「被 lint 拦下」在这里和在真实项目里是同一件事 —— 那是 Plain 免疫系统的一部分，
 * 也是对比时要如实计入的（见 README 的公平性说明）。
 */
export async function makePlainApi(file) {
  const { mod, code, out } = await loadCandidate(file);
  return {
    mod,
    code,
    out,
    api: {
      async render(name = "App") {
        const { box } = mountBox();
        box.appendChild(mod[name]());
        return { box };
      },
      async act(cb) {
        return cb();
      },
      type: typeInto,
      byText,
    },
  };
}

// ---------------------------------------------------------------------------
// React 侧
// ---------------------------------------------------------------------------

/** React 适配器：JSX 走 esbuild 的 automatic runtime，渲染/交互用 act 包起来 */
export async function makeReactApi(file) {
  const source = fs.readFileSync(file, "utf8");
  const transformed = await esbuild.transform(source, {
    loader: file.endsWith(".jsx") ? "jsx" : "tsx",
    jsx: "automatic",
    jsxImportSource: "react",
    target: "es2022",
    format: "esm",
  });

  const React = await import("react");
  const act = React.act || (await import("react-dom/test-utils")).act;
  const { createRoot } = await import("react-dom/client");

  const href = writeTemp("react", transformed.code);
  const mod = await import(href);

  return {
    mod,
    code: transformed.code,
    out: null,
    api: {
      async render(name = "App") {
        const { box } = mountBox();
        const root = createRoot(box);
        await act(async () => {
          root.render(React.createElement(mod[name]));
        });
        return { box };
      },
      async act(cb) {
        await act(async () => {
          await cb();
        });
      },
      type: typeInto,
      byText,
    },
  };
}
