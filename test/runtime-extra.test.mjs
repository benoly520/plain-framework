// 运行时剩余分支：signal 边界 / rowProxy 代理 / dom 挂载与插槽 / resource 与 server() /
//                ErrorBoundary 兜底 UI / router 各模式与 Link
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Event = dom.window.Event;

const { signal, computed, effect, createScope, onCleanup, getOwner, rowProxy, resolve } =
  await import("../dist/runtime/signal.js");
const { mount, createSlot, place, stringifySafe, nodesOf } = await import(
  "../dist/runtime/dom.js"
);
const { resource, server } = await import("../dist/runtime/async.js");
const { ErrorBoundary } = await import("../dist/runtime/error.js");
const { createRouter } = await import("../dist/runtime/router.js");

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// signal
// ---------------------------------------------------------------------------

test("peek 不建立依赖；函数式 set；dispose 幂等", () => {
  const s = signal(1);
  let runs = 0;
  const e = effect(() => {
    s.peek();
    runs++;
  });
  s.set(2);
  assert.equal(runs, 1, "peek 读取不应触发 effect");

  const counter = signal(1);
  counter.set((prev) => prev + 1);
  assert.equal(counter(), 2);

  const noop = effect(() => {});
  noop.dispose();
  noop.dispose(); // 幂等，不应抛错
  assert.equal(noop.disposed, true);
});

test("computed 随依赖更新，且读法与 signal 一致", () => {
  const a = signal(2);
  const doubled = computed(() => a() * 2);
  assert.equal(doubled(), 4);
  a.set(5);
  assert.equal(doubled(), 10);
});

test("getOwner / onCleanup / createScope 回收", () => {
  assert.equal(getOwner(), null);

  let owner = null;
  let cleaned = 0;
  const scope = createScope(() => {
    owner = getOwner();
    onCleanup(() => {
      cleaned++;
    });
  });
  assert.ok(owner && typeof owner.add === "function", "作用域内应能拿到 owner");
  assert.equal(cleaned, 0);
  scope.dispose();
  assert.equal(cleaned, 1);
  assert.equal(scope.value, undefined);
});

