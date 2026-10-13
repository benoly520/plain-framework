// vite/index.ts 单测：transform 编译与 server 物理剥离 / 清单增量与全量写出 / dev RPC 中间件
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import plugin from "../dist/vite/index.js";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "plain-vite-"));
const manifestOf = (root) => path.join(root, ".plain", "server.mjs");

/** 造一个能满足中间件签名的最小 req/res */
function fakeResponse() {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(body) {
      this.body = body;
      if (this._resolve) this._resolve();
    },
  };
  res.done = new Promise((r) => {
    res._resolve = r;
  });
  return res;
}

async function callRpc(handler, { method = "POST", payload } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = "/_plain/rpc";
  const res = fakeResponse();
  handler(req, res, () => {
    res.nextCalled = true;
    if (res._resolve) res._resolve();
  });
  if (method === "POST" && payload !== undefined) {
    req.emit("data", Buffer.from(JSON.stringify(payload)));
  }
  req.emit("end");
  await res.done;
  return res;
}

/** 捕获 configureServer 注册的中间件 */
function captureMiddleware(p) {
  const used = [];
  const fakeServer = { middlewares: { use: (p0, h) => used.push([p0, h]) } };
  const installer = p.configureServer(fakeServer);
  if (typeof installer === "function") installer();
  return used;
}

test("插件元信息：name / enforce", () => {
  const p = plugin();
  assert.equal(p.name, "plain");
  assert.equal(p.enforce, "pre");
});

test("transform 只处理 tsx/jsx，跳过 node_modules", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  assert.equal(await p.transform("body{}", path.join(root, "a.css")), null);
  assert.equal(
    await p.transform("x", path.join(root, "node_modules", "lib", "a.tsx")),
    null
  );
});

test("transform 产出无 JSX 的代码，并把 server() 剥离成 rpc 桩", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });

  const code = [
    "import { signal, server } from 'plain';",
    "export const count = signal(0);",
    "export const getSecret = server(async () => 's3cr3t');",
    "export function App(){ return <p>{count()}</p>; }",
  ].join("\n");

  const id = path.join(root, "App.tsx");
  const res = await p.transform(code, id);
  assert.ok(res && typeof res.code === "string");
  assert.ok(!res.code.includes("<p>"), "产物里不得残留 JSX");
  assert.ok(res.map && res.map.version === 3, "应回传 sourcemap");
  assert.deepEqual(res.map.sources, [id], "sources 应是真实模块路径");
  assert.ok(res.code.includes('rpc("getSecret"'));
  assert.ok(!res.code.includes("s3cr3t"), "服务端函数体不得留在客户端产物");

  const manifest = manifestOf(root);
  assert.ok(fs.existsSync(manifest), "应增量写出服务端清单");
  assert.ok(fs.readFileSync(manifest, "utf8").includes("__plainHandlers"));
});

test("[回归] 多次增量 transform 后，清单仍是可被 Node 导入的合法模块", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  await p.transform("export const a = server(() => 1);", path.join(root, "a.tsx"));
  await p.transform("export const b = server(() => 2);", path.join(root, "b.tsx"));

  // dev 语义：不经过 buildEnd，增量清单本身就必须可用
  // （曾经会把 __plainHandlers 当成条目再写一遍，产出重复 const 声明）
  const manifest = manifestOf(root);
  const devMod = await import(pathToFileURL(manifest).href + `?t=dev${Date.now()}`);
  assert.deepEqual(Object.keys(devMod.__plainHandlers).sort(), ["a", "b"]);

  p.buildEnd();
  const prodMod = await import(pathToFileURL(manifest).href + `?t=prod${Date.now()}`);
  assert.deepEqual(Object.keys(prodMod.__plainHandlers).sort(), ["a", "b"]);
  assert.equal(await prodMod.handle("a"), 1);
});

test("多入口：不同模块的同名 server() 函数必须报冲突，而不是静默覆盖", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  // 两个入口各自定义了同名的 load() —— 单文件清单下会互相覆盖
  await p.transform("export const load = server(() => 'A');", path.join(root, "a.tsx"));
  await assert.rejects(
    () =>
      p.transform("export const load = server(() => 'B');", path.join(root, "b.tsx")),
    (err) => {
      assert.match(err.message, /server\(\) 函数名冲突/);
      assert.match(err.message, /"load"/);
      // 必须把两个来源文件都点出来，作者才知道改哪个
      assert.match(err.message, /a\.tsx/);
      assert.match(err.message, /b\.tsx/);
      return true;
    },
    "跨文件同名应抛错"
  );
});

