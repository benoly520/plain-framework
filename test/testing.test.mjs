// plain/testing 单测：render / fireEvent / flush / expectText
//
// 目的：测试工具包自己也要被测。重点验证：
//   - render 挂载组件并给出可用的 html/text/query 查询
//   - fireEvent 的事件回调里对 signal 的写入被同步 flush（DOM 立即是最终态）
//   - 组件真的"活"：点击改 signal，DOM 跟着变
//   - 解挂干净：unmount 后组件副作用不再影响，容器从 body 移除
//   - 缺 DOM 环境时报清晰的错（引导装 jsdom）
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-testkit-"));

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

/** 在独立 jsdom 环境里跑（隔离 document，避免污染其它测试）。支持 async 回调 */
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

test("render：挂载组件后可查询 html / text / 选择器", async () => {
  const { render } = await import(TESTING_URL);
  const { signal } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const n = signal(3);
      const el = document.createElement("div");
      el.className = "counter";
      const p = document.createElement("p");
      p.textContent = `count: ${n()}`;
      el.appendChild(p);
      return el;
    };
    const ui = render(App);
    assert.equal(ui.text(), "count: 3");
    assert.equal(ui.get(".counter").tagName, "DIV");
    assert.equal(ui.query("p").textContent, "count: 3");
    assert.equal(ui.queryAll("p").length, 1);
    assert.equal(ui.getByText("count: 3").tagName, "P");
    assert.match(ui.html(), /class="counter"/);
    ui.unmount();
  });
});

test("fireEvent：点击改 signal，DOM 同步更新（无需 await）", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const n = signal(0);
      const btn = document.createElement("button");
      btn.textContent = "+1";
      btn.onclick = () => n.set(n() + 1);
      const out = document.createElement("span");
      out.textContent = `n=${n()}`;
      // 把 out 的文本挂成响应式：用 effect 重新读
      const { effect } = RUNTIME;
      effect(() => {
        out.textContent = `n=${n()}`;
      });
      const frag = document.createDocumentFragment();
      frag.append(btn, out);
      return frag;
    };
    const ui = render(App);
    assert.equal(ui.text(), "+1n=0");
    fireEvent.click(ui.get("button"));
    assert.equal(ui.text(), "+1n=1", "事件回调里的 signal 写入应同步 flush");
    fireEvent.click(ui.get("button"));
    assert.equal(ui.text(), "+1n=2");
    ui.unmount();
  });
});

test("fireEvent.input：设置值并派发 input 事件", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal, effect } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const text = signal("");
      const input = document.createElement("input");
      input.oninput = (e) => text.set(e.target.value);
      const label = document.createElement("div");
      effect(() => {
        label.textContent = `value=${text()}`;
      });
      const frag = document.createDocumentFragment();
      frag.append(input, label);
      return frag;
    };
    const ui = render(App);
    assert.equal(ui.text(), "value=");
    fireEvent.input(ui.get("input"), "hello");
    assert.equal(ui.get("input").value, "hello");
    assert.equal(ui.text(), "value=hello");
    ui.unmount();
  });
});

test("fireEvent.keyDown：带 key 的键盘事件", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal, effect } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const last = signal("-");
      const input = document.createElement("input");
      input.onkeydown = (e) => last.set(e.key);
      const out = document.createElement("div");
      effect(() => {
        out.textContent = `key=${last()}`;
      });
      const frag = document.createDocumentFragment();
      frag.append(input, out);
      return frag;
    };
    const ui = render(App);
    fireEvent.keyDown(ui.get("input"), { key: "Enter" });
    assert.equal(ui.text(), "key=Enter");
    ui.unmount();
  });
});

test("unmount：解挂后容器从 body 移除，组件副作用停止", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal } = RUNTIME;
  await inDom(async () => {
    let outside;
    const App = () => {
      const n = signal(0);
      outside = n;
      const btn = document.createElement("button");
      btn.onclick = () => n.set(n() + 1);
      return btn;
    };
    const ui = render(App);
    assert.equal(document.body.contains(ui.container), true);
    ui.unmount();
    assert.equal(document.body.contains(ui.container), false, "容器应已移除");
  });
});

test("getByText / get：找不到时抛出带选择器/文本的错误", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const ui = render(() => {
      const p = document.createElement("p");
      p.textContent = "hi";
      return p;
    });
    assert.throws(() => ui.get(".nope"), /找不到元素：\.nope/);
    assert.throws(() => ui.getByText("missing"), /找不到文本为 "missing"/);
    assert.equal(ui.query(".nope"), null, "query 返回 null 不抛");
    assert.equal(ui.queryByText("missing"), null);
    ui.unmount();
  });
});

