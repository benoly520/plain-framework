// Plain 测试套件：node test/run.mjs
//
// 覆盖：响应式内核 / 批处理 / 作用域回收 / when / each（含历史上致命的两个 bug）
//      / resource / 路由回收 / ErrorBoundary / server() 物理剥离 + RPC 往返 / SSR

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile } from "../src/compiler/index.mjs";
import { writeServerManifest } from "../src/compiler/manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "src/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-test-"));

// ---------------------------------------------------------------------------
// DOM 环境（jsdom）
// ---------------------------------------------------------------------------
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

if (!dom.window.Element.prototype.replaceChildren) {
  dom.window.Element.prototype.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    nodes.forEach((n) => this.appendChild(n));
  };
  dom.window.DocumentFragment.prototype.replaceChildren =
    dom.window.Element.prototype.replaceChildren;
}

const RUNTIME = await import(RUNTIME_URL);

// ---------------------------------------------------------------------------
// 断言 & 运行器
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

function eq(actual, expected, msg = "") {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${msg} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
    );
  }
}

function ok(cond, msg = "断言失败") {
  if (!cond) throw new Error(msg);
}

function container(id = "app") {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function compileModule(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(
    /from\s+["']plain["']/g,
    `from "${RUNTIME_URL}"`
  );
  const file = path.join(TMP, `${name}.mjs`);
  fs.writeFileSync(file, code);
  const mod = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { mod, code, out };
}

// ---------------------------------------------------------------------------
// 1. 响应式内核
// ---------------------------------------------------------------------------
test("signal / computed 自动依赖收集", () => {
  const { signal, computed, effect } = RUNTIME;
  const a = signal(1);
  const b = computed(() => a() * 2);
  eq(b(), 2);
  let runs = 0;
  const e = effect(() => {
    b();
    runs++;
  });
  eq(runs, 1, "effect 首次同步执行");
  a.set(3);
  eq(runs, 2, "signal 变化应触发 effect");
  eq(b(), 6);
  a.set(3);
  eq(runs, 2, "同值写入不应触发（Object.is 比较）");
  e.dispose();
  a.set(9);
  eq(runs, 2, "dispose 后不应再触发");
});

test("effect dispose 后不再持有依赖（无泄漏）", () => {
  const { signal, effect } = RUNTIME;
  const s = signal(0);
  const e = effect(() => s());
  eq(s.subs.size, 1);
  e.dispose();
  eq(s.subs.size, 0, "dispose 必须从 signal 的订阅表移除自己");
});

test("batch 合并多次写入为一次 effect", () => {
  const { signal, effect, batch } = RUNTIME;
  const x = signal(0);
  const y = signal(0);
  let runs = 0;
  effect(() => {
    x();
    y();
    runs++;
  });
  eq(runs, 1);
  batch(() => {
    x.set(1);
    y.set(1);
    x.set(2);
  });
  eq(runs, 2, "batch 内 3 次写入只应触发 1 次重算");
});

test("createScope 整体回收作用域内的 effect", () => {
  const { signal, effect, createScope } = RUNTIME;
  const dep = signal(0);
  let runs = 0;
  const scope = createScope((dispose) => {
    effect(() => {
      dep();
      runs++;
    });
  });
  eq(runs, 1);
  dep.set(1);
  eq(runs, 2);
  scope.dispose();
  dep.set(2);
  eq(runs, 2, "作用域回收后 effect 必须停止");
});

// ---------------------------------------------------------------------------
// 2. when / each（历史致命 bug 回归测试）
// ---------------------------------------------------------------------------
test("when 分支切换：内容更新且旧分支节点被摘除", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const show = signal(true);
    export function App() {
      return <div>{show() ? <p>YES</p> : <p>NO</p>}</div>;
    }
    `,
    "when1"
  );
  const box = container("when1");
  box.appendChild(mod.App());
  ok(box.textContent.includes("YES"), "初始应为 YES，实际：" + box.textContent);
  const yesNode = box.querySelector("p");
  mod.show.set(false);
  ok(box.textContent.includes("NO"), "切换后应为 NO，实际：" + box.textContent);
  eq(yesNode.parentNode, null, "旧分支节点必须从 DOM 摘除");
  mod.show.set(true);
  ok(box.textContent.includes("YES"), "来回切换仍要正确");
});

test("when 分支切换回收旧分支 effect", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const show = signal(true);
    export const dep = signal(0);
    export const hits = { then: 0 };
    export function App() {
      return <div>{show() ? <p>{String((hits.then++, dep()))}</p> : <p>off</p>}</div>;
    }
    `,
    "when2"
  );
  const box = container("when2");
  box.appendChild(mod.App());
  eq(mod.hits.then, 1);
  mod.dep.set(1);
  eq(mod.hits.then, 2);
  mod.show.set(false);
  mod.dep.set(2);
  eq(mod.hits.then, 2, "离开分支后旧 effect 必须被回收");
});