test("多入口：不同名 server() 函数各自保留，互不覆盖", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  await p.transform("export const loadA = server(() => 'A');", path.join(root, "a.tsx"));
  await p.transform("export const loadB = server(() => 'B');", path.join(root, "b.tsx"));
  p.buildEnd();

  const mod = await import(
    pathToFileURL(manifestOf(root)).href + `?t=multi${Date.now()}`
  );
  assert.deepEqual(Object.keys(mod.__plainHandlers).sort(), ["loadA", "loadB"]);
  assert.equal(await mod.handle("loadA"), "A");
  assert.equal(await mod.handle("loadB"), "B");
});

test("同一文件重新 transform（HMR）不算冲突：函数体被更新为最新版本", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  const f = path.join(root, "s.tsx");
  await p.transform("export const load = server(() => 1);", f);
  // 同文件改动：应替换而非报冲突
  await p.transform("export const load = server(() => 2);", f);
  p.buildEnd();

  const mod = await import(
    pathToFileURL(manifestOf(root)).href + `?t=hmrc${Date.now()}`
  );
  assert.deepEqual(Object.keys(mod.__plainHandlers), ["load"]);
  assert.equal(await mod.handle("load"), 2, "同文件热更新应替换函数体");
});

test("buildEnd 在没有 server 函数时不产生清单", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  p.buildEnd();
  assert.ok(!fs.existsSync(manifestOf(root)));
});

test("build 模式不求值函数体（清单只要文本，构建期不执行 new Function）", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  // 函数体里有只有在服务端运行时才该发生的副作用 —— build 不应触发它。
  // 通过 globalThis 打点验证：build（无 watchMode）下 transform 不该执行函数体。
  globalThis.__plainBuildSideEffect = 0;
  await p.transform(
    "export const probe = server(() => { globalThis.__plainBuildSideEffect++; return 1; });",
    path.join(root, "s.tsx")
  );
  assert.equal(
    globalThis.__plainBuildSideEffect,
    0,
    "build 阶段不应求值 server 函数体"
  );
  p.buildEnd();
  // 清单里仍要有函数体文本（构建产物照常）
  const src = fs.readFileSync(manifestOf(root), "utf8");
  assert.match(src, /export const probe =/);
  assert.match(src, /__plainBuildSideEffect/);
  delete globalThis.__plainBuildSideEffect;
});

test("configureServer 注册 /_plain/rpc，POST 调用服务端函数成功", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  await p.transform("export const echo = server((x) => x);", path.join(root, "s.tsx"));

  const used = captureMiddleware(p);
  assert.equal(used.length, 1);
  assert.equal(used[0][0], "/_plain/rpc");
  const handler = used[0][1];

  const ok = await callRpc(handler, { payload: { name: "echo", args: ["hi"] } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["content-type"], "application/json");
  assert.equal(JSON.parse(ok.body).result, "hi");
});

test("dev RPC：未知函数 404，非 POST 405，函数抛错 500", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  await p.transform(
    "export const boom = server(() => { throw new Error('炸了'); });",
    path.join(root, "s.tsx")
  );
  const handler = captureMiddleware(p)[0][1];

  const missing = await callRpc(handler, { payload: { name: "nope", args: [] } });
  assert.equal(missing.statusCode, 404);
  assert.match(JSON.parse(missing.body).error, /unknown server fn/);

  const get = await callRpc(handler, { method: "GET" });
  assert.equal(get.statusCode, 405);

  const boom = await callRpc(handler, { payload: { name: "boom", args: [] } });
  assert.equal(boom.statusCode, 500);
  assert.match(JSON.parse(boom.body).error, /炸了/);
});

test("rpc: false 时不注册中间件", () => {
  const p = plugin({ rpc: false });
  p.configResolved({ root: tmpRoot() });
  assert.equal(p.configureServer({ middlewares: { use() {} } }), undefined);
});

// ---------------------------------------------------------------------------
// 契约检查接进构建链路（默认开启）
// ---------------------------------------------------------------------------

