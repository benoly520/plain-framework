// SSR 数据预取：服务端直调 + 确定性等待（阶段一）+ 并发隔离（阶段零）
//
// 覆盖 docs/rfcs/ssr-data.md 的验收标准：
//   [x] SSR 首屏就是真实数据（不依赖猜出来的固定毫秒）          §3.2
//   [x] 等静默：settle 后新建的 resource 由下一轮接住（串联两层） §3.2
//   [x] SSR 期间 server() **直调**，一次 HTTP 都不发（fetch 被打桩成会抛错） §3.1
//   [x] 没注入 handlers 却调 server() -> 明确报错，不静默走网络    §3.1
//   [x] 资源 reject 不炸 SSR（allSettled），错误落在 error 态      §3.2
//   [x] 并发渲染：数据不串、handlers 不互相借用、结束后不残留垫片/上下文 §3.4

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";
import {
  renderToString,
  renderToStringSync,
  renderToStringWithData,
} from "../dist/server/render.js";
import { hydrate } from "../dist/runtime/index.js";
import { getSSRStore } from "../dist/runtime/ssr-context.js";
import { ssrMiddleware, SSR_SLOT, DATA_SLOT } from "../dist/server/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_URL = pathToFileURL(path.join(ROOT, "dist/runtime/index.js")).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ssr-"));

/**
 * 编译一个模块（去 TS 类型 → plain 编译 → 改写 import 到 dist 运行时），
 * 同时把编译器剥出来的 server 函数体求值成 handler 表（等价 `.plain/server.mjs`）。
 */
let seq = 0;
async function loadModule(tsx, name) {
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
  const handlers = {};
  for (const fn of out.serverFunctions) {
    // eslint-disable-next-line no-new-func
    handlers[fn.name] = new Function(`return (${fn.body});`)();
  }
  return { mod, handlers, code, serverFunctions: out.serverFunctions };
}

/** 断言 SSR 期间**一次 fetch 都没发** —— 直调走的是同进程 handler */
async function forbidFetch(fn) {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called++;
    throw new Error("SSR 期间不应该走 HTTP");
  };
  try {
    const result = await fn();
    assert.equal(called, 0, "SSR 期间不应发起 fetch");
    return result;
  } finally {
    globalThis.fetch = orig;
  }
}

/**
 * 去掉注水认领锚点注释（`plain-` 前缀的注释是**故意**输出给 hydrate 定位用的，
 * 见 dom-shim），只留可见内容 —— 让断言读起来就是「用户看到什么」。
 */
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

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
  return Promise.resolve()
    .then(() => fn(dom))
    .finally(() => {
      Object.assign(globalThis, saved);
    });
}

/** 把「SSR HTML + 数据载荷」拼成一个页面（等价 ssrMiddleware 要做的事） */
const pageOf = (html, data) =>
  `<div id="app">${html}</div>` +
  `<script type="application/json" id="plain-data">${JSON.stringify(data)}</script>`;

test("SSR 首屏就是真实数据：server() 直调 + 等静默", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const getStats = server(async () => ({ users: 7, online: 3 }));
    export function App() {
      const s = resource(() => getStats());
      return <p>{s.loading() ? "加载中" : "users=" + s.data().users}</p>;
    }
    `,
    "ssr1"
  );

  const html = await forbidFetch(() =>
    renderToString(mod.App, { handlers, container: false })
  );
  assert.equal(visible(html), "<p>users=7</p>", "首屏应是真实数据，而不是骨架屏");
  assert.ok(!html.includes("加载中"), "不该留下骨架屏文案");
});

test("等静默：settle 后新建的 resource 由下一轮接住（串联两层）", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const step1 = server(async () => ({ id: 41 }));
    const step2 = server(async (id) => ({ name: "item-" + id }));
    export function App() {
      const a = resource(() => step1());
      const b = resource(() => (a.data() ? step2(a.data().id) : null));
      return <p>{b.data() ? b.data().name : "还没好"}</p>;
    }
    `,
    "ssr2"
  );

  const html = await forbidFetch(() =>
    renderToString(mod.App, { handlers, container: false })
  );
  assert.equal(visible(html), "<p>item-41</p>", "第二层也应被等到（固定毫秒等不到这个）");
  assert.ok(!html.includes("还没好"), "不该停在第一层的占位文案");
});

