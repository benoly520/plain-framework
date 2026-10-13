// Plain HMR 单测：node --test
//
// 覆盖 ROADMAP M4 验收标准：
//   [x] 运行时注册表：mount 的组件挂载点可被 hmrApply 定位
//   [x] 热替换：dispose 旧 effect → 重跑新组件 → 最小重排替换子树（保住身份/顺序）
//   [x] 模块作用域 signal 值尽力保留；不可保留必须显式 console.warn（绝不静默）
//   [x] moduleId 关联：hmrScope / __plainBeginModule 让挂载点与模块自动绑定

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-hmr-"));
const RUNTIME = await import(RUNTIME_URL);
const { mount, signal, hmrApply, snapshotSignals, restoreSignals, __clearHmrRegistry, __plainBeginModule } =
  RUNTIME;

// 编译一个模块（去 TS 类型 → plain 编译 → 改写 import 到 dist 运行时）
let seq = 0;
async function compileModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  const file = path.join(TMP, `${name}-${seq++}.mjs`);
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}-${seq}`);
  return { mod, code };
}

/** 在独立 jsdom 里跑一段逻辑 */
function inDom(html, fn) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    Event: globalThis.Event,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.Element = dom.window.Element;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  try {
    return fn(dom);
  } finally {
    Object.assign(globalThis, saved);
  }
}

// ---------------------------------------------------------------------------
// 1. 注册表：mount 组件后可按 moduleId 命中并热替换
// ---------------------------------------------------------------------------
test("hmrApply 按 moduleId 命中挂载点并热替换", async () => {
  __clearHmrRegistry();
  const { mod: v1 } = await compileModule(
    `
    export function App() { return <div class="v">v1</div>; }
    `,
    "m1"
  );
  const { mod: v2 } = await compileModule(
    `
    export function App() { return <div class="v">v2</div>; }
    `,
    "m1v2"
  );

  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    // 两个模块放在同一「逻辑模块 id」下：先挂 v1，再热替换为 v2
    __plainBeginModule("/src/m1.jsx");
    mount(root, v1.App);
    assert.equal(root.querySelector("div.v").textContent, "v1");

    const applied = hmrApply("/src/m1.jsx", { App: v2.App });
    assert.equal(applied, true, "应命中挂载点");
    assert.equal(root.querySelector("div.v").textContent, "v2", "应替换为 v2");
  });
});

// ---------------------------------------------------------------------------
// 2. 未注册的模块 id：hmrApply 返回 false（不是错误，也不该抛）
// ---------------------------------------------------------------------------
test("hmrApply 对未挂载的模块返回 false", async () => {
  __clearHmrRegistry();
  const applied = hmrApply("/src/never.jsx", { App: () => null });
  assert.equal(applied, false);
});

// ---------------------------------------------------------------------------
// 3. signal 快照：可保留的原始值被迁移
// ---------------------------------------------------------------------------
test("signal 快照迁移原始值", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const count = signal(7);
    export function App() { return <div>{count()}</div>; }
    `,
    "m3"
  );
  mod.count.set(42);
  const snap = snapshotSignals(mod);
  assert.equal(snap.count.value, 42);
  assert.equal(snap.count.ok, true);

  const { mod: fresh } = await compileModule(
    `
    import { signal } from "plain";
    export const count = signal(0);
    export function App() { return <div>{count()}</div>; }
    `,
    "m3b"
  );
  restoreSignals(fresh, snap, "/src/m3.jsx");
  assert.equal(fresh.count(), 42, "新模块 signal 应被迁移为快照值");
});

// ---------------------------------------------------------------------------
// 4. signal 快照：不可保留的值必须显式 console.warn，绝不静默
// ---------------------------------------------------------------------------
test("不可保留的 signal 值显式告警", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const obj = signal({ a: 1 });
    export function App() { return <div>x</div>; }
    `,
    "m4"
  );
  const snap = snapshotSignals(mod);
  assert.equal(snap.obj.ok, false, "对象值应标记为不可保留");

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const { mod: fresh } = await compileModule(
      `
      import { signal } from "plain";
      export const obj = signal(null);
      export function App() { return <div>x</div>; }
      `,
      "m4b"
    );
    restoreSignals(fresh, snap, "/src/m4.jsx");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnings.some((w) => w.includes("obj") && w.includes("无法保留")),
    "应对不可保留的 signal 显式告警：" + JSON.stringify(warnings)
  );
});

// ---------------------------------------------------------------------------
// 5. 热替换保住「未受影响的兄弟子树」：只换挂载点区间，不整页重建
// ---------------------------------------------------------------------------
test("热替换运行时不搬迁无关节点（最小重排）", async () => {
  __clearHmrRegistry();
  const { mod: v1 } = await compileModule(
    `
    export function App() { return <div class="app">A</div>; }
    `,
    "m5"
  );
  const { mod: v2 } = await compileModule(
    `
    export function App() { return <div class="app">B</div>; }
    `,
    "m5v2"
  );

  await inDom("<div id='root'><p id='sibling'>keep me</p></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    const sibling = dom.window.document.getElementById("sibling");
    __plainBeginModule("/src/m5.jsx");
    mount(root, v1.App);

    hmrApply("/src/m5.jsx", { App: v2.App });
    assert.equal(dom.window.document.getElementById("sibling"), sibling, "兄弟节点不应被搬迁");
    assert.equal(root.querySelector("div.app").textContent, "B");
  });
});

// ---------------------------------------------------------------------------
// 6. dispose 后注册表清空：hmrApply 不再命中
// ---------------------------------------------------------------------------
test("unmount 后挂载点从注册表移除", async () => {
  __clearHmrRegistry();
  const { mod } = await compileModule(
    `
    export function App() { return <div class="x">x</div>; }
    `,
    "m6"
  );
  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    __plainBeginModule("/src/m6.jsx");
    const unmount = mount(root, mod.App);
    unmount();
    const applied = hmrApply("/src/m6.jsx", { App: mod.App });
    assert.equal(applied, false, "卸载后不应再命中");
  });
});