const LINT_BAD = [
  "import { signal } from 'plain';",
  "const count = signal(0);",
  "count = 1;",
  "export function App(){ return <p>{count}</p>; }",
].join("\n");

test("[免疫系统] 默认让构建失败：AI 的典型错误在编译前就被拦下", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });

  await assert.rejects(
    () => p.transform(LINT_BAD, path.join(root, "Bad.tsx")),
    (e) => {
      assert.equal(e.code, "PLAIN_E2001", "应抛结构化编译错误");
      assert.match(e.detail, /PLAIN_E1101/);
      assert.match(e.detail, /PLAIN_E1102/);
      assert.match(e.hint, /plaindev check --fix/);
      return true;
    }
  );
});

test("lint: 'warn' 只告警不阻断；lint: false 完全关闭", async () => {
  const root = tmpRoot();
  const id = path.join(root, "Bad.tsx");

  const warned = [];
  const pw = plugin({ lint: "warn" });
  pw.configResolved({ root });
  const res = await pw.transform.call({ warn: (m) => warned.push(m) }, LINT_BAD, id);
  assert.ok(res && typeof res.code === "string", "warn 模式仍应产出代码");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /PLAIN_E1101/);

  const pf = plugin({ lint: false });
  pf.configResolved({ root });
  const res2 = await pf.transform(LINT_BAD, id);
  assert.ok(res2 && typeof res2.code === "string");
  assert.ok(
    res2.code.includes("count = 1;"),
    "关闭 lint 后错误写法应原样通过（说明确实是 lint 在拦）"
  );
});

test("通过契约检查的模块不受影响", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  const good = [
    "import { signal } from 'plain';",
    "export const n = signal(0);",
    "export function App(){ return <p>{n()}</p>; }",
  ].join("\n");
  const res = await p.transform(good, path.join(root, "Good.tsx"));
  assert.ok(res && typeof res.code === "string");
});

// ---------------------------------------------------------------------------
// HMR 注入（M4-2）：仅 dev（watchMode）注入，prod 构建不注入
// ---------------------------------------------------------------------------
test("dev(watchMode) 下注入 HMR 头尾；prod 构建不注入", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  const code = [
    "import { signal } from 'plain';",
    "export const n = signal(0);",
    "export function App(){ return <p>{n()}</p>; }",
  ].join("\n");
  const id = path.join(root, "Hmr.tsx");

  // dev：this.meta.watchMode = true
  const dev = await p.transform.call({ meta: { watchMode: true } }, code, id);
  assert.ok(dev && typeof dev.code === "string");
  assert.match(dev.code, /__plainBegin\(/, "dev 应注入模块标记");
  assert.match(dev.code, /import\.meta\.hot\.accept\(/, "dev 应注入 accept 回调");
  assert.match(dev.code, /hmrApply/, "dev 应引入 hmrApply");
  assert.ok(
    dev.code.includes(JSON.stringify(id)),
    "注入的模块 id 应为文件路径"
  );

  // prod：无 watchMode
  const prod = await p.transform(code, id);
  assert.ok(prod && typeof prod.code === "string");
  assert.ok(!prod.code.includes("__plainBegin("), "prod 不应注入 HMR 代码");
  assert.ok(!prod.code.includes("import.meta.hot"), "prod 不应引用 import.meta.hot");
});

test("hmr:false 关闭 HMR 注入", async () => {
  const root = tmpRoot();
  const p = plugin({ hmr: false });
  p.configResolved({ root });
  const code = "export function App(){ return <p>hi</p>; }";
  const id = path.join(root, "NoHmr.tsx");
  const res = await p.transform.call({ meta: { watchMode: true } }, code, id);
  assert.ok(res && typeof res.code === "string");
  assert.ok(!res.code.includes("__plainBegin("), "关闭后不应注入");
});

test("handleHotUpdate：命中 Plain 模块时不强制整页刷新", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  // 我们的实现返回 undefined => 交给 vite 默认 HMR 管道（走 accept，不 full-reload）
  const r = p.handleHotUpdate({ file: path.join(root, "App.tsx") });
  assert.equal(r, undefined);
  // 非 Plain 文件同样不特殊处理
  const r2 = p.handleHotUpdate({ file: path.join(root, "style.css") });
  assert.equal(r2, undefined);
});