test("SSR 里调 server() 但没注入 handlers：明确报错，不静默走网络", async () => {
  const { mod } = await loadModule(
    `
    import { resource, server } from "plain";
    const ping = server(async () => "pong");
    export function App() {
      const r = resource(() => ping());
      return <p>{r.error() ? "ERR:" + r.error().message : "ok"}</p>;
    }
    `,
    "ssr3"
  );

  const html = await forbidFetch(() =>
    renderToString(mod.App, { container: false })
  );
  assert.match(html, /没有注入 handlers/, "应给出可操作的指引，而不是静默去 fetch 自己");
});

test("资源 reject 不炸 SSR：错误落在 error 态，其余照常渲染", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const boom = server(async () => { throw new Error("服务端炸了"); });
    export function App() {
      const r = resource(() => boom());
      return <div><h1>标题</h1><p>{r.error() ? "降级：" + r.error().message : "正常"}</p></div>;
    }
    `,
    "ssr4"
  );

  const html = await renderToString(mod.App, { handlers, container: false });
  assert.equal(visible(html), "<div><h1>标题</h1><p>降级：服务端炸了</p></div>");
});

test("renderToStringSync 也在 SSR 上下文里：不发起 fetch，异步资源停在 loading", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const getUser = server(async () => ({ name: "ada" }));
    export function App() {
      const u = resource(() => getUser());
      return <p>{u.loading() ? "加载中" : u.data().name}</p>;
    }
    `,
    "ssr5"
  );

  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called++;
    throw new Error("SSR 期间不应该走 HTTP");
  };
  let html;
  try {
    html = renderToStringSync(mod.App, { handlers });
    await new Promise((r) => setTimeout(r, 0)); // 给 rejection 落地的机会
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(called, 0, "同步版同样直调，不该 fetch");
  assert.equal(visible(html), "<p>加载中</p>", "同步版不等待：停在 loading 态（文档如此）");
});

// ---------------------------------------------------------------------------
// 并发隔离（RFC §3.4）：渲染过程里有 await，所以同进程并发渲染必须互不影响。
// 改造前这里是「换全局 document + LIFO 恢复」：先结束的那个请求会把全局还原掉，
// 后一个请求的后续 DOM 操作就落到 undefined / 别的垫片上（表现为渲染中途抛错）。
// ---------------------------------------------------------------------------

test("并发渲染互不串味：各自的数据只出现在自己的响应里", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const getUser = server(async (id) => {
      await new Promise((r) => setTimeout(r, 5));
      return { id, name: "user-" + id };
    });
    export function makeApp(id) {
      return function App() {
        const u = resource(() => getUser(id));
        return <p>{u.loading() ? "…" : u.data().name}</p>;
      };
    }
    `,
    "ssr6"
  );

  const [htmlA, htmlB] = await Promise.all([
    renderToString(mod.makeApp("A"), { handlers, container: false }),
    renderToString(mod.makeApp("B"), { handlers, container: false }),
  ]);

  assert.equal(visible(htmlA), "<p>user-A</p>", "A 的响应里只能是 A 的数据");
  assert.equal(visible(htmlB), "<p>user-B</p>", "B 的响应里只能是 B 的数据");
});

test("并发渲染的 handlers 互不可见：没注入的那个报错，而不是借用别人的", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const ping = server(async () => "pong");
    export function App() {
      const r = resource(() => ping());
      return <p>{r.error() ? "缺 handlers" : r.data()}</p>;
    }
    `,
    "ssr7"
  );

  const [okHtml, missingHtml] = await Promise.all([
    renderToString(mod.App, { handlers, container: false }),
    renderToString(mod.App, { container: false }),
  ]);

  assert.equal(visible(okHtml), "<p>pong</p>");
  assert.equal(
    visible(missingHtml),
    "<p>缺 handlers</p>",
    "不该借用另一个渲染的 handlers"
  );
});