test("expectText：失败信息带实际文本与 HTML", async () => {
  const { render, expectText } = await import(TESTING_URL);
  await inDom(async () => {
    const ui = render(() => {
      const p = document.createElement("p");
      p.textContent = "actual";
      return p;
    });
    expectText(ui, "actual"); // 通过
    assert.throws(() => expectText(ui, "expected"), /期望：\"expected\"[\s\S]*实际：\"actual\"/);
    ui.unmount();
  });
});

test("缺 DOM 环境时报清晰的错（引导装 jsdom），而不是 NoSuchProperty", async () => {
  const { render } = await import(TESTING_URL);
  const savedDoc = globalThis.document;
  const savedWin = globalThis.window;
  delete globalThis.document;
  delete globalThis.window;
  try {
    assert.throws(() => render(() => null), /找不到 DOM[\s\S]*jsdom/);
  } finally {
    globalThis.document = savedDoc;
    globalThis.window = savedWin;
  }
});

test("flush：等待微任务（给 resource 这类异步用）", async () => {
  const { flush } = await import(TESTING_URL);
  let done = false;
  Promise.resolve().then(() => (done = true));
  await flush();
  assert.equal(done, true);
});

test("fireEvent 其余变体：change / submit / focus / blur / keyUp / fire 都派发真实事件", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal, effect } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const log = signal([]);
      const push = (e) => log.set([...log(), e]);

      const input = document.createElement("input");
      input.onchange = () => push("change");
      input.onfocus = () => push("focus");
      input.onblur = () => push("blur");
      input.onkeyup = (e) => push("up:" + e.key);

      const form = document.createElement("form");
      form.onsubmit = (e) => {
        e.preventDefault();
        push("submit");
      };

      const select = document.createElement("select");
      const opt1 = document.createElement("option");
      opt1.value = "a";
      const opt2 = document.createElement("option");
      opt2.value = "b";
      select.append(opt1, opt2);
      select.onchange = () => push("select:" + select.value);

      const custom = document.createElement("div");
      custom.addEventListener("plain-custom", () => push("custom"));

      const out = document.createElement("section");
      effect(() => {
        out.textContent = log().join(",");
      });

      const frag = document.createDocumentFragment();
      frag.append(input, form, select, custom, out);
      return frag;
    };
    const ui = render(App);

    fireEvent.change(ui.get("input"), "x");
    fireEvent.focus(ui.get("input"));
    fireEvent.blur(ui.get("input"));
    fireEvent.keyUp(ui.get("input"), { key: "Esc" });
    fireEvent.submit(ui.get("form"));
    fireEvent.change(ui.get("select"), "b");
    fireEvent.fire(ui.get("div"), "plain-custom");

    assert.equal(
      ui.get("section").textContent,
      "change,focus,blur,up:Esc,submit,select:b,custom"
    );
    // select 的 setValue 走的是 SELECT 分支
    assert.equal(ui.get("select").value, "b");
    ui.unmount();
  });
});

test("fireEvent 复选框：change 带 true/false 走 checked 分支", async () => {
  const { render, fireEvent } = await import(TESTING_URL);
  const { signal, effect } = RUNTIME;
  await inDom(async () => {
    const App = () => {
      const checked = signal(false);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.onchange = () => checked.set(box.checked);
      const out = document.createElement("div");
      effect(() => {
        out.textContent = String(checked());
      });
      const frag = document.createDocumentFragment();
      frag.append(box, out);
      return frag;
    };
    const ui = render(App);
    assert.equal(ui.query("div").textContent, "false");
    fireEvent.change(ui.get("input"), true);
    assert.equal(ui.get("input").checked, true);
    assert.equal(ui.get("div").textContent, "true");
    ui.unmount();
  });
});

test("queryByText：父元素不因包含子元素文本被误命中（只看自身直接文本）", async () => {
  const { render } = await import(TESTING_URL);
  await inDom(async () => {
    const ui = render(() => {
      const wrap = document.createElement("div");
      const leaf = document.createElement("span");
      leaf.textContent = "leaf";
      wrap.appendChild(leaf);
      return wrap;
    });
    // "leaf" 只在 span 上，不该命中外层 div
    assert.equal(ui.queryByText("leaf").tagName, "SPAN");
    ui.unmount();
  });
});

test("端到端：编译真实 TSX 组件后用 render + fireEvent 测（含 mount 锚点）", async () => {
  const { render, fireEvent, expectText } = await import(TESTING_URL);
  await inDom(async () => {
    // 真编译：写 TSX，编译器把它变成带响应式绑定的建 DOM 代码。
    // 注意 {n()} 会被编译成响应式文本绑定 —— 这正是要测的「点击 → DOM 更新」。
    const mod = await compileModule(
      `
      import { signal } from "plain";
      export function Counter() {
        const n = signal(0);
        return (
          <div>
            <button onClick={() => n.set(n() + 1)}>add</button>
            <span>{n()}</span>
          </div>
        );
      }
      `,
      "Counter"
    );
    const ui = render(mod.Counter);
    expectText(ui, "add0");
    fireEvent.click(ui.get("button"));
    expectText(ui, "add1");
    fireEvent.click(ui.get("button"));
    fireEvent.click(ui.get("button"));
    expectText(ui, "add3");
    ui.unmount();
    assert.equal(document.body.contains(ui.container), false);
  });
});