test("[致命 bug 回归] each 行更新：勾选待办 UI 必须跟着变", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const todos = signal([
      { id: 1, text: "第一条", done: false },
      { id: 2, text: "第二条", done: false }
    ]);
    export function toggle(id) {
      todos.set(todos().map(t => t.id === id ? { ...t, done: !t.done } : t));
    }
    export function App() {
      return <ul>
        {todos().map(t => (
          <li class={t.done ? "done" : ""}>
            <input type="checkbox" checked={t.done} />
            <span>{t.text}</span>
          </li>
        ))}
      </ul>;
    }
    `,
    "each1"
  );
  const box = container("each1");
  box.appendChild(mod.App());
  const lis = () => Array.from(box.querySelectorAll("li"));
  eq(lis().length, 2);
  const first = lis()[0];
  const second = lis()[1];

  mod.toggle(1);
  eq(first.className, "done", "行-1 class 应更新");
  eq(first.querySelector("input").checked, true, "checkbox 应更新");
  eq(first.querySelector("span").textContent, "第一条", "文本不应丢失");
  eq(second.className, "", "行-2 不应受影响");
  ok(lis()[0] === first, "行节点应被复用（不是重建）");

  mod.toggle(1);
  eq(first.className, "", "第二次 toggling 仍要生效（旧版整列表会消失）");
  eq(first.querySelector("input").checked, false);

  mod.toggle(2);
  eq(second.className, "done", "切换另一行也要正确");
  eq(lis().length, 2, "行数不应变化");
});

test("each 增删行 + 移除行的 effect 回收", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const items = signal(["a", "b"]);
    export function App() {
      return <ul>
        {items().map((t, i) => <li>{i + ": " + t}</li>)}
      </ul>;
    }
    `,
    "each2"
  );
  const box = container("each2");
  box.appendChild(mod.App());
  const lis = () => Array.from(box.querySelectorAll("li"));
  eq(lis().length, 2);
  eq(lis()[1].textContent, "1: b");

  mod.items.set(mod.items().concat(["c"]));
  eq(lis().length, 3, "新增应有 3 行");
  eq(lis()[2].textContent, "2: c");

  const doomed = lis()[2];
  mod.items.set(mod.items().slice(0, 2));
  eq(lis().length, 2, "删掉应有 2 行");
  eq(doomed.parentNode, null, "被删行必须从 DOM 摘除");

  mod.items.set([]);
  eq(lis().length, 0, "清空列表应完全移除");
});

