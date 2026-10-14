// ref 命令式 DOM 逃逸口单测：编译器 + 运行时（连接时机 / 清理 / 列表 / 条件 / SSR / 注水）
//
// 覆盖 docs/rfcs/ref-escape-hatch.md 的验收标准：
//   - ref={fn} 在元素连入文档后被调用一次，el 即该元素
//   - 回调返回的清理函数随 owner 回收（卸载 / 行删除 / 分支切换）
//   - SSR 期间不执行；hydrate 认领后执行一次
//   - PLAIN_E1009 / E1010 / E1011 正反测试
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
const TESTING_URL = pathToFileURL(path.join(ROOT, "dist/testing/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ref-"));

let seq = 0;
/** 编译 TSX 并把 import 指向 dist 运行时 / testing */
async function compileModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code
    .replace(/from\s+["']plain\/testing["']/g, `from "${TESTING_URL}"`)
    .replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  const file = path.join(TMP, `${name}-${seq++}.mjs`);
  fs.writeFileSync(file, code);
  return import(pathToFileURL(file).href + `?v=${Date.now()}-${seq}`);
}

/** 在独立 jsdom 环境里跑（隔离 document），支持 async 回调 */
async function inDom(fn) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
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
    return await fn(dom);
  } finally {
    Object.assign(globalThis, saved);
  }
}

const RUNTIME = await import(RUNTIME_URL);

// ---------------------------------------------------------------------------
// 编译器
// ---------------------------------------------------------------------------

test("编译：ref={fn} 生成 __ref 调用，不落到 DOM 属性", () => {
  const { code } = compile(
    'export function App(){ return <canvas ref={(el) => { el.getContext("2d"); }} />; }',
    "r.jsx"
  );
  assert.ok(code.includes("__ref(__el"), "应生成 __ref 调用：" + code);
  assert.ok(!code.includes('setAttribute("ref"'), "ref 不能当普通属性");
  assert.ok(code.startsWith("import { effect as __effect"), "helper import 仍占一行");
  assert.ok(code.includes("__ref"), "helper import 应含 __ref");
});

test("编译：ref 回调返回清理函数时原样透传", () => {
  const { code } = compile(
    "export function App(){ return <div ref={(el) => { return () => el.remove(); }} />; }",
    "rc.jsx"
  );
  assert.match(code, /__ref\(__el\d+, \(el\) => \{ return \(\) => el\.remove\(\); \}\);/);
});

test("编译：组件上的 ref 报 PLAIN_E1009", () => {
  assert.throws(
    () =>
      compile(
        'function Card(p){ return <div/>; } export function App(){ return <Card ref={(el) => el} />; }',
        "c.jsx"
      ),
    /PLAIN_E1009/
  );
});

test("编译：ref 值非函数报 PLAIN_E1010（裸 ref / 字符串 / 对象字面量 / 返回 JSX）", () => {
  const cases = [
    "export function App(){ return <div ref />; }",
    'export function App(){ return <div ref="x" />; }',
    "export function App(){ return <div ref={{}} />; }",
    "export function App(){ return <div ref={[1]} />; }",
    "export function App(){ return <div ref={(el) => <b/>} />; }",
  ];
  for (const src of cases) {
    assert.throws(() => compile(src, "bad.jsx"), /PLAIN_E1010/, src);
  }
});

test("编译：async ref 报 PLAIN_E1011", () => {
  assert.throws(
    () => compile("export function App(){ return <div ref={async (el) => {}} />; }", "a.jsx"),
    /PLAIN_E1011/
  );
});

// ---------------------------------------------------------------------------
// 运行时：连接时机与元素身份
// ---------------------------------------------------------------------------

test("运行时：元素连入文档后才调用 ref，拿到的是该元素", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `export function App(){
        return <div><canvas ref={(el) => {
          el.setAttribute("data-connected", String(el.isConnected));
          el.setAttribute("data-tag", el.tagName);
        }} /></div>;
      }`,
      "Basic"
    );
    const ui = render(mod.App);
    const cv = ui.get("canvas");
    assert.equal(cv.getAttribute("data-connected"), "true", "回调应在已连接后执行");
    assert.equal(cv.getAttribute("data-tag"), "CANVAS");
    ui.unmount();
  });
});

test("运行时：写在 ref 回调里的 effect 归该元素、且节点已就绪", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal, effect } from "plain";
       export const out = signal("");
       export function App(){
         return <div><input ref={(el) => { effect(() => { out.set(el.tagName); }); }} /></div>;
       }`,
      "Order"
    );
    const ui = render(mod.App);
    assert.equal(mod.out(), "INPUT", "ref 回调里建的 effect 应立即拿到已就绪的节点");
    ui.unmount();
  });
});

// ---------------------------------------------------------------------------
// 运行时：清理
// ---------------------------------------------------------------------------

test("运行时：ref 清理函数在卸载时执行", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `export let cleaned = 0;
       export function App(){
         return <div ref={(el) => { el.setAttribute("data-ok", "1"); return () => { cleaned++; }; }} />;
       }`,
      "Cleanup"
    );
    const ui = render(mod.App);
    assert.equal(ui.get("div").getAttribute("data-ok"), "1");
    assert.equal(mod.cleaned, 0, "卸载前不应清理");
    ui.unmount();
    assert.equal(mod.cleaned, 1, "清理函数应在卸载时执行");
  });
});

test("运行时：when 分支切换会跑旧分支的 ref 清理", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal } = RUNTIME;
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal } from "plain";
       export const show = signal(true);
       export let connected = 0;
       export let cleaned = 0;
       export function App(){
         return <div>
           <button onClick={() => show.set(!show())}>t</button>
           {show()
             ? <b ref={() => { connected++; return () => { cleaned++; }; }}>A</b>
             : <i>B</i>}
         </div>;
       }`,
      "When"
    );
    const ui = render(mod.App);
    assert.equal(mod.connected, 1, "then 分支的 ref 应触发");
    fireEvent.click(ui.get("button")); // 切到 else：旧分支清理
    assert.equal(mod.cleaned, 1, "切走时旧分支 ref 应清理");
    fireEvent.click(ui.get("button")); // 切回 then：重建 -> 再次连接
    assert.equal(mod.connected, 2, "切回时新分支 ref 应再次触发");
    ui.unmount();
  });
});

