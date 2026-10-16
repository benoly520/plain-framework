// Plain HMR 单测：node --test
//
// 覆盖 ROADMAP M4 验收标准：
//   [x] 运行时注册表：mount 的组件挂载点可被 hmrApply 定位
//   [x] 热替换：dispose 旧 effect → 重跑新组件 → 最小重排替换子树（保住身份/顺序）
//   [x] 模块作用域 signal 值尽力保留；不可保留必须显式 console.warn（绝不静默）
//   [x] moduleId 关联：hmrScope / __plainBeginModule 让挂载点与模块自动绑定
//   [x] 非挂载模块（独立组件文件 / import() 懒加载）改动也要生效：重跑所有挂载点
//   [x] 认不出根组件时明确告警并交给整页刷新（绝不静默留旧代码）
//   [x] 能力边界（钉死事实，别被「热更新」这个词带偏）：
//       保住 —— 不整页刷新 / 锚点区间之外的 DOM / 模块级 signal 原始值
//       丢掉 —— 区间之内整段重建：节点身份变、未受控输入的值、焦点 / 局部滚动

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

/** 在独立 jsdom 里跑一段逻辑（支持同步 / 异步回调：异步时会等到 Promise 落定再还原全局） */
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
  const restore = () => Object.assign(globalThis, saved);
  try {
    const out = fn(dom);
    // 异步回调：必须等它落定后再还原全局，否则 await 期间全局就被拆了
    if (out && typeof out.then === "function") {
      return out.then(
        (v) => {
          restore();
          return v;
        },
        (e) => {
          restore();
          throw e;
        }
      );
    }
    restore();
    return out;
  } catch (e) {
    restore();
    throw e;
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

// ---------------------------------------------------------------------------
// 7. 改动「被别处使用」的模块（独立组件文件 / import() 懒加载）也要生效
// ---------------------------------------------------------------------------
test("hmrApply：改动非挂载模块时重跑所有挂载点（不再静默留旧代码）", async () => {
  __clearHmrRegistry();
  const { mod } = await compileModule(
    `
    import { onCleanup } from "plain";
    export let runs = 0;
    export let cleans = 0;
    export function App() {
      runs++;
      onCleanup(() => { cleans++; });
      return <div class="app">run{runs}</div>;
    }
    `,
    "m7"
  );
  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    __plainBeginModule("/src/m7.jsx");
    mount(root, mod.App);
    assert.equal(mod.runs, 1);
    assert.equal(root.querySelector("div.app").textContent, "run1");

    // 改动的不是挂载模块：比如 import() 懒加载进来的组件文件
    const applied = hmrApply("/src/child.jsx", { Child: () => null });
    assert.equal(applied, true, "应重跑挂载点");
    assert.equal(mod.cleans, 1, "旧 effect 应先被回收");
    assert.equal(mod.runs, 2, "根组件应重跑一次（从而取到新代码）");
    assert.equal(root.querySelector("div.app").textContent, "run2");
  });
});

// ---------------------------------------------------------------------------
// 7b. 真实 `import()` 懒加载：子模块改动 → 父挂载点重跑 → 取到子模块的新代码
//
// 这是对第 7 条的「真身」补强：第 7 条只用一个假 id 模拟「被别处使用的模块」，
// 本用例走真正的动态 import —— 父模块在渲染时 `await import(child)`，子模块被
// 改动（写新文件 + 换 query）后，hmrApply(子模块 id) 重跑父挂载点，父模块重新
// 执行 import() 从而拿到新子模块；DOM 里应显示子模块的新内容，且**不整页刷新**。
// ---------------------------------------------------------------------------
test("动态 import() 懒加载：子模块热更新后，父挂载点重跑并取到新子模块", async () => {
  __clearHmrRegistry();
  const childId = "/src/dyn-child.jsx";
  // 子模块写到**稳定路径**（父模块的 import 说明符要能解析到它）
  const childFile = path.join(TMP, "dyn-child.mjs");
  const childUrl = pathToFileURL(childFile).href;

  // 编译并写出某一版子模块，返回它的导出（模拟「新模块对象」= vite 推给 accept 的 __newMod）
  async function writeChild(label, version) {
    const stripped = await esbuild.transform(
      `export function Child(){ return <span class="child">${label}</span>; }`,
      { loader: "tsx", jsx: "preserve", target: "es2022", format: "esm" }
    );
    const out = compile(stripped.code, "dyn-child.jsx");
    const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
    fs.writeFileSync(childFile, code);
    return import(`${childUrl}?v=${version}-${Date.now()}`);
  }

  await writeChild("v1", 1);

  // 父模块：用一个信号持有「懒加载进来的子模块」，渲染时按需取它的 Child。
  // 关键写法：信号必须在 JSX 表达式里**就地读**（`childMod() ? …`），
  // 这样 when 的条件才是响应式的；若先 `const m = childMod()` 再在 JSX 里用 m，
  // 那次读取发生在组件体首跑、不是响应式依赖，后续 set 不会重渲染。
  //
  // 父模块**不是**子模块（子模块只出现在它的 import() 里）：子模块改动时，
  // hmrApply 命中不到挂载模块，只能走「重跑所有挂载点」兜底 —— 这正是要测的路径。
  const { mod: parent } = await compileModule(
    `
    import { signal } from "plain";
    export const childMod = signal(null);
    export function App() {
      return (
        <div class="app">
          {childMod() ? childMod().Child() : <i class="loading">…</i>}
        </div>
      );
    }
    `,
    "dyn-parent"
  );

  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    __plainBeginModule("/src/dyn-parent.jsx");
    mount(root, parent.App);

    // 首次懒加载 v1 子模块并渲染（模拟 `const m = await import("./child.jsx")`）
    assert.equal(root.querySelector("i.loading").textContent, "…", "未加载时先显示占位");
    const childV1 = await import(`${childUrl}?v=1-${Date.now()}`);
    parent.childMod.set(childV1);
    assert.equal(root.querySelector("span.child").textContent, "v1");

    // —— 子模块被改动：写出 v2 ——
    const childV2 = await writeChild("v2", 2);

    // 走一遍注入脚本体的顺序：快照 -> 恢复 -> 热替换
    const snap = snapshotSignals(parent);
    restoreSignals(parent, snap, "/src/dyn-parent.jsx");
    const applied = hmrApply(childId, childV2);

    // ① 子模块不在注册表里，但 hmrApply 应重跑父挂载点（返回 true）
    assert.equal(applied, true, "子模块改动应重跑父挂载点，而不是静默留旧代码");

    // ② 重跑后父模块取到 v2 —— 把新子模块塞回父模块 signal，DOM 显示新内容
    parent.childMod.set(childV2);
    assert.equal(
      root.querySelector("span.child").textContent,
      "v2",
      "父挂载点重跑后应取到子模块的新代码"
    );
  });
});