test("资源永不静默时：等满上限显式告警，不静默少渲染数据", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { signal, effect, resource, server } from "plain";
    const tick = signal(0);
    const step = server(async (n) => {
      await new Promise((r) => setTimeout(r, 0));
      return n + 1;
    });
    export function App() {
      const r = resource(() => step(tick()));
      // 每拿到一个新值就再推进一次 -> 永远有新的 pending（模拟循环依赖）
      effect(() => {
        const v = r.data();
        if (v !== undefined && v < 100) tick.set(v);
      });
      return <p>{r.data() ?? "…"}</p>;
    }
    `,
    "ssr10"
  );

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await renderToString(mod.App, { handlers, container: false });
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnings.some((w) => w.includes("等满")),
    "等不到静默时必须显式告警（绝不静默少渲染）：" + JSON.stringify(warnings)
  );
});

test("渲染结束后：不残留废弃垫片，也不残留 SSR 上下文", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const slow = server(async () => { await new Promise((r) => setTimeout(r, 3)); return "ok"; });
    export function App() {
      const r = resource(() => slow());
      return <p>{r.loading() ? "…" : r.data()}</p>;
    }
    `,
    "ssr8"
  );

  await Promise.all([
    renderToString(mod.App, { handlers, container: false }),
    renderToString(mod.App, { handlers, container: false }),
  ]);

  const doc = globalThis.document;
  assert.ok(
    !doc || !doc.__plainShim,
    "全局 document 不该停在某个渲染的废弃垫片上"
  );
  assert.equal(getSSRStore(), null, "渲染结束后不该残留跨请求的上下文");
});

// ---------------------------------------------------------------------------
// 阶段二：首屏数据随 HTML 迁移
//   编译器注入调用点 key -> 服务端按创建序收集 -> 注水时种入（首帧与 HTML 一致）
// ---------------------------------------------------------------------------

test("编译器给每个 resource 注入调用点 key：可读、可复现、两端一致", async () => {
  const stripped = await esbuild.transform(
    `
    import { resource } from "plain";
    export function App() {
      const a = resource(() => 1);
      return <p>{a.data()}</p>;
    }
    `,
    { loader: "tsx", jsx: "preserve", target: "es2022", format: "esm" }
  );

  const one = compile(stripped.code, "App.jsx", { keyBase: "src/App.tsx" });
  assert.match(
    one.code,
    /"src\/App\.tsx:\d+#0"/,
    "key 应是「项目相对路径:行#序号」：" + one.code
  );

  const two = compile(stripped.code, "App.jsx", { keyBase: "src/App.tsx" });
  assert.equal(two.code, one.code, "同一份源码 + 同一个 keyBase -> 产物完全一致（两端才能配对）");

  const other = compile(stripped.code, "App.jsx", { keyBase: "src/Other.tsx" });
  assert.ok(!other.code.includes("src/App.tsx"), "换 keyBase，key 跟着换（不是写死的）");
});

