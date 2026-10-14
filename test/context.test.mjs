// Context 单测：跨层传值 + 作用域回收 + SSR 请求级隔离 / 注水
//
// 覆盖 docs/rfcs/context-and-ssr-isolation.md 的验收标准：
//   - 三层传递可用，读法为 useContext(Ctx)()
//   - 无 Provider 读到默认值；嵌套 Provider 内层遮蔽外层；兄弟子树互不可见
//   - Provider 卸载 / 分支切换 -> 子树 effect 一并回收
//   - SSR：两次渲染各自 provide 不同值，互不串味
//   - hydrate：注水后读到 provider 的值（节点身份不变）
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
const RENDER_URL = pathToFileURL(path.join(ROOT, "dist/server/render.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-context-"));

let seq = 0;
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

test("Context：Provider 传值，consumer 用 useContext(Ctx)() 读取", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { createContext, useContext } from "plain";
       const ThemeCtx = createContext("light");
       export function Child() {
         const t = useContext(ThemeCtx);
         return <p>{t()}</p>;
       }
       export function App() {
         return <ThemeCtx.Provider value="dark"><Child /></ThemeCtx.Provider>;
       }`,
      "Basic"
    );
    const ui = render(mod.App);
    assert.equal(ui.text(), "dark");
    ui.unmount();
  });
});

test("Context：无 Provider 时读到默认值（不返回 undefined）", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { createContext, useContext } from "plain";
       const ThemeCtx = createContext("light");
       export function Child() {
         const t = useContext(ThemeCtx);
         return <p>{t()}</p>;
       }`,
      "Default"
    );
    const ui = render(mod.Child);
    assert.equal(ui.text(), "light");
    ui.unmount();
  });
});

test("Context：嵌套 Provider 内层遮蔽外层；兄弟子树互不可见", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { createContext, useContext } from "plain";
       const Ctx = createContext("default");
       export function Show() {
         const v = useContext(Ctx);
         return <span>{v()}</span>;
       }
       export function App() {
         return (
           <div>
             <Ctx.Provider value="outer"><Show /></Ctx.Provider>
             <Ctx.Provider value="outer2">
               <Ctx.Provider value="inner"><Show /></Ctx.Provider>
             </Ctx.Provider>
           </div>
         );
       }`,
      "Nest"
    );
    const ui = render(mod.App);
    const spans = ui.queryAll("span").map((s) => s.textContent);
    assert.deepEqual(spans, ["outer", "inner"], "内层应遮蔽外层，兄弟各自独立");
    ui.unmount();
  });
});

test("Context：value 读到 signal 时，消费者随其更新（getter 保持响应性）", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal, createContext, useContext } from "plain";
       const ThemeCtx = createContext("light");
       export function Child() {
         const t = useContext(ThemeCtx);
         return <p>{t()}</p>;
       }
       export function App() {
         const theme = signal("light");
         return (
           <div>
             <button onClick={() => theme.set("dark")}>切换</button>
             <ThemeCtx.Provider value={theme()}><Child /></ThemeCtx.Provider>
           </div>
         );
       }`,
      "Reactive"
    );
    const ui = render(mod.App);
    assert.equal(ui.text(), "切换light");
    fireEvent.click(ui.get("button"));
    assert.equal(ui.text(), "切换dark", "Provider 的 value 变化应传导到消费者");
    ui.unmount();
  });
});

test("Context：在 effect 里读 useContext（走 ownerChain 路径）", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal, effect, createContext, useContext } from "plain";
       const Ctx = createContext("none");
       export const out = signal("");
       export function Child() {
         effect(() => { out.set(useContext(Ctx)()); });
         return <p>ok</p>;
       }
       export function App() {
         return <Ctx.Provider value="in-effect"><Child /></Ctx.Provider>;
       }`,
      "InEffect"
    );
    const ui = render(mod.App);
    assert.equal(mod.out(), "in-effect");
    ui.unmount();
  });
});

test("Context：Provider 卸载时子树 effect 一并回收（不悬挂）", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { onCleanup, createContext, useContext } from "plain";
       const Ctx = createContext("x");
       export let cleaned = 0;
       export function Child() {
         useContext(Ctx);
         onCleanup(() => { cleaned++; });
         return <p>child</p>;
       }
       export function App() {
         return <Ctx.Provider value="v"><Child /></Ctx.Provider>;
       }`,
      "Cleanup"
    );
    const ui = render(mod.App);
    assert.equal(mod.cleaned, 0);
    ui.unmount();
    assert.equal(mod.cleaned, 1, "Provider 作用域应随父 owner 一起回收");
  });
});

test("Context：when 分支切换时 Provider 作用域被回收", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  await inDom(async () => {
    const mod = await compileModule(
      `import { signal, onCleanup, createContext, useContext } from "plain";
       const Ctx = createContext("x");
       export const show = signal(true);
       export let cleaned = 0;
       export function Child() {
         useContext(Ctx);
         onCleanup(() => { cleaned++; });
         return <p>child</p>;
       }
       export function App() {
         return (
           <div>
             <button onClick={() => show.set(!show())}>t</button>
             {show()
               ? <Ctx.Provider value="v"><Child /></Ctx.Provider>
               : <i>off</i>}
           </div>
         );
       }`,
      "Branch"
    );
    const ui = render(mod.App);
    assert.equal(mod.cleaned, 0);
    fireEvent.click(ui.get("button"));
    assert.equal(mod.cleaned, 1, "切走分支应回收 Provider 作用域");
    ui.unmount();
  });
});

test("Context + SSR：两次渲染各自 provide，互不串味（请求级隔离）", async () => {
  const { renderToStringSync } = await import(RENDER_URL);
  const mod = await compileModule(
    `import { createContext, useContext } from "plain";
     const UserCtx = createContext("anonymous");
     function Who() {
       const u = useContext(UserCtx);
       return <span>{u()}</span>;
     }
     export function makeApp(who: string) {
       return () => <UserCtx.Provider value={who}><Who /></UserCtx.Provider>;
     }`,
    "SsrIso"
  );
  const a = renderToStringSync(mod.makeApp("alice"));
  const b = renderToStringSync(mod.makeApp("bob"));
  assert.ok(a.includes("alice") && !a.includes("bob"), "A 的响应不该带 B 的值：" + a);
  assert.ok(b.includes("bob") && !b.includes("alice"), "B 的响应不该带 A 的值：" + b);
});

test("Context + hydrate：注水后读到 Provider 的值，节点身份不变", async () => {
  const { renderToStringSync } = await import(RENDER_URL);
  const { hydrate } = RUNTIME;
  const mod = await compileModule(
    `import { createContext, useContext } from "plain";
     const Ctx = createContext("default");
     function Who() {
       const v = useContext(Ctx);
       return <span>{v()}</span>;
     }
     export function App() {
       return <Ctx.Provider value="hydrated"><Who /></Ctx.Provider>;
     }`,
    "HydCtx"
  );
  const html = renderToStringSync(mod.App);
  assert.ok(html.includes("hydrated"));
  await inDom(async (dom) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const parsed = new dom.window.DOMParser().parseFromString(
      `<!doctype html><body><div>${html}</div></body>`,
      "text/html"
    );
    const src = parsed.body.firstChild;
    while (src.firstChild) container.appendChild(src.firstChild);

    const before = container.querySelector("span");
    const { dispose } = hydrate(container, mod.App, { warn: false });
    const after = container.querySelector("span");
    assert.equal(after, before, "span 节点身份应不变（复用）");
    assert.equal(after.textContent, "hydrated");
    dispose();
  });
});