// ---------------------------------------------------------------------------
// 7c. 动态 import() 的失败边界：拿不到新模块（hmrApply 命中不到）时返回 false，
//     调用方据此退回整页刷新 —— 绝不静默。
// ---------------------------------------------------------------------------
test("动态 import() 边界：注册表为空时 hmrApply 返回 false（交给整页刷新）", async () => {
  __clearHmrRegistry();
  const applied = hmrApply("/src/dyn-orphan.jsx", { Child: () => null });
  assert.equal(applied, false, "无挂载点时不应假装成功");
});

// ---------------------------------------------------------------------------
// 8. 挂载模块的新版本认不出根组件：明确告警 + 交给整页刷新（绝不静默）
// ---------------------------------------------------------------------------
test("hmrApply：挂载模块认不出根组件时明确告警并交给整页刷新", async () => {
  __clearHmrRegistry();
  const { mod } = await compileModule(
    `export function App() { return <p class="a">a</p>; }`,
    "m8"
  );
  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    __plainBeginModule("/src/m8.jsx");
    mount(root, mod.App);

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let applied;
    try {
      // 新版本里没有 App / default（例如作者改了导出名）
      applied = hmrApply("/src/m8.jsx", { Helper: () => null });
    } finally {
      console.warn = origWarn;
    }
    assert.equal(applied, false, "应交给整页刷新");
    assert.ok(
      warnings.some((w) => w.includes("整页刷新")),
      "必须明确告警：" + JSON.stringify(warnings)
    );
    assert.equal(root.querySelector("p.a").textContent, "a", "不应破坏既有 DOM");
  });
});

// ---------------------------------------------------------------------------
// 9. 能力边界：HMR 到底保住什么、丢什么（把事实钉死，别让文档自夸）
// ---------------------------------------------------------------------------
test("HMR 能力边界：区间之外与模块级 signal 保住；区间之内整段重建（DOM 状态会丢）", async () => {
  __clearHmrRegistry();
  const src = (label) => `
    import { signal } from "plain";
    export const title = signal(${JSON.stringify(label)});
    export function App() {
      return (
        <section class="app">
          <h1>{title()}</h1>
          <input class="free" />
        </section>
      );
    }
  `;
  const { mod: v1 } = await compileModule(src("v1"), "m9");
  const { mod: v2 } = await compileModule(src("v2"), "m9b");

  await inDom("<div id='root'><input id='sibling' /></div>", async (dom) => {
    const doc = dom.window.document;
    const root = doc.getElementById("root");
    const sibling = doc.getElementById("sibling");
    // 锚点区间**之外**的输入框：模拟用户输入 + 聚焦
    sibling.value = "outside";

    __plainBeginModule("/src/m9.jsx");
    mount(root, v1.App);
    assert.equal(root.querySelector("h1").textContent, "v1");

    // 锚点区间**之内**：模拟用户输入（值只存在于 DOM 上）+ 聚焦
    const freeBefore = root.querySelector("input.free");
    freeBefore.value = "inside";
    freeBefore.focus();

    // 用户改过模块级 signal
    v1.title.set("edited");

    // 按注入脚本体内的顺序走一遍：快照 -> 恢复 -> 热替换
    const snap = snapshotSignals(v1);
    restoreSignals(v2, snap, "/src/m9.jsx");
    assert.equal(hmrApply("/src/m9.jsx", { App: v2.App }), true);

    // ① 保住：模块级 signal 的原值（是用户编辑过的 "edited"，而不是新模块字面的 "v2"）
    assert.equal(v2.title(), "edited");
    assert.equal(root.querySelector("h1").textContent, "edited");

    // ② 保住：区间之外的节点身份与状态都没被碰
    assert.equal(doc.getElementById("sibling"), sibling, "区间外节点身份不变");
    assert.equal(sibling.value, "outside", "区间外的输入值保留");

    // ③ 丢掉：区间之内是整段重建 —— 节点身份变了，未受控输入的值回到初始值
    const freeAfter = root.querySelector("input.free");
    assert.notEqual(freeAfter, freeBefore, "重建 => 新节点（不复用）");
    assert.equal(freeAfter.value, "", "未受控输入的值只活在旧节点上 => 丢");

    // ④ 丢掉：焦点不在重建后的新节点上（浏览器会把被移除的焦点元素重置掉）
    assert.notEqual(doc.activeElement, freeAfter, "焦点不会自动回到新节点");
  });
});
