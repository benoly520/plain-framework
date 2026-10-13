// keyed diff 单测：<li key={...}> 时按 key 复用行（节点身份跟着数据走）
// 以及「回调用到 index 时自动放弃 key」这条安全规则
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile, PlainCompileError } from "../dist/compiler/index.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-keyed-"));

async function compileModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  const file = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { mod, code };
}

function mount() {
  const box = document.createElement("div");
  document.body.appendChild(box);
  return box;
}

const texts = (box) =>
  Array.from(box.querySelectorAll("li")).map((li) => li.textContent);

test("keyed：头部插入时已有节点被复用，节点身份跟着数据走", async () => {
  const { mod, code } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([
      { id: 1, text: "a" },
      { id: 2, text: "b" }
    ]);
    export function App() {
      return <ul>{items().map((it) => <li key={it.id}>{it.text}</li>)}</ul>;
    }
    `,
    "keyed1"
  );

  // 编译器应把 key 作为 each 的第 4 个参数传下去
  assert.ok(code.includes("(it) => ((it.id))"), "应生成 keyFn：\n" + code);

  const box = mount();
  box.appendChild(mod.App());
  const [a0, b0] = Array.from(box.querySelectorAll("li"));
  assert.deepEqual(texts(box), ["a", "b"]);

  mod.items.set([{ id: 0, text: "z" }, ...mod.items()]);
  assert.deepEqual(texts(box), ["z", "a", "b"]);
  const now = Array.from(box.querySelectorAll("li"));
  assert.equal(now[1], a0, "id=1 的节点必须是同一个 DOM 对象");
  assert.equal(now[2], b0, "id=2 的节点必须是同一个 DOM 对象");
  assert.notEqual(now[0], a0, "新数据应建新节点");
  assert.equal(now[1].hasAttribute("key"), false, "key 不该落到 DOM 属性上");
});

test("keyed：重排只移动节点、不重建", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([
      { id: 1, text: "a" },
      { id: 2, text: "b" },
      { id: 3, text: "c" }
    ]);
    export function App() {
      return <ul>{items().map((it) => <li key={it.id}>{it.text}</li>)}</ul>;
    }
    `,
    "keyed2"
  );
  const box = mount();
  box.appendChild(mod.App());
  const [a0, b0, c0] = Array.from(box.querySelectorAll("li"));

  mod.items.set([...mod.items()].reverse());
  assert.deepEqual(texts(box), ["c", "b", "a"]);
  const now = Array.from(box.querySelectorAll("li"));
  assert.deepEqual(now, [c0, b0, a0], "三个节点都应被复用（只是位置变了）");
});

test("keyed：删掉中间行只回收那一行的 effect", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
    export const dep = signal(0);
    export const hits = { a: 0, b: 0, c: 0 };
    export function App() {
      return <ul>{items().map((it) => <li key={it.id}>{String((hits[it.id]++, dep()))}</li>)}</ul>;
    }
    `,
    "keyed3"
  );
  const box = mount();
  box.appendChild(mod.App());
  assert.deepEqual(mod.hits, { a: 1, b: 1, c: 1 });

  mod.items.set([{ id: "a" }, { id: "c" }]);
  const afterRemove = { ...mod.hits };
  mod.dep.set(1);
  assert.equal(mod.hits.b, afterRemove.b, "被删掉的 b 不应再运行 effect");
  assert.ok(
    mod.hits.a > afterRemove.a && mod.hits.c > afterRemove.c,
    "保留下来的 a / c 应继续响应依赖"
  );
  assert.equal(box.querySelectorAll("li").length, 2);
});

test("keyed：重复 key 不崩溃", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
    export function App() {
      return <ul>{items().map((it) => <li key={it.id}>{it.text}</li>)}</ul>;
    }
    `,
    "keyed4"
  );
  const box = mount();
  box.appendChild(mod.App());
  mod.items.set([
    { id: 1, text: "a" },
    { id: 1, text: "b" },
  ]);
  assert.deepEqual(texts(box), ["a", "b"]);
});

test("keyed：组件元素带 key 也能复用，且 key 不作为 prop 传给组件", async () => {
  const { mod, code } = await compileModule(
    `
    import { signal, effect, resolve } from "plain";
    export const items = signal([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
    export const seenKeys = [];
    export function Row(props) {
      seenKeys.push(props.key);
      const el = document.createElement("li");
      const t = document.createTextNode("");
      el.appendChild(t);
      effect(() => { t.nodeValue = String(resolve(props.text)); });
      return el;
    }
    export function App() {
      return <ul>{items().map((it) => <Row key={it.id} text={it.text} />)}</ul>;
    }
    `,
    "keyed5"
  );
  assert.ok(!code.includes("key:"), "key 不应出现在组件的 props 里：\n" + code);

  const box = mount();
  box.appendChild(mod.App());
  const [a0] = Array.from(box.querySelectorAll("li"));
  mod.items.set([{ id: 0, text: "z" }, ...mod.items()]);
  assert.deepEqual(texts(box), ["z", "a", "b"]);
  assert.equal(Array.from(box.querySelectorAll("li"))[1], a0, "组件节点应被复用");
  assert.ok(mod.seenKeys.every((k) => k === undefined), "key 不该传进组件 props");
});

test("对照：没有 key 时维持 index 语义（节点原地更新内容）", async () => {
  const { mod, code } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
    export function App() {
      return <ul>{items().map((it) => <li>{it.text}</li>)}</ul>;
    }
    `,
    "idx1"
  );
  assert.ok(!code.includes("=> ((it"), "无 key 时不应生成 keyFn：\n" + code);

  const box = mount();
  box.appendChild(mod.App());
  const first = box.querySelector("li");
  mod.items.set([{ id: 0, text: "z" }, ...mod.items()]);
  assert.deepEqual(texts(box), ["z", "a", "b"]);
  assert.equal(box.querySelector("li"), first, "index 模式：首个节点原地复用");
  assert.equal(box.querySelector("li").textContent, "z", "但内容被换成了新数据");
});

test("key 与 index 同时使用 -> 编译期报 PLAIN_E1005，而不是静默降级", async () => {
  let err = null;
  try {
    await compileModule(
      `
      import { signal } from "plain";
      export const items = signal([{ id: 1, text: "a" }]);
      export function App() {
        return <ul>{items().map((it, i) => <li key={it.id}>{i + ":" + it.text}</li>)}</ul>;
      }
      `,
      "idx2"
    );
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof PlainCompileError, "应当抛 PlainCompileError");
  assert.equal(err.code, "PLAIN_E1005");
  assert.match(err.hint, /二者选一/);
});

test("index 参数声明了但没用到时，key 照常生效", async () => {
  const { mod, code } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal([{ id: 1, text: "a" }, { id: 2, text: "b" }]);
    export function App() {
      return <ul>{items().map((it, i) => <li key={it.id}>{it.text}</li>)}</ul>;
    }
    `,
    "idx3"
  );
  assert.ok(code.includes("(it.id)"), "未使用 index 时 key 应保留：\n" + code);

  const box = mount();
  box.appendChild(mod.App());
  const [a0] = Array.from(box.querySelectorAll("li"));
  mod.items.set([{ id: 0, text: "z" }, ...mod.items()]);
  assert.deepEqual(texts(box), ["z", "a", "b"]);
  assert.equal(Array.from(box.querySelectorAll("li"))[1], a0, "应按 key 复用");
});