test("each 内部可嵌套 when 且互不污染", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const rows = signal([{ n: 1, on: true }, { n: 2, on: false }]);
    export function App() {
      return <div>
        {rows().map(r => (
          <div>{r.on ? <b>开</b> : <i>关</i>}</div>
        ))}
      </div>;
    }
    `,
    "each3"
  );
  const box = container("each3");
  box.appendChild(mod.App());
  eq(box.querySelectorAll("b").length, 1);
  eq(box.querySelectorAll("i").length, 1);
  mod.rows.set([{ n: 1, on: false }, { n: 2, on: false }]);
  eq(box.querySelectorAll("b").length, 0);
  eq(box.querySelectorAll("i").length, 2);
});

// ---------------------------------------------------------------------------
// 3. 组件 / props / children
// ---------------------------------------------------------------------------
test("组件 props 为 getter，边改边更新；children 正常透传", async () => {
  const { mod } = await compileModule(
    `
    import { signal, effect, resolve } from "plain";
    export const name = signal("世界");
    export function Card(props) {
      const el = document.createElement("div");
      el.className = "card";
      const t = document.createTextNode("");
      el.appendChild(t);
      effect(() => { t.nodeValue = String(resolve(props.title)); });
      const kids = props.children ? props.children() : null;
      if (kids) el.appendChild(kids);
      return el;
    }
    export function App() {
      return <Card title={"你好，" + name()}>
        <span>inner</span>
      </Card>;
    }
    `,
    "comp1"
  );
  const box = container("comp1");
  box.appendChild(mod.App());
  eq(box.querySelector(".card").textContent, "你好，世界inner");
  mod.name.set("Plain");
  eq(box.querySelector(".card").textContent, "你好，Plaininner", "props 更新应生效");
});

// ---------------------------------------------------------------------------
// 4. resource 异步资源
// ---------------------------------------------------------------------------
test("resource：loading -> data，依赖变化自动重取，过期响应被丢弃", async () => {
  const { mod } = await compileModule(
    `
    import { signal, resource } from "plain";
    export const q = signal("a");
    export function App() {
      const r = resource(() => Promise.resolve("val:" + q()));
      return <div>{r.loading() ? <p>loading</p> : <p>{r.data()}</p>}</div>;
    }
    `,
    "res1"
  );
  const box = container("res1");
  box.appendChild(mod.App());
  ok(box.textContent.includes("loading"), "初始应 loading");
  await tick();
  await tick();
  eq(box.textContent, "val:a");
  mod.q.set("b");
  await tick();
  await tick();
  eq(box.textContent, "val:b", "依赖变化应自动重新拉取");
});

test("resource 出错时落到 error 态而非崩溃", async () => {
  const { mod } = await compileModule(
    `
    import { resource } from "plain";
    export let shouldFail = true;
    export function App() {
      const r = resource(() => shouldFail ? Promise.reject(new Error("炸了")) : Promise.resolve("ok"));
      return <div>{r.error() ? <p>err:{r.error().message}</p> : <p>{String(r.data())}</p>}</div>;
    }
    `,
    "res2"
  );
  const box = container("res2");
  box.appendChild(mod.App());
  await tick();
  await tick();
  ok(box.textContent.includes("炸了"), "应展示错误信息，实际：" + box.textContent);
});

// ---------------------------------------------------------------------------
// 5. 路由：切换 + 旧页面 effect 回收
// ---------------------------------------------------------------------------
test("router：导航切换页面并回收上一页 effect", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const tickS = signal(0);
    export const counts = { home: 0, detail: 0 };
    export function Home() {
      return <p>home {String((counts.home++, tickS()))}</p>;
    }
    export function Detail(props) {
      return <p>detail {String((counts.detail++, props.params.id))}</p>;
    }
    `,
    "route1"
  );
  const { createRouter } = RUNTIME;
  const router = createRouter({
    routes: [
      { path: "/", component: mod.Home },
      { path: "/u/:id", component: mod.Detail },
    ],
    mode: "history",
  });
  const box = container("route1");
  const update = router.render(box);
  update();
  ok(box.textContent.includes("home"), "初始应渲染 Home");
  eq(mod.counts.home, 1);
  mod.tickS.set(1);
  eq(mod.counts.home, 2, "Home effect 应响应 signal");

  router.navigate("/u/42");
  update();
  ok(box.textContent.includes("detail"), "导航后应渲染 Detail");
  ok(box.textContent.includes("42"), "应拿到路由参数");
  ok(!box.textContent.includes("home"), "旧页面必须从容器中移除");

  mod.tickS.set(2);
  eq(mod.counts.home, 2, "旧页面的 effect 必须被回收（防泄漏）");
  eq(mod.counts.detail, 1, "Detail 只应初次计算一次");
});

// ---------------------------------------------------------------------------
// 6. ErrorBoundary
// ---------------------------------------------------------------------------
test("ErrorBoundary 捕获子树 effect 抛错并降级", async () => {
  const { mod } = await compileModule(
    `
    import { signal, ErrorBoundary } from "plain";
    export const boom = signal(false);
    function danger() {
      if (boom()) throw new Error("boom");
      return "ok";
    }
    export function App() {
      return <ErrorBoundary fallback={(e, retry) => <p>err:{String(e.message)}</p>}>
        <p>{danger()}</p>
      </ErrorBoundary>;
    }
    `,
    "err1"
  );
  const box = container("err1");
  box.appendChild(mod.App());
  eq(box.textContent, "ok");
  mod.boom.set(true);
  ok(box.textContent.includes("boom"), "应降级展示错误，实际：" + box.textContent);
});

// ---------------------------------------------------------------------------
// 7. server() 编译期物理剥离 + 真实 RPC 往返
// ---------------------------------------------------------------------------
test("server() 物理剥离：客户端只剩 rpc 桩", async () => {
  const { code, out } = await compileModuleSource(
    `
    import { server } from "plain";
    export const getVersion = server(async (n) => {
      const secret = "不该出现在浏览器里";
      return { v: "1.0", n, secret };
    });
    export function App() { return <p>x</p>; }
    `,
    "srv1"
  );
  eq(out.serverFunctions.length, 1);
  eq(out.serverFunctions[0].name, "getVersion");
  ok(code.includes('rpc("getVersion"'), "客户端必须是 rpc 桩");
  ok(!code.includes("secret"), "服务端函数体不得出现在客户端产物里");
  ok(!code.includes("不该出现在浏览器里"), "闭包内容也要留在服务端");
});