test("服务端把每个 resource 的值按创建序收进载荷", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const a = server(async () => "A");
    const b = server(async () => "B");
    export function App() {
      const x = resource(() => a());
      const y = resource(() => b());
      return <p>{x.data() ?? "…"}{y.data() ?? "…"}</p>;
    }
    `,
    "ssr11"
  );

  const { html, data } = await renderToStringWithData(mod.App, {
    handlers,
    container: false,
  });
  assert.equal(visible(html), "<p>AB</p>");
  assert.equal(data.length, 2, "两个 resource 各占一条");
  assert.deepEqual(
    data.map((d) => d.value),
    ["A", "B"],
    "**按创建序**排列（不是 settle 序）"
  );
  assert.ok(
    data.every((d) => d.ok && /:\d+#\d+$/.test(d.key)),
    "每条都带调用点 key：" + JSON.stringify(data)
  );
});

test("注水：首帧就用服务端的值（0 告警、不闪 loading），随后 SWR 后台校验", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server } from "plain";
    const get = server(async () => "服务端值");
    export function App() {
      const r = resource(() => get());
      return <p>{r.loading() ? "LOADING" : r.data()}</p>;
    }
    `,
    "ssr12"
  );

  const { html, data } = await renderToStringWithData(mod.App, {
    handlers,
    container: false,
  });
  assert.equal(visible(html), "<p>服务端值</p>");

  await inDom(pageOf(html, data), async (dom) => {
    const container = dom.window.document.getElementById("app");
    const origFetch = globalThis.fetch;
    // 后台校验（SWR）会走 RPC：让它返回一个新值，用来证明「后台确实又取了一次」
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: "客户端校验值" }),
    });
    try {
      const res = hydrate(container, mod.App, { warn: false });
      assert.equal(
        visible(container.innerHTML),
        "<p>服务端值</p>",
        "首帧必须与服务端 HTML 一致（种入生效，而不是先渲染 LOADING）"
      );
      assert.equal(res.warnings.length, 0, "不该有注水告警：" + JSON.stringify(res.warnings));

      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      assert.match(
        container.textContent,
        /客户端校验值/,
        "后台校验应把新值写回（说明依赖收集没丢）"
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

test("同一个调用点的多个实例：按创建序配对（列表场景）", async () => {
  const { mod, handlers } = await loadModule(
    `
    import { resource, server, resolve } from "plain";
    const getRow = server(async (id) => "srv-" + id);
    function Row(props) {
      const r = resource(() => getRow(resolve(props.id)));
      return <li>{r.data() ?? "…"}</li>;
    }
    export function App() {
      return <ul>{[1, 2, 3].map((id) => <Row id={id} />)}</ul>;
    }
    `,
    "ssr13"
  );

  const { html, data } = await renderToStringWithData(mod.App, {
    handlers,
    container: false,
  });
  assert.equal(visible(html), "<ul><li>srv-1</li><li>srv-2</li><li>srv-3</li></ul>");
  assert.equal(data.length, 3, "3 个实例占 3 条");
  assert.equal(new Set(data.map((d) => d.key)).size, 1, "同一个调用点 -> 同一个 key");
  assert.deepEqual(
    data.map((d) => d.value),
    ["srv-1", "srv-2", "srv-3"],
    "实例之间按创建序，客户端才能一一对上"
  );

  await inDom(pageOf(html, data), async (dom) => {
    const container = dom.window.document.getElementById("app");
    const res = hydrate(container, mod.App, { warn: false });
    assert.equal(
      visible(container.innerHTML),
      "<ul><li>srv-1</li><li>srv-2</li><li>srv-3</li></ul>",
      "三个实例各自拿到自己那条（没串位）"
    );
    assert.equal(res.warnings.length, 0, "不该有注水告警：" + JSON.stringify(res.warnings));
  });
});

test("页面载荷坏掉时明确告警，而不是静默退化成全量请求", async () => {
  const { mod } = await loadModule(
    `
    import { resource } from "plain";
    export function App() {
      const r = resource(() => Promise.resolve("v"));
      return <p>{r.loading() ? "LOADING" : r.data()}</p>;
    }
    `,
    "ssr14"
  );

  const html = renderToStringSync(mod.App, { container: false });
  const page =
    `<div id="app">${html}</div>` +
    `<script type="application/json" id="plain-data">{这不是合法 JSON</script>`;

  await inDom(page, async (dom) => {
    const container = dom.window.document.getElementById("app");
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      hydrate(container, mod.App, { warn: true });
    } finally {
      console.warn = origWarn;
    }
    assert.ok(
      warnings.some((w) => w.includes("plain-data")),
      "应指出载荷坏了：" + JSON.stringify(warnings)
    );
  });
});

// ---------------------------------------------------------------------------
// 阶段三：ssrMiddleware —— 把「首屏有数据」接成一条链
//   模板占位符 -> renderToStringWithData(handlers, url) -> HTML + 载荷写进页面
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writes: [],
    writeCalled: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    write(chunk) {
      this.writeCalled = true;
      this.writes.push(chunk);
      this.body += chunk;
      return true;
    },
    flushHeaders() {
      this.flushed = true;
    },
    end(chunk) {
      if (chunk) {
        this.writes.push(chunk);
        this.body += chunk;
      }
      this._done();
    },
  };
  res.done = new Promise((r) => {
    res._done = r;
  });
  return res;
}

async function callSsr(mw, url, method = "GET") {
  const res = fakeRes();
  let nexted = false;
  mw({ method, url }, res, () => {
    nexted = true;
    res._done();
  });
  await res.done;
  return { res, nexted };
}