test("运行时：each 行删除会跑该行的 ref 清理；保留行不重复触发", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal } from "plain";
       export const items = signal(["a", "b"]);
       export let connected = 0;
       export let cleaned = 0;
       export function App(){
         return <ul>{items().map((x) => (
           <li ref={() => { connected++; return () => { cleaned++; }; }}>{x}</li>
         ))}</ul>;
       }`,
      "Each"
    );
    const ui = render(mod.App);
    assert.equal(mod.connected, 2, "两行各触发一次");
    mod.items.set(["a"]); // 删掉第 2 行
    assert.equal(mod.cleaned, 1, "删除的行应清理");
    assert.equal(mod.connected, 2, "保留的行不应重复触发");
    ui.unmount();
  });
});

test("运行时：keyed 复用移动节点时不重复触发 ref", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal } from "plain";
       export const items = signal([{ id: 1, t: "a" }, { id: 2, t: "b" }]);
       export let connected = 0;
       export function App(){
         return <ul>{items().map((x) => (
           <li key={x.id} ref={() => { connected++; }}>{x.t}</li>
         ))}</ul>;
       }`,
      "Keyed"
    );
    const ui = render(mod.App);
    assert.equal(mod.connected, 2);
    const liBefore = Array.from(ui.queryAll("li"));
    mod.items.set([{ id: 2, t: "b" }, { id: 1, t: "a" }]); // 重排
    const liAfter = Array.from(ui.queryAll("li"));
    assert.equal(liAfter[0], liBefore[1], "重排应复用节点（身份不变）");
    assert.equal(liAfter[1], liBefore[0]);
    assert.equal(mod.connected, 2, "keyed 复用移动不应重复触发 ref");
    ui.unmount();
  });
});

test("运行时：非函数值运行期报清晰错误（不静默）", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    // 标识符看不出类型：编译期放过，运行期兜底报错
    const mod = await compileModule(
      `export const notFn = 42;
       export function App(){ return <div ref={notFn} />; }`,
      "NotFn"
    );
    assert.throws(() => render(mod.App), /ref 需要一个函数/);
  });
});

// ---------------------------------------------------------------------------
// SSR / 注水
// ---------------------------------------------------------------------------

test("运行时：SSR 期间不执行 ref 回调", async () => {
  const { renderToStringSync } = await import(
    pathToFileURL(path.join(ROOT, "dist/server/render.js")).href
  );
  const mod = await compileModule(
    `export let fired = 0;
     export function App(){ return <div ref={() => { fired++; }}>hi</div>; }`,
    "Ssr"
  );
  const html = renderToStringSync(mod.App);
  assert.ok(html.includes("hi"));
  assert.equal(mod.fired, 0, "SSR 期间不应执行 ref（垫片节点没有 isConnected）");
});

test("运行时：hydrate 认领后执行 ref，" + "拿到的是真实节点", async () => {
  const { renderToStringSync } = await import(
    pathToFileURL(path.join(ROOT, "dist/server/render.js")).href
  );
  const { hydrate } = RUNTIME;
  const mod = await compileModule(
    `export let connected = 0;
     export function App(){
       return <canvas ref={(el) => { connected++; el.setAttribute("data-h", String(el.isConnected)); }} />;
     }`,
    "Hyd"
  );
  const html = renderToStringSync(mod.App);
  assert.equal(mod.connected, 0, "SSR 不应触发");

  await inDom(async (dom) => {
    const container = document.createElement("div");
    container.className = "host";
    document.body.appendChild(container);
    // 用解析出的服务端 DOM 充当首屏（不经过 innerHTML 拼接 HTML 字符串）
    const parsed = new dom.window.DOMParser().parseFromString(
      `<!doctype html><body><div class="host">${html}</div></body>`,
      "text/html"
    );
    const serverNode = parsed.querySelector(".host");
    while (serverNode.firstChild) container.appendChild(serverNode.firstChild);

    const before = container.querySelector("canvas");
    const { dispose } = hydrate(container, mod.App, { warn: false });
    const after = container.querySelector("canvas");
    assert.equal(after, before, "canvas 节点身份应不变（复用）");
    assert.equal(mod.connected, 1, "hydrate 认领后应执行一次 ref");
    assert.equal(after.getAttribute("data-h"), "true", "回调里拿到的是连入文档的真实节点");
    dispose();
  });
});