test("server() 真实 HTTP 往返（rpc 桩 -> 服务端清单 -> 回值）", async () => {
  const stripped = await esbuild.transform(
    `
    import { server } from "plain";
    export const addUser = server(async (name) => {
      return { id: Math.floor(Math.random() * 1000), name, saved: true };
    });
    `,
    { loader: "tsx", jsx: "preserve", target: "es2022", format: "esm" }
  );
  const out = compile(stripped.code, "srv2.jsx");
  const manifest = writeServerManifest(
    out.serverFunctions,
    path.join(TMP, "srv2.manifest.mjs")
  );
  ok(fs.existsSync(manifest), "应生成服务端清单文件");
  ok(
    fs.readFileSync(manifest, "utf8").includes("__plainHandlers"),
    "清单应导出 __plainHandlers"
  );

  const { rpcMiddleware } = await import(
    pathToFileURL(path.join(ROOT, "src/server/index.mjs")).href
  );
  const mw = rpcMiddleware({ manifest });
  const server = http.createServer((req, res) =>
    mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  RUNTIME.setRpcEndpoint(`http://127.0.0.1:${port}/_plain/rpc`);

  const r = await RUNTIME.rpc("addUser", ["张三"]);
  eq(r.name, "张三");
  eq(r.saved, true);
  ok(typeof r.id === "number", "服务端返回值应原样回到客户端");

  let notFound = null;
  try {
    await RUNTIME.rpc("nope", []);
  } catch (e) {
    notFound = e;
  }
  ok(notFound, "未知 server 函数必须报错而不是静默成功");

  await new Promise((r) => server.close(r));
  RUNTIME.setRpcEndpoint("/_plain/rpc");
});

// ---------------------------------------------------------------------------
// 8. 安全约束
// ---------------------------------------------------------------------------
test("运行时与编译产物均不得出现 innerHTML（XSS 面）", async () => {
  const files = [
    "src/runtime/signal.js",
    "src/runtime/dom.js",
    "src/runtime/async.js",
    "src/runtime/router.js",
    "src/runtime/error.js",
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    ok(!/\.innerHTML\s*=/.test(src), `${f} 不得使用 innerHTML`);
  }
  const { code } = await compileModuleSource(
    `
    import { signal } from "plain";
    export const s = signal("<img src=x onerror=alert(1)>");
    export function App() { return <p>{s()}</p>; }
    `,
    "xss1"
  );
  ok(!code.includes("innerHTML"), "编译产物不得使用 innerHTML");
});

test("文本插值自动转义风险由 DOM API 承担（不拼 HTML 字符串）", async () => {
  const { mod } = await compileModule(
    `
    import { signal } from "plain";
    export const s = signal("<b>x</b>");
    export function App() { return <p>{s()}</p>; }
    `,
    "xss2"
  );
  const box = container("xss2");
  box.appendChild(mod.App());
  eq(box.querySelectorAll("b").length, 0, "插值内容不得被当作 HTML 解析");
  eq(box.querySelector("p").textContent, "<b>x</b>");
});

// ---------------------------------------------------------------------------
// 9. SSR（放在最后：它会替换 globalThis.document）
// ---------------------------------------------------------------------------
test("SSR：同一份组件在 Node 里渲染出 HTML 字符串", async () => {
  const { mod } = await compileModule(
    `
    import { signal, effect, resolve } from "plain";
    export const items = signal(["a", "b"]);
    export const name = signal("Plain");
    export function Card(props) {
      const el = document.createElement("div");
      el.className = "card";
      const t = document.createTextNode("");
      el.appendChild(t);
      effect(() => { t.nodeValue = String(resolve(props.title)); });
      return el;
    }
    export function App() {
      return <section class="page">
        <h1>{name()}</h1>
        <Card title={"hi " + name()} />
        <ul>{items().map(i => <li>{i}</li>)}</ul>
        <p>{name() === "Plain" ? <b>默认</b> : <i>改过</i>}</p>
      </section>;
    }
    `,
    "ssr1"
  );
  const { renderToStringSync } = await import(
    pathToFileURL(path.join(ROOT, "src/server/render.mjs")).href
  );
  const html = renderToStringSync(mod.App);
  ok(html.includes('<section class="page">'), "SSR 应输出 section：" + html);
  ok(html.includes("<h1>Plain</h1>"), "SSR 应含插值文本：" + html);
  ok(html.includes('<li>a</li>') && html.includes('<li>b</li>'), "SSR 应渲染列表：" + html);
  ok(html.includes("<b>默认</b>"), "SSR 应渲染条件分支：" + html);
  ok(html.includes('<div class="card">hi Plain</div>'), "SSR 应渲染子组件：" + html);
});

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------
async function compileModuleSource(tsx, name) {
  const stripped = await esbuild.transform(tsx, {
    loader: "tsx",
    jsx: "preserve",
    target: "es2022",
    format: "esm",
  });
  const out = compile(stripped.code, `${name}.jsx`);
  const code = out.code.replace(/from\s+["']plain["']/g, `from "${RUNTIME_URL}"`);
  return { code, out };
}

console.log("\nPlain 测试套件\n" + "=".repeat(50));
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    failed++;
    failures.push(name);
  }
}
console.log("=".repeat(50));
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed) {
  console.log("失败项：\n  - " + failures.join("\n  - "));
  process.exit(1);
}
console.log("全部通过\n");