/**
 * 造一份临时「SSR 项目」：SSR 入口（真实编译产物）+ 服务端清单 + 页面模板。
 * 入口与客户端编译同一份源码 -> 调用点 key 天然一致（真实项目里靠 keyBase 保证）。
 */
async function makeSsr(template, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ssr-mw-"));
  const { code, serverFunctions } = await loadModule(
    `
    import { resource, server, createRouter } from "plain";
    const getTodo = server(async (id) => ({ id, text: "todo-" + id }));
    const getRaw = server(async () => ({ text: "</script><img src=x onerror=alert(1)>" }));
    function Detail(props) {
      const r = resource(() => getTodo(props.params.id));
      return <p>{r.data() ? r.data().text : "…"}</p>;
    }
    function Raw() {
      const r = resource(() => getRaw());
      return <p>{r.data() ? r.data().text : "…"}</p>;
    }
    function Home() { return <p>home</p>; }
    const router = createRouter({ routes: [
      { path: "/", component: Home },
      { path: "/raw", component: Raw },
      { path: "/todo/:id", component: Detail },
    ]});
    export function App() {
      const m = router.current();
      return <div>{m.route ? m.route.component({ params: m.params, path: m.path }) : null}</div>;
    }
    `,
    "ssr-mw"
  );
  fs.writeFileSync(path.join(dir, "entry-server.mjs"), code);
  fs.writeFileSync(
    path.join(dir, "server.mjs"),
    `export const __plainHandlers = { ${serverFunctions
      .map((f) => `${f.name}: ${f.body}`)
      .join(", ")} };`
  );
  fs.writeFileSync(
    path.join(dir, "index.html"),
    template ?? `<!doctype html><html><head>${DATA_SLOT}</head><body><div id="app">${SSR_SLOT}</div></body></html>`
  );
  return ssrMiddleware({
    template: path.join(dir, "index.html"),
    entry: path.join(dir, "entry-server.mjs"),
    manifest: path.join(dir, "server.mjs"),
    ...extra,
  });
}

test("ssrMiddleware：模板注入 + 首屏数据 + **按请求 URL 渲染对应路由**", async () => {
  const mw = await makeSsr();

  const home = await callSsr(mw, "/");
  assert.equal(home.res.statusCode, 200);
  assert.match(home.res.headers["content-type"], /text\/html/);
  assert.match(home.res.body, /<p>home<\/p>/);
  assert.match(home.res.body, /id="plain-data"/, "载荷要写进页面");

  // 关键：服务端没有 window，router 靠注入的请求 URL 才知道渲染哪一页
  const todo = await callSsr(mw, "/todo/7");
  assert.match(todo.res.body, /todo-7/, "应按请求 URL 渲染对应路由（否则 SSR 只有首页）");
  assert.match(
    todo.res.body,
    /"value":\{"id":"7","text":"todo-7"\}/,
    "载荷里应是这次请求的数据：" + todo.res.body
  );
  assert.ok(!todo.res.body.includes("home"), "不该把首页内容也渲染进去");
});

test("ssrMiddleware：载荷里的 </script> 会被转义（数据不能逃出 script 标签）", async () => {
  const mw = await makeSsr();
  const { res } = await callSsr(mw, "/raw");
  assert.ok(
    !res.body.includes("</script><img"),
    "数据里的 </script> 必须被转义，否则就是注入：" + res.body
  );
  assert.match(res.body, /\\u003c\/script>/, "应转义成 \\u003c");
});

test("ssrMiddleware：模板缺占位符 -> 500 并指明缺哪个（不静默出无数据的页面）", async () => {
  const mw = await makeSsr(`<!doctype html><div id="app">${SSR_SLOT}</div>`);
  const { res } = await callSsr(mw, "/");
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /plain-data/, "应点名缺的占位符：" + res.body);
});

test("ssrMiddleware：静态资源与非 GET 一律放行（交给后面的中间件）", async () => {
  const mw = await makeSsr();
  assert.equal((await callSsr(mw, "/assets/app.js")).nexted, true, "带扩展名 -> 放行");
  assert.equal((await callSsr(mw, "/", "POST")).nexted, true, "非 GET -> 放行");
});

