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

  const res = await p.transform(code, path.join(root, "App.tsx"));
  assert.ok(res && typeof res.code === "string");
  assert.ok(!res.code.includes("<p>"), "产物里不得残留 JSX");
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

test("buildEnd 在没有 server 函数时不产生清单", async () => {
  const root = tmpRoot();
  const p = plugin();
  p.configResolved({ root });
  p.buildEnd();
  assert.ok(!fs.existsSync(manifestOf(root)));
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
