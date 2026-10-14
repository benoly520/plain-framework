// SSR 数据预取（阶段一）：服务端直调 + 确定性等待
//
// 覆盖 docs/rfcs/ssr-data.md §3.1 / §3.2 的验收标准：
//   [x] SSR 首屏就是真实数据（不依赖猜出来的固定毫秒）
//   [x] 等静默：settle 后新建的 resource 由下一轮接住（串联两层也能等到）
//   [x] SSR 期间 server() **直调**，一次 HTTP 都不发（fetch 被打桩成会抛错）
//   [x] 没注入 handlers 却调 server() -> 明确报错，不静默走网络
//   [x] 资源 reject 不炸 SSR（allSettled），错误落在 error 态

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { compile } from "../dist/compiler/index.js";
import { renderToString, renderToStringSync } from "../dist/server/render.js";

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
  return { mod, handlers };
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