test("ssrMiddleware：占位符出现两次 -> 报错（注入点不明确，绝不挑第一处）", async () => {
  // 真实踩过的坑：把占位符写进另一段注释里，于是 HTML 被插到了看不见的地方
  const template =
    `<!doctype html><html><head>${DATA_SLOT}` +
    `<!-- 说明里又写了一次 ${SSR_SLOT} --></head>` +
    `<body><div id="app">${SSR_SLOT}</div></body></html>`;
  const mw = await makeSsr(template);
  const { res } = await callSsr(mw, "/");
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /2 次/, "应说明出现了几次：" + res.body);
});

// ---------------------------------------------------------------------------
// 阶段三（续）：ssrMiddleware 的「按路由缓存」—— 命中直接回 HTML，省整页重渲染
// ---------------------------------------------------------------------------

/**
 * 造一个带「渲染计数」的 SSR 项目：App 每渲染一次，模块级计数器 +1 并写进 HTML。
 * 入口只 import 一次（ssrMiddleware 会缓存 import），计数跨请求累积 ——
 * 于是「第二次同 URL 请求 body == 第一次」就等于「没再渲染」（缓存命中）。
 * 另带一个 /boom 路由用于验证「渲染失败不进缓存」。
 */
async function makeCounterSsr(cache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plain-ssr-cache-"));
  const { code } = await loadModule(
    `
    import { createRouter } from "plain";
    let __renders = 0;
    function Home() { return <p>home</p>; }
    function Boom() { throw new Error("boom"); }
    const router = createRouter({ routes: [
      { path: "/", component: Home },
      { path: "/boom", component: Boom },
    ]});
    export function App() {
      __renders += 1;
      // 把渲染次数挂到 data-render 上：无论路由是否命中，每次渲染都可见（属性不会被锚点注释包住）
      const m = router.current();
      return <div data-render={__renders}>{m.route ? m.route.component({ params: m.params, path: m.path }) : null}</div>;
    }
    `,
    "ssr-cache"
  );
  fs.writeFileSync(path.join(dir, "entry-server.mjs"), code);
  fs.writeFileSync(path.join(dir, "server.mjs"), `export const __plainHandlers = {};`);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html><head>${DATA_SLOT}</head><body><div id="app">${SSR_SLOT}</div></body></html>`
  );
  return ssrMiddleware({
    template: path.join(dir, "index.html"),
    entry: path.join(dir, "entry-server.mjs"),
    manifest: path.join(dir, "server.mjs"),
    cache,
  });
}

/** 从渲染产物里取出 data-render 上的次数（属性不会被认领锚点注释包住） */
const rendersOf = (body) => {
  const m = body.match(/data-render="(\d+)"/);
  return m ? Number(m[1]) : null;
};

test("ssrMiddleware 缓存：默认关闭，每次请求都重渲染", async () => {
  const mw = await makeCounterSsr(undefined);
  const a = rendersOf((await callSsr(mw, "/")).res.body);
  const b = rendersOf((await callSsr(mw, "/")).res.body);
  assert.equal(a, 1, "没开缓存：第一次渲染 = 1");
  assert.equal(b, 2, "没开缓存：第二次应重新渲染 = 2");
});

test("ssrMiddleware 缓存：同 URL 命中直接回 HTML（不重渲染），不同 URL 独立", async () => {
  const mw = await makeCounterSsr({ ttl: 60_000 });
  const a = rendersOf((await callSsr(mw, "/")).res.body);
  const b = rendersOf((await callSsr(mw, "/")).res.body);
  assert.equal(a, 1, "第一次渲染 = 1");
  assert.equal(b, 1, "命中缓存应复用同一份渲染（仍是 1）");
  const c = rendersOf((await callSsr(mw, "/other")).res.body);
  assert.equal(c, 2, "不同 URL 不该串（独立计到 2）");
});

test("ssrMiddleware 缓存：并发同 URL 只渲染一次（防惊群）", async () => {
  const mw = await makeCounterSsr({ ttl: 60_000 });
  const [x, y] = await Promise.all([callSsr(mw, "/"), callSsr(mw, "/")]);
  assert.equal(rendersOf(x.res.body), 1, "并发应复用同一次渲染");
  assert.equal(rendersOf(y.res.body), 1, "并发应复用同一次渲染");
});

test("ssrMiddleware 缓存：TTL 过期后重新渲染", async () => {
  const mw = await makeCounterSsr({ ttl: 20 });
  assert.equal(rendersOf((await callSsr(mw, "/")).res.body), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(rendersOf((await callSsr(mw, "/")).res.body), 2, "过期后应重新渲染");
});

test("ssrMiddleware 缓存：超过 max 淘汰最旧项", async () => {
  const mw = await makeCounterSsr({ ttl: 60_000, max: 1 });
  assert.equal(rendersOf((await callSsr(mw, "/a")).res.body), 1); // 缓存 {/a}
  assert.equal(rendersOf((await callSsr(mw, "/b")).res.body), 2); // 淘汰 /a，缓存 {/b}
  assert.equal(rendersOf((await callSsr(mw, "/a")).res.body), 3, "被淘汰的 URL 应重新渲染");
});

test("ssrMiddleware 缓存：渲染失败（500）不进缓存、也不污染其它命中", async () => {
  const mw = await makeCounterSsr({ ttl: 60_000 });
  assert.equal(rendersOf((await callSsr(mw, "/")).res.body), 1); // 正常并缓存
  const boom = await callSsr(mw, "/boom");
  assert.equal(boom.res.statusCode, 500, "错误路由应 500");
  assert.equal(rendersOf((await callSsr(mw, "/")).res.body), 1, "成功的缓存不应被失败请求污染");
});

// ---------------------------------------------------------------------------
// 阶段三（续二）：ssrMiddleware 的「分块流式输出」—— 壳先 flush 抢首字节
// ---------------------------------------------------------------------------

test("ssrMiddleware 流式：分块写出（壳先 flush），最终字节与非流式完全一致", async () => {
  const streamMw = await makeSsr(undefined, { stream: true });
  const plainMw = await makeSsr(); // 对照组：非流式

  const streamRes = (await callSsr(streamMw, "/")).res;
  const plainRes = (await callSsr(plainMw, "/")).res;

  // 流式：用 write 拆成多块（壳 + 内容），并告诉反代别缓冲整页
  assert.ok(streamRes.writeCalled, "流式应走 write 拆块");
  assert.ok(streamRes.writes.length >= 2, "流式应分块写出：" + JSON.stringify(streamRes.writes.length));
  assert.equal(streamRes.headers["x-accel-buffering"], "no", "应关掉反代缓冲");
  // 拼回去的字节要跟非流式一模一样 —— 客户端注水逻辑不受流式影响
  assert.equal(streamRes.body, plainRes.body, "流式最终字节应等于非流式");
});

test("ssrMiddleware 流式：首块是「第一个占位符之前」的壳（不含应用 HTML / 载荷）", async () => {
  const streamMw = await makeSsr(undefined, { stream: true });
  const { res } = await callSsr(streamMw, "/");
  const shell = res.writes[0];
  assert.ok(shell.includes("<head>"), "壳应含 head");
  assert.ok(!shell.includes("plain-data"), "壳里不该有载荷（它在后面才写）");
  assert.ok(!shell.includes("<p>home</p>"), "壳里不该有应用 HTML");
});

test("ssrMiddleware 流式：按请求 URL 渲染 + 载荷仍随 HTML 迁移（内容正确）", async () => {
  const streamMw = await makeSsr(undefined, { stream: true });
  const { res } = await callSsr(streamMw, "/todo/7");
  assert.match(res.body, /todo-7/, "应按 URL 渲染对应路由");
  assert.match(res.body, /id="plain-data"/, "载荷仍要写进页面");
});

test("ssrMiddleware 流式：默认（非流式）走 end 不拆块", async () => {
  const plainMw = await makeSsr();
  const { res } = await callSsr(plainMw, "/");
  assert.equal(res.writeCalled, false, "非流式不应走 write 拆块");
  assert.match(res.body, /<p>home<\/p>/, "内容仍正确");
});