test("rowProxy：读 / 写 / in / keys / 描述符 / toPrimitive / 空行", () => {
  const row = { a: 1, b: 2 };
  const p = rowProxy(() => row);
  assert.equal(p.a, 1);
  assert.equal("a" in p, true);
  assert.deepEqual(Object.keys(p), ["a", "b"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(p, "a"), {
    configurable: true,
    enumerable: true,
    value: 1,
    writable: false,
  });
  assert.equal(String(p), "[object Object]");

  p.a = 9;
  assert.equal(row.a, 9, "写代理应落到真实行对象");

  const empty = rowProxy(() => null);
  assert.equal(empty.x, undefined);
  assert.equal("x" in empty, false);
  assert.deepEqual(Object.keys(empty), []);
  assert.equal(Object.getOwnPropertyDescriptor(empty, "x"), undefined);
  empty.x = 1; // 空行写入不应抛错
});

test("resolve 同时接受 getter 与字面值", () => {
  assert.equal(resolve(() => 7), 7);
  assert.equal(resolve("v"), "v");
});

// ---------------------------------------------------------------------------
// dom
// ---------------------------------------------------------------------------

test("stringifySafe 与 nodesOf 的归一化", () => {
  assert.equal(stringifySafe(null), "");
  assert.equal(stringifySafe(false), "false");
  assert.equal(stringifySafe(3), "3");
  assert.deepEqual(nodesOf(null), []);
  assert.deepEqual(nodesOf(true), []);
});

test("mount：选择器 / 元素 / 函数三种入参，返回可用卸载函数", () => {
  const host = document.createElement("div");
  host.id = "host";
  document.body.appendChild(host);

  const span = document.createElement("span");
  span.textContent = "hi";
  const unmount = mount("#host", span);
  assert.equal(host.textContent, "hi");
  unmount();
  assert.equal(host.textContent, "");

  mount(host, () => document.createTextNode("lazy"));
  assert.equal(host.textContent, "lazy");

  assert.throws(() => mount("#missing-target", null), /mount 找不到目标/);
});

test("createSlot + place：整体替换与清空；未挂载时 set 安全", () => {
  const parent = document.createElement("div");
  const slot = createSlot("s");
  place(parent, slot);
  assert.equal(slot.__plainSlot, true);

  const p = document.createElement("p");
  p.textContent = "A";
  slot.set(p);
  assert.equal(parent.textContent, "A");

  slot.clear();
  assert.equal(parent.textContent, "");

  const orphan = createSlot();
  orphan.set(document.createElement("p")); // 没有父节点 -> 静默返回
  assert.equal(orphan.clear(), orphan);
});

// ---------------------------------------------------------------------------
// async
// ---------------------------------------------------------------------------

test("resource：promiseFn 同步抛错时落到 error 态而非崩溃", () => {
  const r = resource(() => {
    throw new Error("同步炸了");
  });
  assert.equal(r.error().message, "同步炸了");
  assert.equal(r.loading(), false);
});

test("resource：refetch 强制重取并返回新值", async () => {
  let n = 0;
  const r = resource(() => Promise.resolve(++n));
  await tick();
  await tick();
  assert.equal(r.data(), 1);

  const next = await r.refetch();
  assert.equal(next, 2);
  assert.equal(r.data(), 2);
  assert.equal(r.loading(), false);
});

test("server()：运行时透传原函数并打标记", () => {
  const fn = (x) => x * 2;
  const wrapped = server(fn);
  assert.equal(wrapped, fn);
  assert.equal(fn.__server, true);
});

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

test("ErrorBoundary：无 fallback 时用默认兜底 UI", () => {
  const boom = signal(false);
  const box = document.createElement("div");
  document.body.appendChild(box);
  const slot = ErrorBoundary({
    children: () => {
      effect(() => {
        if (boom()) throw new Error("boom");
        return null;
      });
      return document.createTextNode("ok");
    },
  });
  box.appendChild(slot.fragment);
  assert.equal(box.textContent, "ok");

  boom.set(true);
  assert.equal(box.querySelectorAll(".plain-error").length, 1);
  assert.match(box.textContent, /boom/);
});

test("ErrorBoundary：自定义 fallback 收到 (err, retry)", () => {
  const b = signal(false);
  let received = null;
  const box = document.createElement("div");
  document.body.appendChild(box);
  const slot = ErrorBoundary({
    children: () => {
      effect(() => {
        if (b()) throw new Error("自定义错误");
        return null;
      });
      return document.createTextNode("child");
    },
    fallback: (err, retry) => {
      received = { message: err.message, retry };
      const el = document.createElement("div");
      el.className = "fb";
      el.textContent = `err:${err.message}`;
      return el;
    },
  });
  box.appendChild(slot.fragment);
  b.set(true);
  assert.equal(received.message, "自定义错误");
  assert.equal(typeof received.retry, "function");
  assert.equal(box.querySelectorAll(".fb").length, 1);
});

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

test("router：hash 模式监听 hashchange，'*' 路由兜底", () => {
  const router = createRouter({
    mode: "hash",
    routes: [
      { path: "/", component: () => document.createTextNode("home") },
      { path: "*", component: () => document.createTextNode("404") },
    ],
  });

  window.location.hash = "#/deep/path";
  window.dispatchEvent(new dom.window.Event("hashchange"));
  assert.equal(router.path(), "/deep/path");
  assert.equal(router.route().path, "*", "未匹配具体路由时落到 * 兜底");
  assert.deepEqual(router.params(), {});
});

test("router：history 模式 push / replace 导航", () => {
  const router = createRouter({ mode: "history", routes: [] });
  router.navigate("/replace-me", true);
  assert.equal(window.location.pathname, "/replace-me");
  assert.equal(router.path(), "/replace-me");

  router.navigate("/pushed");
  assert.equal(window.location.pathname, "/pushed");
  assert.equal(router.path(), "/pushed");
});

test("router.Link：href 正确且点击后导航（不整页跳转）", () => {
  const router = createRouter({ mode: "history", routes: [] });
  const a = router.Link({ to: "/target", children: () => document.createTextNode("go") });
  assert.equal(a.tagName, "A");
  assert.equal(a.getAttribute("href"), "/target");
  assert.equal(a.textContent, "go");

  const ev = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, "应阻止浏览器默认跳转");
  assert.equal(window.location.pathname, "/target");
});

test("router.render：无匹配路由时不渲染任何内容", () => {
  const router = createRouter({ mode: "history", routes: [] });
  const box = document.createElement("div");
  const update = router.render(box);
  update();
  assert.equal(box.childNodes.length, 0);
});
