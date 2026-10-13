// Plain SSR hydration 单测：node --test
//
// 覆盖 ROADMAP M5 验收标准：
//   [x] hydrate(container, App) 复用服务端已有节点，而不是清空重建（节点身份断言）
//   [x] 文本/属性与服务端不一致时能就地修正，而不是整树重渲染
//   [x] 未注水的 mount() 行为完全不变（回归）
//   [x] SSR 字符串 → 另一份 DOM 解析 → hydrate → 交互可用

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-hydrate-"));
const RUNTIME = await import(RUNTIME_URL);
const { hydrate, mount } = RUNTIME;

// ---------------------------------------------------------------------------
// 编译一个模块（去 TS 类型 → plain 编译 → 改写 import 到 dist 运行时）
// ---------------------------------------------------------------------------
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
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { mod, code };
}

/** 在一个独立的 jsdom 窗口里跑一段逻辑（隔离 document，避免污染其它测试） */
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

async function renderSSR(mod) {
  const { renderToStringSync } = await import(
    pathToFileURL(path.join(ROOT, "dist/server/render.js")).href
  );
  return renderToStringSync(mod.App);
}

// ---------------------------------------------------------------------------
// 1. 节点身份：hydrate 必须复用服务端节点，而不是清空重建
// ---------------------------------------------------------------------------
test("hydrate 复用服务端节点（节点身份不变）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const name = signal("Plain");
    export function App() {
      return <section class="page"><h1>{name()}</h1></section>;
    }
    `,
    "h1"
  );

  const html = await renderSSR(mod);
  await inDom(html, async (dom) => {
    const container = dom.window.document.body;
    const before = container.querySelector("h1");
    const beforeSection = container.querySelector("section");

    const { dispose } = hydrate(container, mod.App, { warn: false });

    const after = container.querySelector("h1");
    const afterSection = container.querySelector("section");
    assert.equal(after, before, "h1 节点对象身份必须保持不变（复用而非重建）");
    assert.equal(afterSection, beforeSection, "section 节点对象身份必须保持不变");
    assert.equal(container.querySelector("h1").textContent, "Plain");
    dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. 文本不一致：就地修正（改 nodeValue），不替换节点
// ---------------------------------------------------------------------------
test("文本不一致时就地修正（节点身份不变）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const name = signal("Plain");
    export function App() {
      return <p>hello {name()}</p>;
    }
    `,
    "h2"
  );

  // 服务端输出会被篡改为「客户端期望不同的文本」，模拟不一致
  let html = await renderSSR(mod);
  html = html.replace("Plain", "STALE"); // 服务端旧值

  await inDom(html, async (dom) => {
    const container = dom.window.document.body;
    const p = container.querySelector("p");
    // 记录 p 的第一个文本子节点（"hello "）
    const textBefore = p.childNodes[0];

    hydrate(container, mod.App, { warn: false });

    const pAfter = container.querySelector("p");
    assert.equal(pAfter, p, "p 元素身份必须不变");
    assert.ok(pAfter.textContent.includes("Plain"), "文本应被修正为客户端值：" + pAfter.textContent);
    assert.equal(p.childNodes[0], textBefore, "前置文本节点身份不变（就地修正策略）");
  });
});

// ---------------------------------------------------------------------------
// 3. 交互可用：hydrate 后事件与响应式绑定生效
// ---------------------------------------------------------------------------
test("hydrate 后点击事件与响应式更新可用", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const count = signal(0);
    export function App() {
      return <button onClick={() => count.set(count() + 1)}>点了 {count()} 次</button>;
    }
    `,
    "h3"
  );

  const html = await renderSSR(mod);
  await inDom(html, async (dom) => {
    const container = dom.window.document.body;
    const btn = container.querySelector("button");
    hydrate(container, mod.App, { warn: false });

    assert.equal(container.querySelector("button"), btn, "button 身份不变");
    assert.ok(btn.textContent.includes("点了 0 次"), "初始文案：" + btn.textContent);

    btn.dispatchEvent(new dom.window.Event("click"));
    assert.ok(
      container.querySelector("button").textContent.includes("点了 1 次"),
      "点击后应更新：" + container.querySelector("button").textContent
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 列表：hydrate 复用服务端 <li>，节点身份不变
// ---------------------------------------------------------------------------
test("hydrate 复用列表项（each 首屏认领，节点身份不变）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal(["a", "b", "c"]);
    export function App() {
      return <ul>{items().map((i) => <li>{i}</li>)}</ul>;
    }
    `,
    "h4"
  );

  const html = await renderSSR(mod);
  await inDom(html, async (dom) => {
    const container = dom.window.document.body;
    const before = Array.from(container.querySelectorAll("li"));
    assert.equal(before.length, 3, "服务端应渲染 3 个 li");

    hydrate(container, mod.App, { warn: false });

    const after = Array.from(container.querySelectorAll("li"));
    assert.equal(after.length, 3);
    assert.equal(after[0], before[0], "第 1 个 li 身份必须不变");
    assert.equal(after[1], before[1], "第 2 个 li 身份必须不变");
    assert.equal(after[2], before[2], "第 3 个 li 身份必须不变");
  });
});

// ---------------------------------------------------------------------------
// 5. 条件分支：hydrate 复用服务端分支节点
// ---------------------------------------------------------------------------
test("hydrate 复用条件分支节点（when 认领）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const show = signal(true);
    export function App() {
      return <div>{show() ? <b>YES</b> : <i>NO</i>}</div>;
    }
    `,
    "h5"
  );

  const html = await renderSSR(mod);
  await inDom(html, async (dom) => {
    const container = dom.window.document.body;
    const beforeB = container.querySelector("b");
    assert.ok(beforeB, "服务端应有 <b>");

    hydrate(container, mod.App, { warn: false });

    const afterB = container.querySelector("b");
    assert.equal(afterB, beforeB, "<b> 分支节点身份必须不变");
    assert.equal(afterB.textContent, "YES");
  });
});

// ---------------------------------------------------------------------------
// 6. 回归：未注水的 mount 行为完全不变
// ---------------------------------------------------------------------------
test("mount 未注水行为不变（回归）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const n = signal(1);
    export function App() {
      return <div class="m">{n()}</div>;
    }
    `,
    "h6"
  );

  await inDom("<div id='root'></div>", async (dom) => {
    const root = dom.window.document.getElementById("root");
    const unmount = mount(root, mod.App);
    assert.ok(root.querySelector("div.m"), "mount 应渲染出 div.m");
    assert.equal(root.querySelector("div.m").textContent, "1");
    mod.n.set(2);
    assert.equal(root.querySelector("div.m").textContent, "2", "响应式更新应生效");
    unmount();
    assert.equal(root.querySelector("div.m"), null, "unmount 应移除渲染内容");
  });
});

// ---------------------------------------------------------------------------
// 7. 告警：服务端多余节点应被记录（不静默）
// ---------------------------------------------------------------------------
test("服务端多余节点会记录告警", async () => {
  const { mod } = await compileModule(
    `
    export function App() {
      return <p>only</p>;
    }
    `,
    "h7"
  );

  await inDom("<p>only</p><span>extra</span>", async (dom) => {
    const container = dom.window.document.body;
    const { warnings } = hydrate(container, mod.App, { warn: false });
    assert.ok(
      warnings.some((w) => w.kind === "extra"),
      "应记录多余节点告警：" + JSON.stringify(warnings)
    );
  });
});
